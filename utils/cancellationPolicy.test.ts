import { describe, it, expect } from "vitest";
import {
  parseBookingComPolicy,
  parseAirbnbPolicy,
  deriveCancellationPolicy,
  freeCancelDaysLeft,
  cancellationTone,
  cancellationShortLabel,
  bookingGraceStatus,
  HOUSE_FREE_CANCEL_DAYS,
} from "./cancellationPolicy";

/**
 * Every Booking.com fixture below is a VERBATIM clause from live Baker House
 * bookings (Beds24 cache, 2026-08-21) — all six distinct phrasings found across
 * 339 cached Booking.com reservations. If a channel changes wording these tests
 * are the tripwire.
 */
const wrap = (clause: string) =>
  `Room: Apartmán Deluxe s jednou ložnicí\nThis apartment comes with 1 living room.\n\n` +
  `V ceně pokoje není zahrnuto stravování. Podmínky pro ubytování dětí a přistýlky: ` +
  `Ubytovat se mohou děti jakéhokoli věku.  Podmínky placení zálohy: Kdykoli po vytvoření ` +
  `rezervace bude hostovi účtována platba předem ve výši 100 % celkové ceny.  ` +
  `Podmínky zrušení rezervace: ${clause}\n\nMeal Plan: V ceně pokoje není zahrnuto stravování.\n\n` +
  `Room Rservation Id: 6202188282`;

const NON_REFUNDABLE = "V případě zrušení kdykoli po vytvoření rezervace host zaplatí 100 % celkové ceny.";
const FREE_7_THEN_50 =
  "Host může zrušit rezervaci zdarma do 7 dní před příjezdem. V případě zrušení méně než 7 dní před příjezdem host zaplatí 50 % z celkové ceny.";
const FREE_14_THEN_50 =
  "Host může zrušit rezervaci zdarma do 14 dní před příjezdem. V případě zrušení méně než 14 dní před příjezdem host zaplatí 50 % z celkové ceny. Pokud se host k pobytu nedostaví, bude mu účtováno 100 % celkové ceny.";
const FREE_3_THEN_100 =
  "Host může zrušit rezervaci zdarma do 3 dnů před příjezdem. V případě zrušení méně než 3 dny před příjezdem host zaplatí 100 % celkové ceny.";
const FREE_2_THEN_100 =
  "Host může zrušit rezervaci zdarma do 2 dnů před příjezdem. V případě zrušení méně než 2 dny před příjezdem host zaplatí 100 % celkové ceny.";
const FREE_1_THEN_100 =
  "Host může zrušit rezervaci zdarma do 1 dne před příjezdem. V případě zrušení 1 den před příjezdem host zaplatí 100 % celkové ceny.";

describe("parseBookingComPolicy", () => {
  it("reads a non-refundable clause as a zero-day window", () => {
    const p = parseBookingComPolicy(wrap(NON_REFUNDABLE))!;
    expect(p.kind).toBe("non-refundable");
    expect(p.freeDays).toBe(0);
    expect(p.penaltyPercent).toBe(100);
    expect(p.source).toBe("Booking.com");
  });

  // The declension cases: Czech writes 1 dne / 2 dny / 3 dnů / 7 dní, so the
  // unit must not be matched literally.
  it.each([
    [FREE_1_THEN_100, 1, 100],
    [FREE_2_THEN_100, 2, 100],
    [FREE_3_THEN_100, 3, 100],
    [FREE_7_THEN_50, 7, 50],
    [FREE_14_THEN_50, 14, 50],
  ])("reads free window + penalty from %#", (clause, days, penalty) => {
    const p = parseBookingComPolicy(wrap(clause))!;
    expect(p.kind).toBe("free-window");
    expect(p.freeDays).toBe(days);
    expect(p.penaltyPercent).toBe(penalty);
  });

  it("keeps the raw clause so the operator can verify the channel's own wording", () => {
    expect(parseBookingComPolicy(wrap(FREE_7_THEN_50))!.sourceText).toBe(FREE_7_THEN_50);
  });

  it("does not swallow the neighbouring prepayment clause, which also says 100 %", () => {
    // "Podmínky placení zálohy: … platba předem ve výši 100 % celkové ceny"
    // sits directly before the cancellation clause. Reading it as the penalty
    // would report a 7-day/100 % policy as 7-day/100 % by accident.
    const p = parseBookingComPolicy(wrap(FREE_7_THEN_50))!;
    expect(p.penaltyPercent).toBe(50);
    expect(p.sourceText).not.toContain("platba předem");
  });

  it("returns null when Beds24 replaced apiMessage on cancellation", () => {
    // Real shape of a cancelled booking's apiMessage.
    expect(parseBookingComPolicy("\ncommissionamount=0\npaymentcharge=0\ncurrencycode=CZK\ntotalprice=0")).toBeNull();
  });

  it("returns null for missing or empty input", () => {
    expect(parseBookingComPolicy(null)).toBeNull();
    expect(parseBookingComPolicy("")).toBeNull();
  });

  it("also handles an English clause, in case the property language changes", () => {
    const p = parseBookingComPolicy(
      "Cancellation policy: Guest can cancel free of charge until 7 days before arrival. Guest will pay 50 % of the total price.",
    )!;
    expect(p.freeDays).toBe(7);
    expect(p.penaltyPercent).toBe(50);
  });

  it("surfaces an unrecognised clause as unknown WITH its text rather than guessing", () => {
    const p = parseBookingComPolicy("Podmínky zrušení rezervace: Nějaká úplně nová formulace.")!;
    expect(p.kind).toBe("unknown");
    expect(p.freeDays).toBeNull();
    expect(p.sourceText).toBe("Nějaká úplně nová formulace.");
  });
});

describe("parseAirbnbPolicy", () => {
  it("reads the moderate policy as Airbnb's 5-day cutoff (not Booking.com's 7)", () => {
    const p = parseAirbnbPolicy("Cancel policy moderate\nBase Price 10127.2 CZK\nHost Fee -1899.36 CZK\n")!;
    expect(p.kind).toBe("free-window");
    expect(p.freeDays).toBe(5);
    expect(p.source).toBe("Airbnb");
  });

  it("reads tiered_pricing_non_refundable as non-refundable", () => {
    const p = parseAirbnbPolicy("Cancel policy tiered_pricing_non_refundable\nBase Price 8903.06 CZK\n")!;
    expect(p.kind).toBe("non-refundable");
    expect(p.freeDays).toBe(0);
  });

  it("uses Airbnb's own cutoffs for the policies not currently in use", () => {
    expect(parseAirbnbPolicy("Cancel policy flexible")!.freeDays).toBe(1);
    expect(parseAirbnbPolicy("Cancel policy limited")!.freeDays).toBe(14);
    expect(parseAirbnbPolicy("Cancel policy firm")!.freeDays).toBe(30);
  });

  it("treats strict as locked from the start — it has no days-before-check-in window", () => {
    const p = parseAirbnbPolicy("Cancel policy strict")!;
    expect(p.kind).toBe("non-refundable");
    expect(p.penaltyNote).toMatch(/24 h post-booking/);
  });

  it("states that a non-refundable cancellation costs the host nothing", () => {
    // Baker House takes no cleaning fee and no tax through Airbnb (checked
    // across all 34 cached Airbnb bookings), so the payout is kept in full —
    // the guest-side tax and service-fee carve-outs never touch it.
    const p = parseAirbnbPolicy("Cancel policy tiered_pricing_non_refundable")!;
    expect(p.penaltyNote).toMatch(/keeps the entire payout/);
  });

  // Airbnb switches to its long-term rules at 28 nights. The cutoff for Firm is
  // 30 days either way, so the countdown must NOT change — only the wording.
  it("keeps Firm's 30-day cutoff but uses the long-term wording for 28+ nights", () => {
    const short = parseAirbnbPolicy("Cancel policy firm", { nights: 7 })!;
    const long = parseAirbnbPolicy("Cancel policy firm", { nights: 30 })!;
    expect(short.freeDays).toBe(30);
    expect(long.freeDays).toBe(30);
    expect(short.penaltyNote).toMatch(/50 % refund/);
    expect(long.penaltyNote).toMatch(/plus the next 30 nights/);
  });

  it("uses the long-term wording for Strict on a 28+ night stay", () => {
    expect(parseAirbnbPolicy("Cancel policy strict", { nights: 28 })!.penaltyNote)
      .toMatch(/at least 28 days before check-in/);
  });

  it("treats 27 nights as a short stay — the threshold is 28, not 'about a month'", () => {
    expect(parseAirbnbPolicy("Cancel policy firm", { nights: 27 })!.penaltyNote).toMatch(/50 % refund/);
  });

  // Airbnb's own wording: the 24-hour cancellation period "applies to all
  // bookings for shorter stays", and the non-refundable option "is still
  // subject to" it. So even a non-refundable booking isn't locked on day one.
  it("attaches the 24 h post-booking grace period to every short Airbnb stay", () => {
    expect(parseAirbnbPolicy("Cancel policy moderate", { nights: 3 })!.graceHoursAfterBooking).toBe(24);
    expect(parseAirbnbPolicy("Cancel policy tiered_pricing_non_refundable", { nights: 3 })!.graceHoursAfterBooking).toBe(24);
    expect(parseAirbnbPolicy("Cancel policy strict", { nights: 3 })!.graceHoursAfterBooking).toBe(24);
  });

  it("does not attach it to long-term stays — they have their own 48 h rule", () => {
    expect(parseAirbnbPolicy("Cancel policy firm", { nights: 30 })!.graceHoursAfterBooking).toBeUndefined();
  });

  it("leaves Moderate alone at every stay length — its cutoff is 5 days regardless", () => {
    expect(parseAirbnbPolicy("Cancel policy moderate", { nights: 9 })!.freeDays).toBe(5);
    expect(parseAirbnbPolicy("Cancel policy moderate", { nights: 30 })!.freeDays).toBe(5);
  });

  it("resolves a tiered_pricing_ prefix to its base policy", () => {
    expect(parseAirbnbPolicy("Cancel policy tiered_pricing_moderate")!.freeDays).toBe(5);
  });

  it("flags an unknown code as unknown, keeping the code visible", () => {
    const p = parseAirbnbPolicy("Cancel policy some_new_thing")!;
    expect(p.kind).toBe("unknown");
    expect(p.sourceText).toBe("Cancel policy some_new_thing");
  });

  it("returns null when there is no cancel-policy line at all", () => {
    expect(parseAirbnbPolicy("Base Price 8903.06 CZK\n")).toBeNull();
    expect(parseAirbnbPolicy(null)).toBeNull();
  });
});

describe("deriveCancellationPolicy", () => {
  it("anchors the Booking.com free window to arrival minus the free days", () => {
    const p = deriveCancellationPolicy({
      channel: "Booking.com",
      arrivalDate: "2026-09-08",
      apiMessage: wrap(FREE_7_THEN_50),
    })!;
    expect(p.freeUntilDate).toBe("2026-09-01");
  });

  it("crosses a month boundary correctly", () => {
    const p = deriveCancellationPolicy({
      channel: "Booking.com",
      arrivalDate: "2026-09-03",
      apiMessage: wrap(FREE_7_THEN_50),
    })!;
    expect(p.freeUntilDate).toBe("2026-08-27");
  });

  it("leaves freeUntilDate null for a non-refundable booking", () => {
    const p = deriveCancellationPolicy({
      channel: "Booking.com",
      arrivalDate: "2026-09-08",
      apiMessage: wrap(NON_REFUNDABLE),
    })!;
    expect(p.freeUntilDate).toBeNull();
  });

  it("applies the published house policy to every direct channel", () => {
    for (const channel of ["Direct", "Direct-Web", "Direct-Phone"] as const) {
      const p = deriveCancellationPolicy({ channel, arrivalDate: "2026-09-20" })!;
      expect(p.source).toBe("House policy");
      expect(p.freeDays).toBe(HOUSE_FREE_CANCEL_DAYS);
      expect(p.freeUntilDate).toBe("2026-09-13");
    }
  });

  it("does not fall back to the house policy when an OTA sends nothing", () => {
    // The failure this guards: quietly showing "7 days free" on a Booking.com
    // non-refundable booking whose apiMessage Beds24 has pruned.
    expect(
      deriveCancellationPolicy({ channel: "Booking.com", arrivalDate: "2026-09-08", apiMessage: "" }),
    ).toBeNull();
    expect(
      deriveCancellationPolicy({ channel: "Airbnb", arrivalDate: "2026-09-08", rateDescription: "" }),
    ).toBeNull();
  });
});

describe("freeCancelDaysLeft", () => {
  const policy = deriveCancellationPolicy({
    channel: "Booking.com",
    arrivalDate: "2026-09-08",
    apiMessage: wrap(FREE_7_THEN_50),
  });

  it("counts days remaining to the deadline", () => {
    expect(freeCancelDaysLeft(policy, "2026-08-21")).toBe(11);
  });

  it("returns 0 on the last free day, not −1", () => {
    expect(freeCancelDaysLeft(policy, "2026-09-01")).toBe(0);
  });

  it("goes negative once the window has closed", () => {
    expect(freeCancelDaysLeft(policy, "2026-09-02")).toBe(-1);
  });

  it("is null when days-left is meaningless", () => {
    const nonRef = deriveCancellationPolicy({
      channel: "Booking.com",
      arrivalDate: "2026-09-08",
      apiMessage: wrap(NON_REFUNDABLE),
    });
    expect(freeCancelDaysLeft(nonRef, "2026-08-21")).toBeNull();
    expect(freeCancelDaysLeft(null, "2026-08-21")).toBeNull();
  });
});

describe("bookingGraceStatus", () => {
  const booked = "2026-08-21T09:00:00Z";
  const airbnb = parseAirbnbPolicy("Cancel policy tiered_pricing_non_refundable", { nights: 3 });

  it("reports the grace period as open while inside 24 h of booking", () => {
    const g = bookingGraceStatus(airbnb, booked, Date.parse("2026-08-21T20:00:00Z"))!;
    expect(g.active).toBe(true);
    expect(g.endsAt.toISOString()).toBe("2026-08-22T09:00:00.000Z");
  });

  it("closes it once 24 h have passed", () => {
    // The whole point: a non-refundable booking shows "Non-Ref" from the start,
    // but for the first 24 h that chip overstates how locked-in the money is.
    expect(bookingGraceStatus(airbnb, booked, Date.parse("2026-08-22T09:00:01Z"))!.active).toBe(false);
  });

  it("returns null for policies without a grace period, or an unusable timestamp", () => {
    const bcom = deriveCancellationPolicy({
      channel: "Booking.com",
      arrivalDate: "2026-09-08",
      apiMessage: wrap(NON_REFUNDABLE),
    });
    expect(bookingGraceStatus(bcom, booked)).toBeNull();
    expect(bookingGraceStatus(airbnb, "")).toBeNull();
    expect(bookingGraceStatus(airbnb, "not-a-date")).toBeNull();
    expect(bookingGraceStatus(null, booked)).toBeNull();
  });
});

describe("cancellationTone + label", () => {
  const p = deriveCancellationPolicy({
    channel: "Booking.com",
    arrivalDate: "2026-09-08",
    apiMessage: wrap(FREE_7_THEN_50),
  });

  it("buckets an open window, a closing one, the last day, and a closed one", () => {
    expect(cancellationTone(p, 11)).toBe("open");
    expect(cancellationTone(p, 3)).toBe("closing");
    expect(cancellationTone(p, 0)).toBe("last-day");
    expect(cancellationTone(p, -1)).toBe("locked");
  });

  it("collapses a finished stay to locked — a departed guest cancels nothing", () => {
    expect(cancellationTone(p, 11, { stayFinished: true })).toBe("locked");
  });

  it("reports non-refundable and unknown distinctly", () => {
    const nonRef = deriveCancellationPolicy({
      channel: "Booking.com",
      arrivalDate: "2026-09-08",
      apiMessage: wrap(NON_REFUNDABLE),
    });
    expect(cancellationTone(nonRef, null)).toBe("non-refundable");
    expect(cancellationTone(null, null)).toBe("unknown");
  });

  it("labels the column with days remaining, as the operator asked", () => {
    expect(cancellationShortLabel("open", 11)).toBe("11d left");
    expect(cancellationShortLabel("closing", 2)).toBe("2d left");
    expect(cancellationShortLabel("last-day", 0)).toBe("Last day");
    expect(cancellationShortLabel("locked", -4)).toBe("Locked");
    expect(cancellationShortLabel("non-refundable", null)).toBe("Non-Ref");
    expect(cancellationShortLabel("unknown", null)).toBe("—");
  });
});

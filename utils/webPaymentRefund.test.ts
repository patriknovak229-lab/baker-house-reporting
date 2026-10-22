import { describe, it, expect } from "vitest";
import type { PlatformRefund, PlatformRefundStripeEntry, Reservation, StayShortening } from "@/types/reservation";
import {
  checkoutMatchesBooking,
  matchSignals,
  mergeStripeRefund,
  parseRefundAmount,
  recordedButFailed,
  refundableHal,
  resolveWebPayment,
  unrecordedRefunds,
  type StripeRefundLite,
  type WebBookingFacts,
  type WebCheckout,
} from "./webPaymentRefund";
import { reservationRevenue, revenueShareInPeriod } from "./reservationRevenue";
import { monthRange } from "./commissionCalc";

/**
 * Every website payment in the Stripe log (May–Oct 2026) with the Direct-Web
 * booking it paid for — real stays, amounts and timestamps; emails and session
 * ids made up (the repo is public). Guest 6 and guest 7 have two bookings each.
 */
const PAIRS: Array<[string, string, string, number, number, string, string, string, string, string]> = [
  // session, guest, stay → paid (Stripe log), amount, price, booking, check-in, check-out, booked at
  ["cs_test_w01", "guest1", "2026-05-25 → 2026-06-01", 14071.04, 14071.04, "2026-05-09T15:17:20Z", "BH-86527838", "2026-05-25", "2026-05-29", "2026-05-09T15:17:35Z"],
  ["cs_test_w02", "guest2", "2026-06-30 → 2026-07-01", 3902.4, 3902.4, "2026-06-29T09:54:06Z", "BH-89000438", "2026-06-30", "2026-07-01", "2026-06-29T09:54:23Z"],
  ["cs_test_w03", "guest3", "2026-07-03 → 2026-07-04", 2756.8, 2756.8, "2026-07-01T15:55:51Z", "BH-89132870", "2026-07-03", "2026-07-04", "2026-07-01T15:56:08Z"],
  ["cs_test_w04", "guest4", "2026-08-10 → 2026-08-13", 4382.38, 4382.38, "2026-07-16T08:52:38Z", "BH-89925619", "2026-08-10", "2026-08-13", "2026-07-16T08:52:55Z"],
  ["cs_test_w05", "guest5", "2026-09-03 → 2026-09-05", 3897.96, 3897.96, "2026-08-18T21:21:14Z", "BH-91696467", "2026-09-03", "2026-09-05", "2026-08-18T21:21:31Z"],
  ["cs_test_w06", "guest6", "2026-09-12 → 2026-09-27", 27521.6, 27521.6, "2026-09-03T16:14:03Z", "BH-92538626", "2026-09-12", "2026-09-27", "2026-09-03T16:14:19Z"],
  ["cs_test_w07", "guest6", "2026-09-27 → 2026-10-25", 48735.6, 48735.6, "2026-09-04T13:27:16Z", "BH-92586229", "2026-09-27", "2026-10-03", "2026-09-04T13:27:33Z"],
  ["cs_test_w08", "guest7", "2026-09-14 → 2026-09-15", 3576, 3576, "2026-09-10T10:59:32Z", "BH-92896076", "2026-09-14", "2026-09-15", "2026-09-10T10:59:47Z"],
  ["cs_test_w09", "guest7", "2026-09-13 → 2026-09-14", 2625, 2625, "2026-09-12T08:32:46Z", "BH-92994939", "2026-09-13", "2026-09-14", "2026-09-12T08:33:02Z"],
  ["cs_test_w10", "guest8", "2026-09-18 → 2026-09-20", 5012.24, 5012.24, "2026-09-13T18:47:55Z", "BH-93067943", "2026-09-18", "2026-09-20", "2026-09-13T18:48:12Z"],
  ["cs_test_w11", "guest9", "2026-09-26 → 2026-09-29", 6522, 6522, "2026-09-23T07:21:55Z", "BH-93542411", "2026-09-26", "2026-09-29", "2026-09-23T07:22:12Z"],
  ["cs_test_w12", "guest10", "2026-10-01 → 2026-10-02", 2269.75, 2269.75, "2026-09-29T16:37:45Z", "BH-93890647", "2026-10-01", "2026-10-02", "2026-09-29T16:38:03Z"],
  ["cs_test_w13", "guest11", "2026-10-19 → 2026-10-27", 13859.4, 13859.4, "2026-10-06T10:18:55Z", "BH-94258097", "2026-10-19", "2026-10-27", "2026-10-06T10:19:12Z"],
  ["cs_test_w14", "guest12", "2026-10-14 → 2026-10-15", 2125, 2125, "2026-10-13T11:13:20Z", "BH-94613445", "2026-10-14", "2026-10-15", "2026-10-13T11:13:29Z"],
  ["cs_test_w15", "guest13", "2026-11-20 → 2026-11-22", 5332.39, 5332.39, "2026-10-18T09:41:23Z", "BH-94864852", "2026-11-20", "2026-11-22", "2026-10-18T09:41:31Z"],
  ["cs_test_w16", "guest14", "2026-10-21 → 2026-10-22", 2577.75, 2577.75, "2026-10-20T15:58:36Z", "BH-94989782", "2026-10-21", "2026-10-22", "2026-10-20T15:58:45Z"],
];

/** BH-92586229 was shortened on 4 Oct from 27 Sep → 25 Oct to depart 3 Oct */
const SHORTENING: StayShortening = {
  shortenedAt: "2026-10-04T16:10:57.407Z",
  shortenedBy: "ops@example.com",
  fromArrival: "2026-09-27",
  fromDeparture: "2026-10-25",
  toArrival: "2026-09-27",
  toDeparture: "2026-10-03",
  nightsRemoved: 22,
  originalPriceCzk: 48735.6,
};

const CHECKOUTS: WebCheckout[] = PAIRS.map(([sessionId, guest, stay, amountCzk, , paidAt]) => ({
  sessionId,
  description: `Web booking ${stay}`,
  amountCzk,
  guestEmail: `${guest}@Example.com`, // case differs from the booking on purpose
  paidAt,
}));

const BOOKINGS: WebBookingFacts[] = PAIRS.map(([, guest, , , price, , reservationNumber, checkInDate, checkOutDate, bookingTimestamp]) => ({
  reservationNumber,
  channel: "Direct-Web",
  checkInDate,
  checkOutDate,
  price,
  email: `${guest}@example.com`,
  bookingTimestamp,
  isCancelled: false,
  stayShortened: reservationNumber === "BH-92586229" ? SHORTENING : null,
}));

const sameGuest = (b: WebBookingFacts) => BOOKINGS.filter((x) => x.email === b.email);
const booking = (rn: string) => BOOKINGS.find((b) => b.reservationNumber === rn)!;

describe("linking a website payment to its booking", () => {
  it("ties every real payment to exactly its own booking, both ways", () => {
    for (const [sessionId, , , , , , rn] of PAIRS) {
      const link = resolveWebPayment(booking(rn), CHECKOUTS, sameGuest(booking(rn)));
      expect(link, rn).toMatchObject({ status: "linked", checkout: { sessionId } });
      const c = CHECKOUTS.find((x) => x.sessionId === sessionId)!;
      expect(BOOKINGS.filter((b) => checkoutMatchesBooking(c, b)).map((b) => b.reservationNumber)).toEqual([rn]);
    }
  });

  it("uses the ORIGINAL dates of a shortened stay (BH-92586229)", () => {
    const c = CHECKOUTS.find((x) => x.sessionId === "cs_test_w07")!;
    expect(matchSignals(c, booking("BH-92586229"))).toEqual({ email: true, dates: true, amount: true, timing: true });
    // Without the shorten record the dates no longer agree — amount + timing still carry it
    const bare = { ...booking("BH-92586229"), stayShortened: null };
    expect(matchSignals(c, bare)).toMatchObject({ dates: false, amount: true, timing: true });
    expect(checkoutMatchesBooking(c, bare)).toBe(true);
  });

  it("keeps the guest's other booking (12 → 27 Sep, paid separately) apart", () => {
    const sep = resolveWebPayment(booking("BH-92538626"), CHECKOUTS, sameGuest(booking("BH-92538626")));
    expect(sep).toMatchObject({ status: "linked", checkout: { sessionId: "cs_test_w06", amountCzk: 27521.6 } });
    const c = CHECKOUTS.find((x) => x.sessionId === "cs_test_w07")!;
    expect(matchSignals(c, booking("BH-92538626"))).toMatchObject({ email: true, dates: false, amount: false, timing: false });
  });

  it("matches the price the guest paid even after it was lowered in Beds24", () => {
    const lowered = { ...booking("BH-92586229"), price: 30_000 };
    const c = CHECKOUTS.find((x) => x.sessionId === "cs_test_w07")!;
    expect(matchSignals(c, lowered).amount).toBe(true);
  });

  it("refuses one payment for two bookings (two apartments in one order)", () => {
    const a: WebBookingFacts = { ...booking("BH-89000438"), reservationNumber: "BH-1", price: 1951.2 };
    const b: WebBookingFacts = { ...a, reservationNumber: "BH-2" };
    const link = resolveWebPayment(a, CHECKOUTS, [a, b]);
    expect(link.status).toBe("ambiguous");
    expect(link.status !== "linked" && link.reason).toContain("BH-2");
  });

  it("refuses two payments that both fit (e.g. the guest paid twice)", () => {
    const dup = { ...CHECKOUTS[1], sessionId: "cs_test_dup" };
    expect(resolveWebPayment(booking("BH-89000438"), [...CHECKOUTS, dup], sameGuest(booking("BH-89000438"))).status).toBe("ambiguous");
  });

  it("needs the same guest email", () => {
    const b = { ...booking("BH-89000438"), email: "someone.else@example.com" };
    expect(resolveWebPayment(b, CHECKOUTS, [b]).status).toBe("none");
    const blank = { ...booking("BH-89000438"), email: "" };
    expect(resolveWebPayment(blank, CHECKOUTS, [blank]).status).toBe("none");
  });

  it("needs two of stay / amount / timing, not one", () => {
    const b: WebBookingFacts = {
      ...booking("BH-89000438"),
      checkInDate: "2026-07-10",
      checkOutDate: "2026-07-11",
      bookingTimestamp: "2026-07-01T00:00:00Z",
    }; // only the amount still agrees
    expect(resolveWebPayment(b, CHECKOUTS, [b]).status).toBe("none");
  });

  it("only looks at website payments and Direct-Web bookings", () => {
    const link: WebCheckout = { ...CHECKOUTS[1], description: "Extra night K.201" };
    expect(checkoutMatchesBooking(link, booking("BH-89000438"))).toBe(false);
    const phone = { ...booking("BH-89000438"), channel: "Direct-Phone" };
    expect(resolveWebPayment(phone, CHECKOUTS, [phone]).status).toBe("none");
  });

  it("allows the booking a minute of clock skew before the payment, not a day", () => {
    const c = CHECKOUTS[1];
    const at = (iso: string) => matchSignals(c, { ...booking("BH-89000438"), bookingTimestamp: iso }).timing;
    expect(at("2026-06-29T09:52:00Z")).toBe(true);
    expect(at("2026-06-29T10:50:00Z")).toBe(true);
    expect(at("2026-06-28T09:54:06Z")).toBe(false);
    expect(at("2026-06-29T11:30:00Z")).toBe(false);
  });
});

describe("refund maths", () => {
  const r = (id: string, amountHal: number, status: string, metadata?: Record<string, string>): StripeRefundLite =>
    ({ id, amountHal, status, created: 1_761_800_000, metadata });

  it("counts pending and succeeded refunds, not failed or canceled ones", () => {
    const refunds = [r("re_1", 1_000_000, "succeeded"), r("re_2", 500_000, "pending"), r("re_3", 900_000, "failed"), r("re_4", 100, "canceled")];
    expect(refundableHal(4_873_560, 1_500_000, refunds)).toBe(3_373_560);
  });

  it("trusts Stripe's own refunded counter when the list is short", () => {
    expect(refundableHal(4_873_560, 2_000_000, [])).toBe(2_873_560);
    expect(refundableHal(100_000, 200_000, [])).toBe(0);
  });

  it("parses amounts to the haléř and rejects the rest", () => {
    expect(parseRefundAmount("22000")).toEqual({ hal: 2_200_000 });
    expect(parseRefundAmount(48735.6)).toEqual({ hal: 4_873_560 });
    expect(parseRefundAmount("0.01")).toEqual({ hal: 1 });
    for (const bad of ["0", "-5", "1.234", "abc", "", null, undefined, Infinity]) {
      expect(parseRefundAmount(bad), String(bad)).toHaveProperty("error");
    }
  });

  it("splits Stripe refunds into recorded / not recorded / recorded but failed", () => {
    const pr: PlatformRefund = {
      amountCzk: 15_000, refundedAt: "2026-10-30", flaggedAt: "x", flaggedBy: "ops@example.com", originalPriceCzk: 48735.6,
      stripeRefunds: [
        { id: "re_1", sessionId: "cs_test_w07", amountCzk: 10_000, refundedAt: "2026-10-30", by: "ops@example.com" },
        { id: "re_3", sessionId: "cs_test_w07", amountCzk: 5_000, refundedAt: "2026-10-30", by: "ops@example.com" },
      ],
    };
    const refunds = [r("re_1", 1_000_000, "succeeded"), r("re_2", 200_000, "succeeded"), r("re_3", 500_000, "failed")];
    expect(unrecordedRefunds(refunds, pr).map((x) => x.id)).toEqual(["re_2"]);
    expect(recordedButFailed(refunds, pr).map((x) => x.id)).toEqual(["re_3"]);
    expect(unrecordedRefunds(refunds, null).map((x) => x.id)).toEqual(["re_1", "re_2"]);
  });
});

describe("recording the refund on the booking", () => {
  const entry = (id: string, amountCzk: number, refundedAt = "2026-10-31"): PlatformRefundStripeEntry =>
    ({ id, sessionId: "cs_test_w07", amountCzk, refundedAt, by: "admin@example.com" });
  const ctx = { priceCzk: 48735.6, nowIso: "2026-10-31T10:00:00.000Z", reason: "22 unused nights resold" };

  it("creates the platform refund like “Mark partially refunded” does", () => {
    expect(mergeStripeRefund(null, entry("re_1", 22_000), ctx)).toEqual({
      amountCzk: 22_000,
      refundedAt: "2026-10-31",
      reason: "22 unused nights resold",
      flaggedAt: "2026-10-31T10:00:00.000Z",
      flaggedBy: "admin@example.com",
      originalPriceCzk: 48735.6,
      stripeRefunds: [entry("re_1", 22_000)],
    });
  });

  it("adds to a refund recorded by hand, keeping who flagged it and the price at the time", () => {
    const manual: PlatformRefund = {
      amountCzk: 1_000, refundedAt: "2026-10-05", reason: "late check-in",
      flaggedAt: "2026-10-05T09:00:00Z", flaggedBy: "ops@example.com", originalPriceCzk: 50_000,
    };
    const out = mergeStripeRefund(manual, entry("re_1", 5_000.5), ctx)!;
    expect(out).toMatchObject({
      amountCzk: 6_000.5,
      refundedAt: "2026-10-31",
      reason: "late check-in; 22 unused nights resold",
      flaggedAt: "2026-10-05T09:00:00Z",
      flaggedBy: "ops@example.com",
      originalPriceCzk: 50_000,
    });
    expect(out.stripeRefunds).toHaveLength(1);
  });

  it("never counts the same Stripe refund twice", () => {
    const once = mergeStripeRefund(null, entry("re_1", 22_000), ctx)!;
    expect(mergeStripeRefund(once, entry("re_1", 22_000), ctx)).toBeNull();
    const twice = mergeStripeRefund(once, entry("re_2", 0.1, "2026-10-20"), { ...ctx, reason: "22 unused nights resold" })!;
    expect(twice.amountCzk).toBe(22_000.1);
    expect(twice.refundedAt).toBe("2026-10-31"); // the later date wins
    expect(twice.reason).toBe("22 unused nights resold");
    expect(twice.stripeRefunds!.map((e) => e.id)).toEqual(["re_1", "re_2"]);
  });

  it("comes off the unused nights of a shortened stay first (BH-92586229)", () => {
    const PRICE = 48735.6;
    const RATE = PRICE / 28;
    const base = {
      reservationNumber: "BH-92586229", room: "K.103", channel: "Direct-Web",
      checkInDate: "2026-09-27", checkOutDate: "2026-10-03", numberOfNights: 6,
      price: PRICE, commissionAmount: 0, paymentChargeAmount: 0, amountPaid: PRICE, paymentStatus: "Paid",
      stayShortened: SHORTENING,
    } as unknown as Reservation;
    const r = { ...base, platformRefund: mergeStripeRefund(null, entry("re_1", 22_000), ctx) } as Reservation;
    const gbvIn = (x: Reservation, m: string) => reservationRevenue(x).gbv * revenueShareInPeriod(x, monthRange(m));
    expect(gbvIn(r, "2026-09")).toBeCloseTo(4 * RATE, 6);          // September untouched
    expect(gbvIn(r, "2026-10")).toBeCloseTo(24 * RATE - 22_000, 6); // the refund leaves October
  });
});

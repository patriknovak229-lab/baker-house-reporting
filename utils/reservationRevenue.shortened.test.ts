import { describe, it, expect } from "vitest";
import type { Reservation, StayShortening } from "@/types/reservation";
import {
  hasRevenueInPeriod,
  reservationRevenue,
  revenueShareInPeriod,
  shortenedRevenueSpans,
  shortenedRevenueSplit,
} from "./reservationRevenue";
import { expandLinkedReservations } from "./expandReservations";
import { computeSettlement, monthRange, type VariableCostBundle } from "./commissionCalc";
import { COMMISSION_UNITS } from "./commissionConfig";

/**
 * Shortened stays keep the original nightly rate.
 *
 * Modelled on BH-92586229 (Direct-Web, K.103): booked 2026-09-27 → 10-25
 * (28 nights) for 48 735.60 Kč, paid in full, shortened on 10-04 to depart
 * 10-03 (6 nights). The price stays in Beds24; the guest's refund for any
 * resold nights is only settled at the end of October. Spreading the full
 * price over the 6 remaining nights booked 4/6 of it into September — +25 528 Kč
 * on the Urban pool, +6 382 Kč on each owner's payable — instead of 4/28.
 */

const SEP = monthRange("2026-09");
const OCT = monthRange("2026-10");
const PRICE = 48_735.6;
const RATE = PRICE / 28;

const SHORTENING: StayShortening = {
  shortenedAt: "2026-10-04T16:10:57.407Z",
  shortenedBy: "ops@example.com",
  fromArrival: "2026-09-27",
  fromDeparture: "2026-10-25",
  toArrival: "2026-09-27",
  toDeparture: "2026-10-03",
  nightsRemoved: 22,
  originalPriceCzk: PRICE,
};

function nightsOf(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function res(over: Partial<Reservation> & Pick<Reservation, "checkInDate" | "checkOutDate">): Reservation {
  return {
    reservationNumber: "BH-92586229",
    room: "K.103",
    channel: "Direct-Web",
    numberOfNights: nightsOf(over.checkInDate, over.checkOutDate),
    price: PRICE,
    commissionAmount: 0,
    paymentChargeAmount: 0,
    amountPaid: PRICE,
    paymentStatus: "Paid",
    ...over,
  } as unknown as Reservation;
}

const shortened = (over: Partial<Reservation> = {}) =>
  res({ checkInDate: "2026-09-27", checkOutDate: "2026-10-03", stayShortened: SHORTENING, ...over });

const gbvIn = (r: Reservation, range = SEP) => reservationRevenue(r).gbv * revenueShareInPeriod(r, range);

describe("shortened stay — revenue stays on the original nightly schedule", () => {
  it("books September at the original rate, not the full price over 6 nights", () => {
    const r = shortened();
    expect(gbvIn(r, SEP)).toBeCloseTo(4 * RATE, 6); // 6 962.23, as issued
    expect(gbvIn(r, OCT)).toBeCloseTo(24 * RATE, 6); // 2 stayed + 22 unused
    // The bug being fixed: the plain spread put 4/6 of the price in September.
    expect(gbvIn({ ...r, stayShortened: null }, SEP)).toBeCloseTo((PRICE * 4) / 6, 6);
  });

  it("never creates or loses money — the shares add up to the whole stay", () => {
    const spans = shortenedRevenueSpans({
      shortening: SHORTENING,
      checkInDate: "2026-09-27",
      checkOutDate: "2026-10-03",
      gbv: PRICE,
    })!;
    expect(spans.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 12);
    const r = shortened();
    expect(revenueShareInPeriod(r, SEP) + revenueShareInPeriod(r, OCT)).toBeCloseTo(1, 12);
  });

  it("takes a recorded refund off the unused nights, leaving September alone", () => {
    const r = shortened({
      platformRefund: {
        amountCzk: 30_000,
        refundedAt: "2026-10-31",
        flaggedAt: "2026-10-31T10:00:00Z",
        flaggedBy: "ops@example.com",
        originalPriceCzk: PRICE,
      },
    });
    expect(gbvIn(r, SEP)).toBeCloseTo(4 * RATE, 6);
    expect(gbvIn(r, OCT)).toBeCloseTo(24 * RATE - 30_000, 6);
    expect(shortenedRevenueSplit(r)).toMatchObject({ stayedNights: 6, unusedNights: 22 });
    expect(shortenedRevenueSplit(r)!.unusedCzk).toBeCloseTo(22 * RATE - 30_000, 6);
  });

  it("only eats into the stayed nights once a refund exceeds what the unused ones were worth", () => {
    const r = shortened({
      platformRefund: {
        amountCzk: 45_000, // more than the 22 unused nights (38 292) are worth
        refundedAt: "2026-10-31",
        flaggedAt: "2026-10-31T10:00:00Z",
        flaggedBy: "ops@example.com",
        originalPriceCzk: PRICE,
      },
    });
    const left = PRICE - 45_000;
    expect(gbvIn(r, SEP)).toBeCloseTo((left * 4) / 6, 6); // whatever is left, over the 6 stayed nights
    expect(gbvIn(r, OCT)).toBeCloseTo((left * 2) / 6, 6);
  });

  it("treats a price lowered in Beds24 (the old workflow) like a refund on the unused nights", () => {
    // BH-92628122: 3 nights for 9 804.66 cut to 2, price lowered by one night.
    const r = res({
      checkInDate: "2026-09-10",
      checkOutDate: "2026-09-12",
      price: 6_536.44,
      stayShortened: {
        ...SHORTENING,
        fromArrival: "2026-09-10",
        fromDeparture: "2026-09-13",
        toArrival: "2026-09-10",
        toDeparture: "2026-09-12",
        nightsRemoved: 1,
        originalPriceCzk: 9_804.66,
      },
    });
    expect(gbvIn(r, SEP)).toBeCloseTo(6_536.44, 6);
    expect(shortenedRevenueSplit(r)!.unusedCzk).toBeCloseTo(0, 6);
  });

  it("puts nights trimmed off the START on their own dates", () => {
    // Booked 08-29 → 09-05, guest arrives 09-02 instead: 4 August-ish nights trimmed.
    const r = res({
      checkInDate: "2026-09-02",
      checkOutDate: "2026-09-05",
      price: 7_000,
      stayShortened: {
        ...SHORTENING,
        fromArrival: "2026-08-29",
        fromDeparture: "2026-09-05",
        toArrival: "2026-09-02",
        toDeparture: "2026-09-05",
        nightsRemoved: 4,
        originalPriceCzk: 7_000,
      },
    });
    const AUG = monthRange("2026-08");
    expect(gbvIn(r, AUG)).toBeCloseTo(3_000, 6); // 29, 30, 31 Aug
    expect(gbvIn(r, SEP)).toBeCloseTo(4_000, 6); // 1 Sep unused + 3 stayed
    expect(hasRevenueInPeriod(r, AUG)).toBe(true);
  });

  it("brings revenue into a month the guest never slept in", () => {
    // Cut to leave on 1 Oct (last night 30 Sep); the original stay ran to 5 Oct.
    const r = res({
      checkInDate: "2026-09-27",
      checkOutDate: "2026-10-01",
      price: 8_000,
      stayShortened: {
        ...SHORTENING,
        toDeparture: "2026-10-01",
        fromDeparture: "2026-10-05",
        nightsRemoved: 4,
        originalPriceCzk: 8_000,
      },
    });
    expect(hasRevenueInPeriod(r, OCT)).toBe(true);
    expect(gbvIn(r, OCT)).toBeCloseTo(4_000, 6);
    expect(gbvIn(r, SEP)).toBeCloseTo(4_000, 6);
  });

  it("falls back to the plain spread when the record no longer matches the dates", () => {
    // Someone moved the booking again in Beds24 after the shortening.
    const r = shortened({ checkOutDate: "2026-10-02", numberOfNights: 5 });
    expect(revenueShareInPeriod(r, SEP)).toBeCloseTo(4 / 5, 12);
    expect(shortenedRevenueSplit(r)).toBeNull();
  });

  it("ignores the record on a non-arrival or cancellation", () => {
    expect(revenueShareInPeriod(shortened({ isCancelled: true }), SEP)).toBeCloseTo(4 / 6, 12);
  });
});

describe("shortened stay — split pieces", () => {
  it("a two-apartment package keeps the same schedule in each room", () => {
    const whole = shortened({ linkedRooms: ["K.102", "K.103"] as Reservation["linkedRooms"] });
    const pieces = expandLinkedReservations([whole]);
    expect(pieces).toHaveLength(2);
    for (const range of [SEP, OCT]) {
      const sum = pieces.reduce((s, p) => s + gbvIn(p, range), 0);
      expect(sum).toBeCloseTo(gbvIn(whole, range), 0); // pieces round price to whole CZK
    }
    // Idempotent: a second pass (commissionYear → computeSettlement) changes nothing.
    expect(expandLinkedReservations(pieces)).toEqual(pieces);
  });

  it("a mid-stay move hands the unused nights to the apartment the stay ended in", () => {
    // Moved K.102 → K.103 on 09-29, then shortened (dates in Beds24 = 09-27 → 10-03).
    const whole = shortened({
      room: "K.103",
      roomSegments: [
        { room: "K.102", from: "2026-09-27", to: "2026-09-29", nights: 2, share: 2 / 6 },
        { room: "K.103", from: "2026-09-29", to: "2026-10-03", nights: 4, share: 4 / 6 },
      ],
    });
    const [k102, k103] = expandLinkedReservations([whole]);
    expect(gbvIn(k102, SEP)).toBeCloseTo(2 * RATE, 0);
    expect(gbvIn(k102, OCT)).toBeCloseTo(0, 6);
    expect(gbvIn(k103, SEP)).toBeCloseTo(2 * RATE, 0);
    expect(gbvIn(k103, OCT)).toBeCloseTo(24 * RATE, 0);
    expect(gbvIn(k102, SEP) + gbvIn(k103, SEP)).toBeCloseTo(4 * RATE, 0);
  });
});

describe("shortened stay — owner settlement", () => {
  const costs: VariableCostBundle = {
    byDateRoom: {},
    byReservation: {},
    subscriptionItems: [],
    manualCleaningKeys: [],
    noLaundryKeys: [],
    dismissedCleaningKeys: [],
  };
  const unit = COMMISSION_UNITS.find((u) => u.id === "K.102")!;

  it("September Urban pool matches the booking as it stood when the settlement was issued", () => {
    const beforeShortening = res({ checkInDate: "2026-09-27", checkOutDate: "2026-10-25" });
    const issued = computeSettlement(unit, "2026-09", [beforeShortening], costs);
    const live = computeSettlement(unit, "2026-09", [shortened()], costs);
    expect(live.gbv).toBeCloseTo(issued.gbv, 6);
    expect(live.payableToOwner).toBeCloseTo(issued.payableToOwner, 6);
  });

  it("a month holding only the unused nights gets their money but no booking or cleaning", () => {
    const r = res({
      checkInDate: "2026-09-27",
      checkOutDate: "2026-10-01",
      price: 8_000,
      stayShortened: {
        ...SHORTENING,
        toDeparture: "2026-10-01",
        fromDeparture: "2026-10-05",
        nightsRemoved: 4,
        originalPriceCzk: 8_000,
      },
    });
    const oct = computeSettlement(unit, "2026-10", [r], costs);
    expect(oct.gbv * 3).toBeCloseTo(4_000, 6); // pool ÷ 3
    expect(oct.cleaningBreakdown).toMatchObject({ total: 1, billed: 0 }); // the 1 Oct checkout, nothing more
  });
});

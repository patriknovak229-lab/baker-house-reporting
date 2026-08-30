import { describe, it, expect } from "vitest";
import { reservationRevenue, platformRefundShare } from "./reservationRevenue";
import type { Reservation, PlatformRefund } from "@/types/reservation";

// Modelled on the booking that prompted the feature: BH-90387422, a
// Booking.com stay of 8 743.68 Kč with 1 552.90 commission + 131.16 payment
// charge, on which the operator later handed 2 500 Kč back to the guest.
function mk(over: Partial<Reservation>): Reservation {
  return {
    reservationNumber: "BH-90387422",
    channel: "Booking.com",
    price: 8743.68,
    commissionAmount: 1552.9,
    paymentChargeAmount: 131.16,
    numberOfNights: 2,
    ...over,
  } as unknown as Reservation;
}

function refund(over: Partial<PlatformRefund> = {}): PlatformRefund {
  return {
    amountCzk: 2500,
    refundedAt: "2026-08-26",
    flaggedAt: "2026-08-30T09:00:00.000Z",
    flaggedBy: "operator@example.com",
    originalPriceCzk: 8743.68,
    ...over,
  };
}

describe("reservationRevenue — plain bookings", () => {
  it("passes Beds24 figures through untouched", () => {
    expect(reservationRevenue(mk({}))).toEqual({
      gbv: 8743.68,
      commission: 1552.9,
      fee: 131.16,
    });
  });
});

describe("reservationRevenue — partial platform refund", () => {
  it("drops GBV by the refund while the channel's fees stay on the original base", () => {
    // The whole point of the feature: Booking.com bills its cut on the price it
    // sold at and never hears about money handed back, so the same fee on a
    // smaller gross is what makes the effective rate on this booking higher.
    const rev = reservationRevenue(mk({ platformRefund: refund() }));
    expect(rev.gbv).toBeCloseTo(6243.68, 2);
    expect(rev.commission).toBe(1552.9);
    expect(rev.fee).toBe(131.16);
    expect(rev.gbv - rev.commission - rev.fee).toBeCloseTo(4559.62, 2);
  });

  it("raises the effective channel rate rather than recalculating the fee", () => {
    const before = reservationRevenue(mk({}));
    const after = reservationRevenue(mk({ platformRefund: refund() }));
    const rate = (r: { gbv: number; commission: number; fee: number }) =>
      (r.commission + r.fee) / r.gbv;
    expect(rate(before)).toBeCloseTo(0.1926, 4);
    expect(rate(after)).toBeCloseTo(0.2697, 4);
  });

  it("pro-rates across the rooms of a split package booking", () => {
    // expandLinkedReservations divides a package's price across its rooms; the
    // refund has to follow the same split or one room absorbs all of it.
    const half = mk({ price: 4371.84, platformRefund: refund() });
    expect(platformRefundShare(half)).toBeCloseTo(1250, 6);
  });

  it("clamps to the row price so a mistyped amount can't go negative", () => {
    const over = mk({ platformRefund: refund({ amountCzk: 99999 }) });
    expect(platformRefundShare(over)).toBe(8743.68);
  });

  it("ignores a zero or absent refund", () => {
    expect(platformRefundShare(mk({}))).toBe(0);
    expect(platformRefundShare(mk({ platformRefund: refund({ amountCzk: 0 }) }))).toBe(0);
    expect(platformRefundShare(mk({ platformRefund: null }))).toBe(0);
  });

  it("falls back to the full amount when the flagged price was zero", () => {
    // Guard against a divide-by-zero producing NaN in a monthly total.
    const weird = mk({ platformRefund: refund({ originalPriceCzk: 0 }) });
    expect(platformRefundShare(weird)).toBe(2500);
  });
});

describe("reservationRevenue — non-arrival wins over a stale refund", () => {
  it("returns the net retained, ignoring the refund entirely", () => {
    // nonArrivalNetPriceCzk is already the amount kept after any channel refund;
    // counting platformRefund on top would deduct the same money twice.
    const na = mk({
      price: 8743.68,
      nonArrival: {
        flaggedAt: "2026-08-30T09:00:00.000Z",
        flaggedBy: "operator@example.com",
        originalPriceCzk: 8743.68,
      },
      nonArrivalNetPriceCzk: 6243.68,
      platformRefund: refund(),
    });
    const rev = reservationRevenue(na);
    expect(rev.gbv).toBeCloseTo(6243.68, 2);
    expect(rev.commission).toBe(0);
    expect(rev.fee).toBe(0);
  });
});

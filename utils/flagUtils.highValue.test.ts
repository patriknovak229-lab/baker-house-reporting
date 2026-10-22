import { describe, it, expect } from "vitest";
import { computeAutoFlags } from "./flagUtils";
import type { Reservation } from "@/types/reservation";

/**
 * High Value = a stay of 5+ nights. A cancelled booking earns nothing, so it
 * doesn't qualify — the "HV" tag used to show on cancelled rows. A non-arrival
 * is cancelled in Beds24 on purpose and still counts as revenue, so it keeps it.
 */

/** Minimal valid Reservation; defaults to a 5-night stay. */
function res(overrides: Partial<Reservation> = {}): Reservation {
  return {
    reservationNumber: "BH-1000",
    firstName: "Jane",
    lastName: "Doe",
    channel: "Booking.com",
    room: "K.201",
    checkInDate: "2026-11-10",
    checkOutDate: "2026-11-15",
    reservationDate: "2026-10-01",
    bookingTimestamp: "2026-10-01T10:00:00Z",
    numberOfNights: 5,
    numberOfGuests: 2,
    email: "jane@example.com",
    phone: "+420123456789",
    price: 15000,
    nationality: "GB",
    cleaningStatus: "Pending",
    paymentStatus: "Paid",
    amountPaid: 15000,
    commissionAmount: 0,
    paymentChargeAmount: 0,
    additionalEmail: "",
    paymentStatusOverride: null,
    notes: "",
    manualFlagOverrides: {},
    ratingStatus: "none",
    invoiceData: null,
    invoiceStatus: "Not Issued",
    ...overrides,
  };
}

const isHighValue = (r: Reservation) => computeAutoFlags(r, [r]).has("High Value Customer");

describe("High Value Customer tag", () => {
  it("tags a live stay of 5+ nights", () => {
    expect(isHighValue(res())).toBe(true);
  });

  it("does not tag a stay under 5 nights", () => {
    expect(isHighValue(res({ numberOfNights: 4 }))).toBe(false);
  });

  it("does NOT tag a cancelled booking", () => {
    expect(isHighValue(res({ isCancelled: true, numberOfNights: 7 }))).toBe(false);
  });

  it("still tags a non-arrival, which counts as revenue", () => {
    const noShow = res({
      isCancelled: true,
      nonArrival: {
        flaggedAt: "2026-11-09T10:00:00Z",
        flaggedBy: "ops@bakerhouse.cz",
        originalPriceCzk: 15000,
      },
    });
    expect(isHighValue(noShow)).toBe(true);
  });
});

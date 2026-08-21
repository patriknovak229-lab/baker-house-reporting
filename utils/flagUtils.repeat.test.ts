import { describe, it, expect } from "vitest";
import { computeAutoFlags, getEffectiveFlags } from "./flagUtils";
import type { Reservation } from "@/types/reservation";

/**
 * The Repeat Customer tag only counts stays we actually SERVED. A guest who
 * books, cancels and rebooks used to earn the tag off their own cancellation;
 * these tests are the tripwire for that regression.
 */

const today = new Date();
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysFromToday = (n: number) => {
  const d = new Date(today);
  d.setDate(d.getDate() + n);
  return ymd(d);
};

/** Minimal valid Reservation; defaults to a short past stay 30 days ago. */
function res(overrides: Partial<Reservation> = {}): Reservation {
  return {
    reservationNumber: "BH-1000",
    firstName: "Jane",
    lastName: "Doe",
    channel: "Direct-Web",
    room: "K.201",
    checkInDate: daysFromToday(-33),
    checkOutDate: daysFromToday(-30),
    reservationDate: daysFromToday(-60),
    bookingTimestamp: "2026-01-01T10:00:00Z",
    numberOfNights: 3,
    numberOfGuests: 2,
    email: "jane@example.com",
    phone: "+420123456789",
    price: 9000,
    nationality: "GB",
    cleaningStatus: "Pending",
    paymentStatus: "Paid",
    amountPaid: 9000,
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

/** The booking currently being looked at — an upcoming stay by the same guest. */
const upcoming = res({
  reservationNumber: "BH-2000",
  checkInDate: daysFromToday(10),
  checkOutDate: daysFromToday(13),
  reservationDate: daysFromToday(-1),
});

const isRepeat = (r: Reservation, all: Reservation[]) =>
  computeAutoFlags(r, all).has("Repeat Customer");

describe("Repeat Customer tag", () => {
  it("tags a guest with a completed prior stay", () => {
    expect(isRepeat(upcoming, [upcoming, res()])).toBe(true);
  });

  it("matches on full name when the email differs (OTA conduit addresses)", () => {
    const prior = res({ email: "conduit@booking.com", channel: "Booking.com" });
    expect(isRepeat(upcoming, [upcoming, prior])).toBe(true);
  });

  it("does NOT tag off a cancelled prior booking", () => {
    expect(isRepeat(upcoming, [upcoming, res({ isCancelled: true })])).toBe(false);
  });

  it("does NOT tag off a non-arrival", () => {
    const noShow = res({
      nonArrival: {
        flaggedAt: "2026-01-01T00:00:00Z",
        flaggedBy: "ops@bakerhouse.cz",
        reason: "Guest could not travel",
        originalPriceCzk: 9000,
      },
    });
    expect(isRepeat(upcoming, [upcoming, noShow])).toBe(false);
  });

  it("does NOT tag off a blackout block", () => {
    expect(isRepeat(upcoming, [upcoming, res({ isBlackout: true })])).toBe(false);
  });

  it("does NOT tag off a stay that hasn't finished yet", () => {
    // Two upcoming bookings by the same guest — neither has been served.
    const alsoUpcoming = res({
      reservationNumber: "BH-3000",
      checkInDate: daysFromToday(40),
      checkOutDate: daysFromToday(43),
    });
    expect(isRepeat(upcoming, [upcoming, alsoUpcoming])).toBe(false);
  });

  it("does NOT tag off an in-house stay that hasn't checked out", () => {
    const inHouse = res({
      reservationNumber: "BH-4000",
      checkInDate: daysFromToday(-1),
      checkOutDate: daysFromToday(2),
    });
    expect(isRepeat(upcoming, [upcoming, inHouse])).toBe(false);
  });

  it("ignores served stays older than the 12-month window", () => {
    const ancient = res({
      checkInDate: daysFromToday(-800),
      checkOutDate: daysFromToday(-797),
    });
    expect(isRepeat(upcoming, [upcoming, ancient])).toBe(false);
  });

  it("never counts the reservation against itself", () => {
    const past = res();
    expect(isRepeat(past, [past])).toBe(false);
  });

  it("still honours a manual override on top of the stricter auto rule", () => {
    const forced = { ...upcoming, manualFlagOverrides: { "Repeat Customer": true } };
    expect(getEffectiveFlags(forced, [forced, res({ isCancelled: true })])).toContain(
      "Repeat Customer",
    );
  });
});

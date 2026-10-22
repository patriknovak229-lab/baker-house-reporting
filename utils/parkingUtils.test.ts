import { describe, it, expect } from "vitest";
import { computeParking, getFreeSpaces } from "./parkingUtils";
import type { Reservation } from "@/types/reservation";

/**
 * Only a booking whose guest is actually coming holds a parking space. A
 * cancelled one used to keep its permanent space (BH-95080626, an unpaid Google
 * checkout Beds24 saved already cancelled, held space 15 for 10–17 Nov), which
 * showed in the calendar's parking row and hid the space from the drawer picker.
 */

/** Minimal valid Reservation; defaults to a K.102 stay 10–17 Nov 2026. */
function res(overrides: Partial<Reservation> = {}): Reservation {
  return {
    reservationNumber: "BH-1000",
    firstName: "Jane",
    lastName: "Doe",
    channel: "Direct-Web",
    room: "K.102",
    checkInDate: "2026-11-10",
    checkOutDate: "2026-11-17",
    reservationDate: "2026-10-22",
    bookingTimestamp: "2026-10-22T13:11:20Z",
    numberOfNights: 7,
    numberOfGuests: 2,
    email: "jane@example.com",
    phone: "+420123456789",
    price: 11969,
    nationality: "GB",
    cleaningStatus: "Pending",
    paymentStatus: "Paid",
    amountPaid: 11969,
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

const nonArrival = {
  flaggedAt: "2026-11-09T10:00:00Z",
  flaggedBy: "ops@bakerhouse.cz",
  originalPriceCzk: 11969,
};

describe("computeParking", () => {
  it("auto-assigns a live booking its room's permanent space", () => {
    const { byReservation, grid } = computeParking([res()]);
    expect(byReservation.get("BH-1000")).toEqual({ space: "15", type: "auto" });
    expect(grid.get("15")!.get("2026-11-10")?.reservationNumber).toBe("BH-1000");
    expect(grid.get("15")!.get("2026-11-16")?.reservationNumber).toBe("BH-1000");
    expect(grid.get("15")!.get("2026-11-17")).toBeUndefined(); // checkout day is free
  });

  it("gives a cancelled booking no space", () => {
    const { byReservation, grid } = computeParking([res({ isCancelled: true })]);
    expect(byReservation.has("BH-1000")).toBe(false);
    expect(grid.get("15")!.size).toBe(0);
  });

  it("ignores a manual override on a cancelled booking", () => {
    const { byReservation, grid } = computeParking([
      res({ isCancelled: true, parkingOverride: "153" }),
    ]);
    expect(byReservation.has("BH-1000")).toBe(false);
    expect(grid.get("153")!.size).toBe(0);
  });

  it("gives a non-arrival no space — the guest isn't coming", () => {
    const { byReservation, grid } = computeParking([
      res({ isCancelled: true, nonArrival, parkingOverride: "153" }),
    ]);
    expect(byReservation.has("BH-1000")).toBe(false);
    expect(grid.get("15")!.size).toBe(0);
    expect(grid.get("153")!.size).toBe(0);
  });

  it("lets a live booking take the space a cancelled one would have held", () => {
    const cancelled = res({ reservationNumber: "BH-95080626", isCancelled: true });
    const live = res({ reservationNumber: "BH-2000", checkInDate: "2026-11-12", checkOutDate: "2026-11-14" });
    const { byReservation } = computeParking([cancelled, live]);
    expect(byReservation.get("BH-2000")).toEqual({ space: "15", type: "auto" });
  });

  it("still drops refunded bookings", () => {
    const { byReservation } = computeParking([res({ paymentStatus: "Refunded" })]);
    expect(byReservation.has("BH-1000")).toBe(false);
  });

  it("flags a conflict when two live bookings want the same space", () => {
    const first = res({ reservationNumber: "BH-1", parkingOverride: "15", room: "K.201" });
    const second = res({ reservationNumber: "BH-2" });
    const { byReservation } = computeParking([first, second]);
    expect(byReservation.get("BH-1")).toEqual({ space: "15", type: "manual" });
    expect(byReservation.get("BH-2")?.conflict).toMatch(/occupied by reservation BH-1/);
  });
});

describe("getFreeSpaces", () => {
  it("offers a space only a cancelled booking would have taken", () => {
    const result = computeParking([res({ isCancelled: true })]);
    expect(getFreeSpaces(result, "2026-11-10", "2026-11-17")).toContain("15");
  });

  it("withholds a space a live booking holds", () => {
    const result = computeParking([res()]);
    expect(getFreeSpaces(result, "2026-11-10", "2026-11-17")).not.toContain("15");
    // …except from that booking's own picker.
    expect(getFreeSpaces(result, "2026-11-10", "2026-11-17", "BH-1000")).toContain("15");
  });
});

import { describe, expect, it } from "vitest";
import type { Reservation } from "@/types/reservation";
import { expandLinkedReservations } from "./expandReservations";

function mk(over: Partial<Reservation> = {}): Reservation {
  return {
    reservationNumber: "BH-95377263",
    room: "O.308 + K.106",
    linkedRooms: ["O.308", "K.106"],
    checkInDate: "2026-11-16",
    checkOutDate: "2026-11-18",
    numberOfNights: 2,
    price: 10_188,
    commissionAmount: 2_040,
    paymentChargeAmount: 250,
    amountPaid: 10_188,
    firstName: "Guest",
    lastName: "A",
    ...over,
  } as Reservation;
}

describe("expandLinkedReservations", () => {
  it("splits a package of equally priced apartments evenly", () => {
    const pieces = expandLinkedReservations([mk()]);
    expect(pieces.map((p) => [p.room, p.price])).toEqual([
      ["O.308", 5_094],
      ["K.106", 5_094],
    ]);
  });

  it("gives each separately priced apartment exactly its own Beds24 price (O.308 6 290.20 + Urban 3 897.58)", () => {
    const shares = [6290.2 / 10187.78, 3897.58 / 10187.78];
    const booking = mk({ price: 10187.78, amountPaid: 10187.78, linkedRoomShares: shares });
    const pieces = expandLinkedReservations([booking]);
    expect(pieces.map((p) => [p.room, p.price])).toEqual([
      ["O.308", 6290.2],
      ["K.106", 3897.58],
    ]);
    // Pieces add back up to the booking, to the haléř, for every money field.
    for (const f of ["price", "commissionAmount", "paymentChargeAmount", "amountPaid"] as const) {
      expect(pieces.reduce((s, p) => s + p[f], 0)).toBeCloseTo(booking[f], 2);
    }
    expect(pieces.every((p) => p.linkedRooms === undefined && p.linkedRoomShares === undefined)).toBe(true);
  });

  it("falls back to the even split when the shares don't line up with the rooms", () => {
    const pieces = expandLinkedReservations([mk({ linkedRoomShares: [1] })]);
    expect(pieces.map((p) => p.price)).toEqual([5_094, 5_094]);
  });
});

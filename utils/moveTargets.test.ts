import { describe, it, expect } from "vitest";
import { occupiersByRoom, unallocatedOverlapping } from "./moveTargets";
import type { Reservation } from "@/types/reservation";

function mk(over: Partial<Reservation>): Reservation {
  return {
    reservationNumber: "BH-x",
    room: "K.102",
    checkInDate: "2026-09-08",
    checkOutDate: "2026-09-10",
    firstName: "Guest",
    lastName: "X",
    channel: "Booking.com",
    ...over,
  } as unknown as Reservation;
}

// The reservation being moved: O.308, 8–10 Sept.
const target = mk({ reservationNumber: "BH-1", room: "O.308" });

describe("occupiersByRoom", () => {
  it("marks a room held by an overlapping active booking", () => {
    const other = mk({ reservationNumber: "BH-2", room: "K.202" });
    const occ = occupiersByRoom(target, [target, other]);
    expect([...occ.keys()]).toEqual(["K.202"]);
    expect(occ.get("K.202")).toEqual([other]);
  });

  it("IGNORES cancelled bookings — they hold no nights", () => {
    // The regression this whole module exists for: cancellations live in
    // `allReservations`, and counting them greyed out every option.
    const cancelled = mk({ reservationNumber: "BH-3", room: "K.202", isCancelled: true });
    const occ = occupiersByRoom(target, [target, cancelled]);
    expect(occ.size).toBe(0);
  });

  it("ignores a cancelled non-arrival too", () => {
    const nonArrival = mk({
      reservationNumber: "BH-4",
      room: "K.203",
      isCancelled: true,
      nonArrival: { reason: "guest could not come" },
    } as Partial<Reservation>);
    expect(occupiersByRoom(target, [target, nonArrival]).size).toBe(0);
  });

  it("counts blackouts — they really do block the unit", () => {
    const blackout = mk({ reservationNumber: "OV-1", room: "K.106", isBlackout: true });
    expect([...occupiersByRoom(target, [target, blackout]).keys()]).toEqual(["K.106"]);
  });

  it("counts every unit of a multi-unit package booking", () => {
    const pkg = mk({ reservationNumber: "BH-5", room: "K.202", linkedRooms: ["K.202", "K.203"] });
    const occ = occupiersByRoom(target, [target, pkg]);
    expect([...occ.keys()].sort()).toEqual(["K.202", "K.203"]);
  });

  it("excludes the reservation being moved", () => {
    expect(occupiersByRoom(target, [target]).size).toBe(0);
  });

  it("treats a same-day turnover as free, not occupied", () => {
    // Departs the morning our stay starts, and arrives the morning it ends.
    const before = mk({ reservationNumber: "BH-6", room: "K.202", checkInDate: "2026-09-05", checkOutDate: "2026-09-08" });
    const after = mk({ reservationNumber: "BH-7", room: "K.203", checkInDate: "2026-09-10", checkOutDate: "2026-09-12" });
    expect(occupiersByRoom(target, [target, before, after]).size).toBe(0);
  });

  it("catches a long stay that started well before this one", () => {
    const long = mk({ reservationNumber: "BH-8", room: "K.201", checkInDate: "2026-07-01", checkOutDate: "2026-10-01" });
    expect([...occupiersByRoom(target, [target, long]).keys()]).toEqual(["K.201"]);
  });

  it("lists every holder when a room is double-booked", () => {
    const a = mk({ reservationNumber: "BH-9", room: "K.202" });
    const b = mk({ reservationNumber: "BH-10", room: "K.202", checkInDate: "2026-09-09", checkOutDate: "2026-09-11" });
    expect(occupiersByRoom(target, [target, a, b]).get("K.202")).toHaveLength(2);
  });

  it("does not attribute a virtual-room booking to any physical unit", () => {
    const vr = mk({ reservationNumber: "BH-11", room: "1KK Urban Studios", isUnallocatedVR: true });
    const occ = occupiersByRoom(target, [target, vr]);
    // The type label is not a unit, so no unit gets greyed out on its account.
    expect(occ.has("K.102")).toBe(false);
    expect(occ.has("K.103")).toBe(false);
    expect(occ.has("K.106")).toBe(false);
  });
});

describe("unallocatedOverlapping", () => {
  it("returns overlapping unallocated bookings", () => {
    const vr = mk({ reservationNumber: "BH-11", room: "1KK Urban Studios", isUnallocatedVR: true });
    expect(unallocatedOverlapping(target, [target, vr])).toEqual([vr]);
  });

  it("skips cancelled and non-overlapping ones", () => {
    const cancelled = mk({ reservationNumber: "BH-12", room: "1KK Urban Studios", isUnallocatedVR: true, isCancelled: true });
    const elsewhere = mk({
      reservationNumber: "BH-13", room: "1KK Deluxe Studios", isUnallocatedVR: true,
      checkInDate: "2026-11-01", checkOutDate: "2026-11-03",
    });
    expect(unallocatedOverlapping(target, [target, cancelled, elsewhere])).toEqual([]);
  });
});

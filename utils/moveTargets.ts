/**
 * Which physical units are available as a move target for a given reservation.
 *
 * This is the picker's HINT, not the decision. `/api/bookings/relocate`
 * re-checks the target against live Beds24 before it moves anything, and that
 * check is the authority; this exists so the operator can see, before clicking,
 * what is free and who holds what.
 *
 * The whole file exists because getting the exclusions wrong is invisible in the
 * worst way: an over-broad "occupied" makes every option in the dropdown grey,
 * which reads as a dead button rather than as bad data.
 */
import type { Reservation } from "@/types/reservation";

/** Half-open night ranges [in, out) overlap iff each starts before the other ends. */
function overlaps(
  a: { checkInDate: string; checkOutDate: string },
  b: { checkInDate: string; checkOutDate: string },
): boolean {
  return a.checkInDate < b.checkOutDate && b.checkInDate < a.checkOutDate;
}

/**
 * Map of physical unit → the bookings holding it during `target`'s nights.
 * A unit absent from the map is free as far as the client can tell.
 *
 * Counted:
 *   - blackouts (they block the unit for real), and
 *   - every unit of a multi-unit package booking (`linkedRooms`).
 *
 * NOT counted:
 *   - `target` itself,
 *   - CANCELLED bookings. `allReservations` carries them on purpose (the table
 *     shows them with a Cancelled flag), but Beds24 has already released their
 *     nights and the server's availability check only looks at
 *     confirmed/new/request/black. Counting them made the picker mark every
 *     unit occupied on any busy date.
 *   - bookings still sitting on a virtual room. Their `room` is a room-TYPE
 *     label that matches no physical unit, so they can't be attributed —
 *     `unallocatedOverlapping` surfaces them separately instead of guessing.
 */
export function occupiersByRoom(
  target: Pick<Reservation, "reservationNumber" | "checkInDate" | "checkOutDate">,
  allReservations: Reservation[],
): Map<string, Reservation[]> {
  const byRoom = new Map<string, Reservation[]>();
  for (const r of allReservations) {
    if (r.reservationNumber === target.reservationNumber) continue;
    if (r.isCancelled) continue;
    if (!overlaps(r, target)) continue;
    const rooms = r.linkedRooms && r.linkedRooms.length > 0 ? r.linkedRooms : [r.room];
    for (const room of rooms) {
      const list = byRoom.get(room);
      if (list) list.push(r);
      else byRoom.set(room, [r]);
    }
  }
  return byRoom;
}

/**
 * Overlapping bookings Beds24 hasn't allocated to a unit yet. Nobody — not this
 * picker, not the server's per-roomId check — can tell which unit of the group
 * they will take, so a unit shown as free may still be claimed later. Advisory
 * only.
 */
export function unallocatedOverlapping(
  target: Pick<Reservation, "reservationNumber" | "checkInDate" | "checkOutDate">,
  allReservations: Reservation[],
): Reservation[] {
  return allReservations.filter(
    (r) =>
      r.isUnallocatedVR &&
      !r.isCancelled &&
      r.reservationNumber !== target.reservationNumber &&
      overlaps(r, target),
  );
}

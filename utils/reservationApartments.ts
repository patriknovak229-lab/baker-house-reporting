/**
 * The apartments of one reservation, each under the Beds24 booking the
 * cleaning app keys its cleaning by.
 *
 * Booking.com sells N rooms as N bookings; the app merges them into one
 * reservation under the master's number. The cleaning app does not merge — it
 * sees one cleaning per Beds24 booking, keyed "BH-<that booking's id>". So
 * anything reporting publishes for "this reservation" must be published under
 * every apartment's own number, or only the master's apartment gets it
 * (BH-93698209: the Weekly wine reached K.102 but never O.308 or K.103).
 *
 * Pure — imported by the drawer as well as the publish code.
 */
import type { Issue, Reservation } from "@/types/reservation";

export interface Apartment {
  /** The apartment's own Beds24 booking, "BH-<id>". */
  reservationNumber: string;
  /** Its unit, or its room-type label while Beds24 hasn't placed it. */
  room: string;
}

type ApartmentFields = Pick<
  Reservation,
  "reservationNumber" | "room" | "linkedRooms" | "apartmentReservationNumbers"
>;

/**
 * Every apartment of the reservation. A plain single-apartment booking is one
 * apartment under its own number.
 */
export function reservationApartments(r: ApartmentFields): Apartment[] {
  const numbers = r.apartmentReservationNumbers;
  const rooms = r.linkedRooms && r.linkedRooms.length > 0 ? r.linkedRooms : [r.room];
  if (!numbers || numbers.length !== rooms.length) {
    return [{ reservationNumber: r.reservationNumber, room: r.room }];
  }
  return numbers.map((reservationNumber, i) => ({ reservationNumber, room: rooms[i] }));
}

/** More than one apartment — the case where "which one?" is a real question. */
export function isMultiApartment(r: ApartmentFields): boolean {
  return reservationApartments(r).length > 1;
}

/**
 * Every booking number the reservation's cleaning-facing state is published
 * under: its own (manual cleanings are tagged with it) plus each apartment's.
 */
export function cleaningFeedNumbers(
  r: Pick<Reservation, "reservationNumber" | "apartmentReservationNumbers">,
): string[] {
  return [...new Set([r.reservationNumber, ...(r.apartmentReservationNumbers ?? [])])];
}

/**
 * The booking numbers one room task goes to: the apartment the operator picked,
 * else every apartment. A pick is kept even if that apartment has since left
 * the reservation — sending "extra towels for O.308" to the other rooms
 * instead would be wrong, and a cancelled booking simply has no cleaning.
 */
export function taskTargets(
  r: Pick<Reservation, "reservationNumber" | "apartmentReservationNumbers">,
  issue: Pick<Issue, "apartment">,
): string[] {
  if (issue.apartment) return [issue.apartment];
  const numbers = r.apartmentReservationNumbers;
  return numbers && numbers.length > 0 ? [...new Set(numbers)] : [r.reservationNumber];
}

/** The room a task's apartment is in right now, or null if it isn't one of them. */
export function apartmentRoom(r: ApartmentFields, apartment: string | undefined): string | null {
  if (!apartment) return null;
  return reservationApartments(r).find((a) => a.reservationNumber === apartment)?.room ?? null;
}

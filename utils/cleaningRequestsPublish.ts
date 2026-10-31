/**
 * Mid-stay cleaning requests → a cleaning in the cleaning app.
 *
 * The operator logs a "Mid-stay Cleaning" task in the drawer's Operations
 * block; this module publishes it so the cleaning app shows the cleaning on
 * that date, in that room, as one of its manual cleanings — assignable like
 * any other, tagged with the booking, with the request text as its note. Before
 * this the task was only a reminder, and the operator added the cleaning by
 * hand in the cleaning app.
 *
 * The cleaning app does NOT store these: it merges them into its manual-cleaning
 * list on every read (src/lib/storage.ts) and strips them on save, because it
 * saves that list whole from the browser and would otherwise overwrite them —
 * or keep a cleaning the operator had since deleted here. Reporting's own cost
 * engine merges them the same way (utils/variableCostsEngine.ts), so an
 * assigned cleaner is billed.
 *
 * Lifecycle: the request IS the cleaning. Deleting it removes the cleaning;
 * RESOLVING keeps it — resolving is how the operator clears the reminder once
 * it's done, and that must not erase a cleaning that happened (and its cost).
 * Only dates strictly inside the stay are published: the check-in and
 * check-out days already have their own cleanings.
 *
 * Shape: `{ "BH-<booking>": RequestedCleaning[] }`, keyed by the booking the
 * cleaning app sees for that apartment (utils/reservationApartments).
 *
 * Two writers, same pattern as the ops-task map: the bookings sync rewrites the
 * whole map (authoritative — a cancelled stay drops out on its own), and a
 * drawer save patches the one reservation.
 */
import { getRedis } from "@/utils/beds24Reservations";
import { physicalRoomIdForName } from "@/utils/roomAllocation";
import { cleaningFeedNumbers, reservationApartments, taskTargets } from "@/utils/reservationApartments";
import { isMidStayDate } from "@/utils/midStayCleaning";
import type { Issue, Reservation } from "@/types/reservation";

export const CLEANING_REQUESTS_KEY = "baker:reservation-cleaning-requests";

/** One requested mid-stay cleaning as the cleaning app consumes it. */
export interface RequestedCleaning {
  /** The request's id (the drawer task) — stable across publishes. */
  id: string;
  /** YYYY-MM-DD, strictly inside the stay. */
  date: string;
  /** Beds24 roomId of the unit (the cleaning app keys cleanings by it). */
  roomId: number;
  room: string;
  /** The operator's text, verbatim; may be empty. */
  text: string;
}

type ReservationFields = Pick<
  Reservation,
  | "reservationNumber"
  | "room"
  | "linkedRooms"
  | "apartmentReservationNumbers"
  | "checkInDate"
  | "checkOutDate"
>;

/**
 * One reservation's requested cleanings, by the booking number each goes to.
 * An apartment not yet placed in a unit has no room to clean, so it's skipped
 * until Beds24 (or the resolver) places it.
 */
export function cleaningRequestsByBooking(
  r: ReservationFields,
  issues: Issue[] | undefined,
): Record<string, RequestedCleaning[]> {
  const out: Record<string, RequestedCleaning[]> = {};
  const roomOf = new Map(reservationApartments(r).map((a) => [a.reservationNumber, a.room]));
  for (const i of issues ?? []) {
    if (i.category !== "cleaning" || !isMidStayDate(r, i.actionableDate)) continue;
    for (const target of taskTargets(r, i)) {
      const room = roomOf.get(target);
      const roomId = room ? physicalRoomIdForName(room) : null;
      if (!room || roomId === null) continue;
      (out[target] ??= []).push({
        id: i.id,
        date: i.actionableDate,
        roomId,
        room,
        text: i.text?.trim() ?? "",
      });
    }
  }
  return out;
}

/** Whole map — the authoritative pass. `reservations` excludes cancelled stays. */
export function buildCleaningRequestsMap(
  overrides: Record<string, { issues?: Issue[] } | undefined>,
  reservations: ReservationFields[],
): Record<string, RequestedCleaning[]> {
  const map: Record<string, RequestedCleaning[]> = {};
  for (const r of reservations) {
    const byBooking = cleaningRequestsByBooking(r, overrides[r.reservationNumber]?.issues);
    for (const [bookingNumber, list] of Object.entries(byBooking)) {
      map[bookingNumber] = [...(map[bookingNumber] ?? []), ...list];
    }
  }
  return map;
}

/** Patch one reservation's entries; an empty list removes the entry. */
export async function publishCleaningRequestsEntry(
  r: ReservationFields,
  issues: Issue[] | undefined,
): Promise<Record<string, RequestedCleaning[]>> {
  const byBooking = cleaningRequestsByBooking(r, issues);
  const redis = getRedis();
  if (!redis) return byBooking;
  const map = (await redis.get<Record<string, RequestedCleaning[]>>(CLEANING_REQUESTS_KEY)) ?? {};
  for (const n of new Set([...cleaningFeedNumbers(r), ...Object.keys(byBooking)])) {
    if (byBooking[n]?.length) map[n] = byBooking[n];
    else delete map[n];
  }
  await redis.set(CLEANING_REQUESTS_KEY, map);
  return byBooking;
}

/** Drop a cancelled reservation's requests. */
export async function removeCleaningRequestsEntry(
  r: Pick<Reservation, "reservationNumber" | "apartmentReservationNumbers">,
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const map = (await redis.get<Record<string, RequestedCleaning[]>>(CLEANING_REQUESTS_KEY)) ?? {};
  const present = cleaningFeedNumbers(r).filter((n) => n in map);
  if (present.length === 0) return;
  for (const n of present) delete map[n];
  await redis.set(CLEANING_REQUESTS_KEY, map);
}

/** A requested cleaning as a manual-cleaning record (cleaning app's shape). */
export interface RequestedManualCleaning {
  id: string;
  date: string;
  roomId: string;
  roomName: string;
  reservationNumber: string;
  note?: string;
}

/** Id prefix shared with the cleaning app, which uses it to tell these apart. */
export const REQUESTED_CLEANING_ID_PREFIX = "request-";

/**
 * The published requests as manual-cleaning records, minus any date|room the
 * operator already has a real manual cleaning on (added by hand). Mirrors
 * `requestedManualCleanings` in the cleaning app's src/lib/storage.ts — keep
 * the two in step.
 */
export function requestedManualCleanings(
  requests: Record<string, RequestedCleaning[]> | null | undefined,
  stored: { date?: string; roomId?: string }[],
): RequestedManualCleaning[] {
  if (!requests) return [];
  const taken = new Set(stored.map((e) => `${e.date}|${e.roomId}`));
  const out: RequestedManualCleaning[] = [];
  for (const [reservationNumber, list] of Object.entries(requests)) {
    for (const c of list ?? []) {
      const key = `${c.date}|${c.roomId}`;
      if (!c.date || !c.roomId || taken.has(key)) continue;
      taken.add(key);
      out.push({
        id: `${REQUESTED_CLEANING_ID_PREFIX}${c.id}-${c.roomId}`,
        date: c.date,
        roomId: String(c.roomId),
        roomName: c.room,
        reservationNumber,
        ...(c.text ? { note: c.text } : {}),
      });
    }
  }
  return out;
}

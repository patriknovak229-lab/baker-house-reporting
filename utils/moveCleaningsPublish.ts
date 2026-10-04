/**
 * Mid-stay room moves → a cleaning of the vacated unit, in the cleaning app.
 *
 * The cleaning app builds its schedule from Beds24 checkouts. After a mid-stay
 * move Beds24 holds ONE booking in the new unit, so the old unit's real turnover
 * (the day the guest moved out) is invisible to it. Reporting knows the move
 * date (utils/roomSegments.ts) and publishes the implied cleaning here; the
 * cleaning app adds it to its schedule as an automatic cleaning, which the
 * operator can dismiss or re-date there like any other — that's why the move's
 * Telegram alert points them at the cleaning app.
 *
 * Shape: `{ "BH-<id>": MoveCleaningEntry[] }`.
 *
 * Two writers, same pattern as the ops-task map: the bookings sync rewrites the
 * whole map (authoritative — a cancelled or re-moved stay drops out on its own),
 * and the relocate route patches the one reservation right after a move so the
 * cleaning shows up without waiting for a sync.
 */
import { getRedis } from "@/utils/beds24Reservations";
import { physicalRoomIdForName } from "@/utils/roomAllocation";
import { moveCleaningsFor } from "@/utils/roomSegments";
import type { Reservation } from "@/types/reservation";

export const MOVE_CLEANINGS_KEY = "baker:room-move-cleanings";

/** One vacated-unit cleaning as the cleaning app consumes it. */
export interface MoveCleaningEntry {
  /** YYYY-MM-DD — the move date. */
  date: string;
  /** Beds24 roomId of the vacated unit (the cleaning app keys cleanings by it). */
  roomId: number;
  room: string;
  /** Where the guest went — context for the cleaner. */
  toRoom: string;
  /** First night spent in the vacated unit. */
  stayFrom: string;
  guestName: string;
}

export function moveCleaningEntries(
  r: Pick<Reservation, "roomSegments" | "firstName" | "lastName">,
): MoveCleaningEntry[] {
  const guestName = `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim();
  return moveCleaningsFor(r).flatMap((c) => {
    const roomId = physicalRoomIdForName(c.room);
    return roomId === null ? [] : [{ ...c, roomId, guestName }];
  });
}

/** Whole map from the live reservation set — the authoritative pass. */
export function buildMoveCleaningsMap(reservations: Reservation[]): Record<string, MoveCleaningEntry[]> {
  const map: Record<string, MoveCleaningEntry[]> = {};
  for (const r of reservations) {
    if (r.isCancelled || !r.roomSegments) continue;
    const entries = moveCleaningEntries(r);
    if (entries.length > 0) map[r.reservationNumber] = entries;
  }
  return map;
}

/** Patch one reservation's entry; an empty list removes it. */
export async function publishMoveCleaningsEntry(
  reservationNumber: string,
  entries: MoveCleaningEntry[],
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const map = (await redis.get<Record<string, MoveCleaningEntry[]>>(MOVE_CLEANINGS_KEY)) ?? {};
  if (entries.length > 0) map[reservationNumber] = entries;
  else delete map[reservationNumber];
  await redis.set(MOVE_CLEANINGS_KEY, map);
}

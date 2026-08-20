/**
 * Postgres repository for room-move notices (see lib/db/schema/roomMoves.ts).
 *
 * Postgres-only — a new domain, so there is no `STORE_*` redis|dual|postgres
 * flag and no Redis path.
 *
 * Writes are BEST-EFFORT by design: the caller has already mutated a real
 * Beds24 booking by the time it logs, so a failed insert must never turn a
 * successful move into an error response. `recordRoomMoves` swallows and logs
 * instead of throwing — the move is the transaction, the notice is the receipt.
 */
import { and, desc, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { roomMoves } from '@/lib/db/schema';
import type { RoomMoveInsert, RoomMoveRow } from '@/lib/db/schema/roomMoves';

/** Cap on the open-notice read — the alert bar is a to-do list, not an archive. */
const OPEN_LIMIT = 100;

/** Stable, readable id: one per (booking, millisecond). */
export function roomMoveId(reservationNumber: string, at = Date.now()): string {
  const booking = reservationNumber.replace(/^BH-/, '');
  return `MV-${booking}-${at.toString(36)}`;
}

/** Append notices. Never throws — see the module note. */
export async function recordRoomMoves(rows: RoomMoveInsert[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    await db.insert(roomMoves).values(rows).onConflictDoNothing();
  } catch (err) {
    console.error('[roomMoves] failed to record move notice(s):', err);
  }
}

/** Undismissed notices, newest first. */
export async function listOpenRoomMoves(): Promise<RoomMoveRow[]> {
  return db
    .select()
    .from(roomMoves)
    .where(isNull(roomMoves.dismissedAt))
    .orderBy(desc(roomMoves.movedAt))
    .limit(OPEN_LIMIT);
}

/**
 * Dismiss notices. `ids` empty + `all` true dismisses every open notice.
 * Returns how many rows this call actually closed (already-dismissed rows are
 * left alone, so a double-click can't rewrite the original acknowledgement).
 */
export async function dismissRoomMoves(
  ids: string[],
  by: string,
  all = false,
): Promise<number> {
  if (!all && ids.length === 0) return 0;
  const stamp = { dismissedAt: sql`now()`, dismissedBy: by };
  const rows = await db
    .update(roomMoves)
    .set(stamp)
    .where(all ? isNull(roomMoves.dismissedAt) : and(isNull(roomMoves.dismissedAt), inArray(roomMoves.id, ids)))
    .returning({ id: roomMoves.id });
  return rows.length;
}

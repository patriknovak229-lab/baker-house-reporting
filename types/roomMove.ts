/**
 * Room-move notice as the CLIENT sees it — the JSON shape of
 * `GET /api/bookings/room-moves`.
 *
 * Deliberately not the Drizzle row type from `lib/db/schema/roomMoves`: that
 * one types the timestamps as `Date`, which they stop being the moment they
 * cross JSON. It also lives in a module that pulls in `drizzle-orm/pg-core`,
 * and this file is imported by client components (see the import-chain warning
 * in `lib/db.ts`).
 */

/** A booking a forced move was knowingly stacked on top of. */
export interface RoomMoveConflictInfo {
  reservationNumber: string;
  arrival: string;
  departure: string;
}

export interface RoomMoveNotice {
  id: string;
  reservationNumber: string;
  guestName: string | null;
  fromRoom: string;
  toRoom: string;
  checkInDate: string | null;
  checkOutDate: string | null;
  /** ISO timestamp. */
  movedAt: string;
  movedBy: string;
  /** 'manual' = drawer move, 'resolver' = unallocated-reshuffle leg. */
  source: 'manual' | 'resolver';
  inHouse: boolean;
  /** Pushed into an occupied unit on purpose — a double-booking still stands. */
  forced: boolean;
  conflicts: RoomMoveConflictInfo[] | null;
  reason: string | null;
}

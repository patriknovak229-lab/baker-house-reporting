import { pgTable, text, boolean, date, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

/**
 * Room-move notices — the operator-facing log of every reservation this app has
 * physically reassigned in Beds24.
 *
 * WHY THIS IS STORED SERVER-SIDE AND NOT IN COMPONENT STATE
 * --------------------------------------------------------
 * A room move has consequences OUTSIDE the app: the guest may already hold a
 * door code for the old unit, the cleaner's sheet for the day is wrong, and a
 * forced move (see `forced`) deliberately leaves a real double-booking in
 * Beds24 that someone has to finish resolving. The notice therefore has to
 * survive a reload, a different browser and a different operator — it is a
 * hand-off, not a toast. It clears only when an operator explicitly dismisses
 * it, which is the acknowledgement that the physical follow-up is done.
 *
 * NOT a Redis→Postgres cutover: this domain is new and Postgres-only, so it has
 * no `STORE_*` redis|dual|postgres flag.
 *
 * Rows are append-only; dismissal is an in-place stamp so the audit trail of who
 * moved what (and who signed it off) stays intact.
 */
export const roomMoves = pgTable(
  'room_moves',
  {
    /** `MV-<bookingId>-<base36 ms>`. */
    id: text('id').primaryKey(),
    /** "BH-<bookingId>" — the reservation that was moved. */
    reservationNumber: text('reservation_number').notNull(),
    /** Guest name at move time, so the notice reads without a booking lookup. */
    guestName: text('guest_name'),
    fromRoom: text('from_room').notNull(),
    toRoom: text('to_room').notNull(),
    checkInDate: date('check_in_date', { mode: 'string' }),
    checkOutDate: date('check_out_date', { mode: 'string' }),
    movedAt: timestamp('moved_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    /** Operator's account email (from the auth guard, never the client). */
    movedBy: text('moved_by').notNull(),
    /**
     * 'manual'   — operator's free-form move from the reservation drawer.
     * 'resolver' — a leg of the within-type unallocated-booking reshuffle.
     */
    source: text('source').$type<RoomMoveSource>().notNull(),
    /** Guest had already arrived — someone has to move them physically. */
    inHouse: boolean('in_house').notNull().default(false),
    /**
     * true = "ignore occupied" was used, so this move was pushed into a unit
     * that was NOT free and Beds24 now holds an intentional double-booking.
     * `conflicts` records what it collided with at the time.
     */
    forced: boolean('forced').notNull().default(false),
    conflicts: jsonb('conflicts').$type<RoomMoveConflict[]>(),
    reason: text('reason'),
    /** null = still showing in the operator's alert bar. */
    dismissedAt: timestamp('dismissed_at', { withTimezone: true, mode: 'date' }),
    dismissedBy: text('dismissed_by'),
  },
  (t) => [
    // The only hot query is "open notices, newest first".
    index('room_moves_open_idx').on(t.dismissedAt, t.movedAt),
  ],
);

export type RoomMoveSource = 'manual' | 'resolver';

/** A booking the forced move was knowingly stacked on top of. */
export interface RoomMoveConflict {
  reservationNumber: string;
  arrival: string;
  departure: string;
}

export type RoomMoveRow = typeof roomMoves.$inferSelect;
export type RoomMoveInsert = typeof roomMoves.$inferInsert;

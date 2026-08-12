import { pgTable, text, numeric, boolean, date, timestamp, integer, bigint, jsonb, index } from 'drizzle-orm/pg-core';
// Type-only import (erased at build) — relative path so the drizzle-kit CLI
// bundler doesn't need tsconfig path-alias resolution.
import type { Channel, CleaningStatus, PaymentStatus, RateType, GuestRating } from '../../../types/reservation';

/**
 * Bookings mirror — a DERIVED READ-MODEL, not a migrated Redis key.
 *
 * Every other table in this schema is an authoritative domain moved off a Redis
 * key. This one is different: `baker:beds24-bookings-cache` stays the source of
 * truth and this table is a disposable, rebuildable projection of the normalized
 * Beds24 shape (CQRS read-model). It is NEVER the authority for money — it exists
 * so Performance / Commission / reconciliation can eventually `SELECT` instead of
 * each re-triggering the full Beds24 sync + re-normalizing on every page load.
 * `scripts/rebuild/bookings-mirror.ts` can recreate it from the raw cache at any
 * time; dropping the table loses nothing.
 *
 * What is stored: exactly `mapToReservation()` output (+ the synced guest review),
 * i.e. the Beds24-derived normalized reservation.
 *
 * What is deliberately NOT baked in — these stay read-time overlays so the mirror
 * never needs rewriting when they change, and so operator edits stay authoritative:
 *   - `reservation_overrides` (notes, ratings, invoice data, non-arrival, issues…)
 *   - the Stripe-fee roll-up from `additional_payments` into paymentChargeAmount
 *     (a Stripe webhook can change it with no bookings sync in between, so a
 *     mirrored value would go stale) — `payment_charge_amount` here is the
 *     pre-roll-up Beds24 value (0 for OTA bookings)
 *   - `overlapWith` (derivable from the mirror set itself)
 *
 * Money → unbounded numeric (see the Wave-2 precision lesson). Dates/timestamps
 * are nullable because the normalizer emits "" for absent Beds24 values.
 */
export type BookingsMirrorSource =
  /** Derived from a Beds24 /bookings record (reservation_number `BH-<id>`). */
  | 'beds24-booking'
  /** Synthetic blackout row from the Beds24 inventory calendar (`OV-<room>-<from>-<to>`). */
  | 'inventory-override';

export const bookingsMirror = pgTable(
  'bookings_mirror',
  {
    reservationNumber: text('reservation_number').primaryKey(),
    source: text('source').$type<BookingsMirrorSource>().notNull(),
    // Beds24 booking id (null for inventory-override rows, which have no booking).
    beds24Id: bigint('beds24_id', { mode: 'number' }),
    // Channel's own reference — the join key for synced guest reviews.
    apiReference: text('api_reference'),
    channel: text('channel').$type<Channel>().notNull(),
    room: text('room').notNull(),
    linkedRooms: text('linked_rooms').array(),
    checkInDate: date('check_in_date', { mode: 'string' }),
    checkOutDate: date('check_out_date', { mode: 'string' }),
    reservationDate: date('reservation_date', { mode: 'string' }),
    bookingTimestamp: timestamp('booking_timestamp', { withTimezone: true, mode: 'date' }),
    modifiedAt: timestamp('modified_at', { withTimezone: true, mode: 'date' }),
    numberOfNights: integer('number_of_nights').notNull(),
    numberOfGuests: integer('number_of_guests').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    email: text('email').notNull(),
    phone: text('phone').notNull(),
    nationality: text('nationality').notNull(),
    price: numeric('price').notNull(),
    amountPaid: numeric('amount_paid').notNull(),
    commissionAmount: numeric('commission_amount').notNull(),
    // Beds24-derived only — the additional_payments Stripe-fee roll-up is applied
    // at read time, NOT stored here (see the header note).
    paymentChargeAmount: numeric('payment_charge_amount').notNull(),
    paymentStatus: text('payment_status').$type<PaymentStatus>().notNull(),
    // Date-derived in the normalizer (departure < today), so it ages with the
    // mirror rather than being a stable fact — recompute on read if it matters.
    cleaningStatus: text('cleaning_status').$type<CleaningStatus>().notNull(),
    rateType: text('rate_type').$type<RateType>(),
    status: text('status'),
    isCancelled: boolean('is_cancelled').notNull().default(false),
    isBlackout: boolean('is_blackout').notNull().default(false),
    isUnallocatedVr: boolean('is_unallocated_vr').notNull().default(false),
    blackoutCreatedBy: text('blackout_created_by'),
    blackoutReason: text('blackout_reason'),
    syncedRating: jsonb('synced_rating').$type<GuestRating>(),
    /** When this row was last written by a sync — the mirror's freshness signal. */
    syncedAt: timestamp('synced_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [
    // Occupancy / performance scan by stay window; `source` for the scoped replace.
    index('bookings_mirror_check_in_idx').on(t.checkInDate),
    index('bookings_mirror_check_out_idx').on(t.checkOutDate),
    index('bookings_mirror_source_idx').on(t.source),
  ],
);

export type BookingsMirrorRow = typeof bookingsMirror.$inferSelect;
export type BookingsMirrorInsert = typeof bookingsMirror.$inferInsert;

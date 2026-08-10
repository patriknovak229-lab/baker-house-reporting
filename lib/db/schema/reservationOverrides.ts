import { pgTable, text, jsonb } from 'drizzle-orm/pg-core';

/**
 * Locally-managed reservation overlay — was Redis JSON map
 * `baker:reservation-overrides` (reservationNumber → partial editable fields:
 * notes, customer-flag overrides, invoice/billing data, additionalEmail,
 * ratings, non-arrival, issues[], invoiceModifications[], parkingOverride, …).
 *
 * The stored value is a free-form partial object (the local-state route writes
 * an arbitrary `fields` object), so it's kept faithfully as a single jsonb blob
 * per reservation — exactly the shape the app reads and merges onto bookings.
 * (Hard-rule domain: Phase A is a storage copy only; no reads flip until sign-off.)
 */
export const reservationOverrides = pgTable('reservation_overrides', {
  reservationNumber: text('reservation_number').primaryKey(),
  data: jsonb('data').notNull(),
});

export type ReservationOverrideRow = typeof reservationOverrides.$inferSelect;
export type ReservationOverrideInsert = typeof reservationOverrides.$inferInsert;

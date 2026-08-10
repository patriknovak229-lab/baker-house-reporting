import { pgTable, text, numeric, date, timestamp } from 'drizzle-orm/pg-core';
// Type-only imports (erased at build) — relative so the drizzle-kit CLI
// bundler needs no tsconfig path-alias resolution.
import type { VoucherDiscountType, VoucherStatus } from '../../../types/voucher';

/**
 * Discount vouchers — was Redis JSON array `baker:vouchers`.
 *
 * Notes:
 *  - `code` is NOT unique: a 'deleted' voucher can share a code with an active
 *    one (dup check in the route only considers non-deleted), so no unique
 *    constraint here.
 *  - `expires_at` is a calendar DATE (YYYY-MM-DD, 12 months out), not a
 *    timestamp — the route stores it via `.toISOString().slice(0,10)`.
 *  - `value` is CZK (fixed) or 1–100 (percentage); numeric to avoid float drift.
 */
export const vouchers = pgTable('vouchers', {
  id: text('id').primaryKey(),
  code: text('code').notNull(),
  discountType: text('discount_type').$type<VoucherDiscountType>().notNull(),
  value: numeric('value', { precision: 14, scale: 2 }).notNull(),
  status: text('status').$type<VoucherStatus>().notNull(),
  reservationNumber: text('reservation_number'),
  redeemedOnReservationNumber: text('redeemed_on_reservation_number'),
  guestName: text('guest_name'),
  guestEmail: text('guest_email'),
  guestPhone: text('guest_phone'),
  expiresAt: date('expires_at', { mode: 'string' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  createdBy: text('created_by').notNull(),
  usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
});

export type VoucherRow = typeof vouchers.$inferSelect;
export type VoucherInsert = typeof vouchers.$inferInsert;

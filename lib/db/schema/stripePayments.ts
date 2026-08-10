import { pgTable, text, numeric, timestamp } from 'drizzle-orm/pg-core';

/** Completed Stripe Checkout mirror — was Redis JSON array `baker:stripe-payments`. */
export const stripePaymentLog = pgTable('stripe_payment_log', {
  sessionId: text('session_id').primaryKey(),
  description: text('description').notNull(),
  amountCzk: numeric('amount_czk').notNull(),
  guestEmail: text('guest_email'),
  guestPhone: text('guest_phone'),
  guestName: text('guest_name'),
  reservationNumber: text('reservation_number'),
  paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }).notNull(),
});

export type StripePaymentLogRow = typeof stripePaymentLog.$inferSelect;
export type StripePaymentLogInsert = typeof stripePaymentLog.$inferInsert;

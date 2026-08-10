import { pgTable, text, numeric, integer, date, timestamp } from 'drizzle-orm/pg-core';
import type { SplitPaymentStatus } from '../../../types/splitPayment';

/** Scheduled split payments — was Redis JSON array `baker:scheduled-split-payments`. */
export const splitPayments = pgTable('split_payments', {
  id: text('id').primaryKey(),
  reservationNumber: text('reservation_number').notNull(),
  paymentNumber: integer('payment_number').notNull(),
  totalPayments: integer('total_payments').notNull(),
  description: text('description').notNull(),
  amountCzk: numeric('amount_czk').notNull(),
  sendDate: date('send_date', { mode: 'string' }).notNull(),
  guestEmail: text('guest_email'),
  guestName: text('guest_name'),
  guestPhone: text('guest_phone'),
  status: text('status').$type<SplitPaymentStatus>().notNull(),
  stripeSessionId: text('stripe_session_id'),
  sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
  failureReason: text('failure_reason'),
  failureCount: integer('failure_count'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
});

export type SplitPaymentRow = typeof splitPayments.$inferSelect;
export type SplitPaymentInsert = typeof splitPayments.$inferInsert;

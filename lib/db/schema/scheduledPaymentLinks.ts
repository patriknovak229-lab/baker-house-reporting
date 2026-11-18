import { pgTable, text, numeric, boolean, integer, date, timestamp, jsonb } from 'drizzle-orm/pg-core';
import type { PaymentAllocation } from '../../../types/additionalPayment';
import type { ScheduledLinkStatus } from '../../../types/scheduledPaymentLink';

/** Payment links scheduled for a later send (types/scheduledPaymentLink.ts). Postgres-only. */
export const scheduledPaymentLinks = pgTable('scheduled_payment_links', {
  id: text('id').primaryKey(),
  reservationNumber: text('reservation_number').notNull(),
  allocations: jsonb('allocations').$type<PaymentAllocation[]>().notNull(),
  amountCzk: numeric('amount_czk').notNull(),
  description: text('description').notNull(),
  isMainPayment: boolean('is_main_payment').notNull().default(false),
  sendDate: date('send_date', { mode: 'string' }).notNull(),
  guestEmail: text('guest_email').notNull(),
  guestName: text('guest_name'),
  guestPhone: text('guest_phone'),
  status: text('status').$type<ScheduledLinkStatus>().notNull(),
  paymentId: text('payment_id'), // → additional_payments.id (current Stripe session)
  sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
  reminderSentAt: timestamp('reminder_sent_at', { withTimezone: true, mode: 'date' }),
  alertReason: text('alert_reason'),
  alertAt: timestamp('alert_at', { withTimezone: true, mode: 'date' }),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true, mode: 'date' }),
  failureCount: integer('failure_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  createdBy: text('created_by'),
});

export type ScheduledPaymentLinkRow = typeof scheduledPaymentLinks.$inferSelect;
export type ScheduledPaymentLinkInsert = typeof scheduledPaymentLinks.$inferInsert;

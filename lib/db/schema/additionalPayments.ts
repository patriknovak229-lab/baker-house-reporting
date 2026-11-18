import { pgTable, text, numeric, boolean, timestamp, jsonb } from 'drizzle-orm/pg-core';
import type { AdditionalPaymentStatus, PaymentAllocation } from '../../../types/additionalPayment';

/** Stripe additional payments — was Redis JSON array `baker:additional-payments`. */
export const additionalPayments = pgTable('additional_payments', {
  id: text('id').primaryKey(), // Stripe sessionId
  reservationNumber: text('reservation_number').notNull(),
  description: text('description').notNull(),
  amountCzk: numeric('amount_czk').notNull(),
  guestEmail: text('guest_email'),
  guestName: text('guest_name'),
  status: text('status').$type<AdditionalPaymentStatus>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }),
  invoiceId: text('invoice_id'), // → revenue_invoices.id
  stripeFeeCzk: numeric('stripe_fee_czk'),
  isMainPayment: boolean('is_main_payment'),
  /** Per-booking split when one link covers a linked stay (utils/paymentAllocations). */
  allocations: jsonb('allocations').$type<PaymentAllocation[]>(),
});

/** Refund events — was the embedded `AdditionalPayment.refunds[]`; own table (amounts get summed). */
export const paymentRefunds = pgTable('payment_refunds', {
  id: text('id').primaryKey(), // Stripe re_…
  additionalPaymentId: text('additional_payment_id').notNull(), // → additional_payments.id
  amountCzk: numeric('amount_czk').notNull(),
  refundedAt: timestamp('refunded_at', { withTimezone: true, mode: 'date' }).notNull(),
  reason: text('reason'),
  refundedBy: text('refunded_by'),
  status: text('status').$type<'pending' | 'succeeded' | 'failed' | 'canceled'>().notNull(),
  failureReason: text('failure_reason'),
  /** Booking the refund is for on a combined payment (utils/paymentAllocations). */
  reservationNumber: text('reservation_number'),
});

export type AdditionalPaymentRow = typeof additionalPayments.$inferSelect;
export type AdditionalPaymentInsert = typeof additionalPayments.$inferInsert;
export type PaymentRefundRow = typeof paymentRefunds.$inferSelect;
export type PaymentRefundInsert = typeof paymentRefunds.$inferInsert;

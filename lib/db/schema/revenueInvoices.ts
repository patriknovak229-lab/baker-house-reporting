import { pgTable, text, numeric, date, timestamp } from 'drizzle-orm/pg-core';
import type {
  RevenueInvoiceSource,
  RevenueInvoiceCategory,
  RevenueInvoiceStatus,
} from '../../../types/revenueInvoice';

/** Revenue invoices — was Redis JSON array `baker:revenue-invoices`. */
export const revenueInvoices = pgTable('revenue_invoices', {
  id: text('id').primaryKey(),
  sourceType: text('source_type').$type<RevenueInvoiceSource>().notNull(),
  category: text('category').$type<RevenueInvoiceCategory>().notNull(),
  status: text('status').$type<RevenueInvoiceStatus>().notNull(),
  invoiceNumber: text('invoice_number').notNull(),
  invoiceDate: date('invoice_date', { mode: 'string' }).notNull(),
  dueDate: date('due_date', { mode: 'string' }),
  amountCzk: numeric('amount_czk').notNull(),
  reservationNumber: text('reservation_number'),
  guestName: text('guest_name'),
  clientName: text('client_name'),
  description: text('description'),
  bankTransactionId: text('bank_transaction_id'),
  reconciledAt: timestamp('reconciled_at', { withTimezone: true, mode: 'date' }),
  settlementGroupId: text('settlement_group_id'),
  driveFileId: text('drive_file_id'),
  driveFileName: text('drive_file_name'),
  driveUrl: text('drive_url'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
});

export type RevenueInvoiceRow = typeof revenueInvoices.$inferSelect;
export type RevenueInvoiceInsert = typeof revenueInvoices.$inferInsert;

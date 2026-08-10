import { pgTable, text, bigint, integer, timestamp } from 'drizzle-orm/pg-core';
import type { InvoiceRequestStatus } from '../../../types/invoiceRequest';

/** Auto-detected guest invoice requests — was Redis JSON array `baker:invoice-requests`. */
export const invoiceRequests = pgTable('invoice_requests', {
  id: text('id').primaryKey(),
  reservationNumber: text('reservation_number').notNull(),
  // Beds24 message id — de-dup key. bigint (mode number) fits the id range.
  beds24MessageId: bigint('beds24_message_id', { mode: 'number' }).notNull(),
  rawMessage: text('raw_message').notNull(),
  companyName: text('company_name'),
  companyAddress: text('company_address'),
  ico: text('ico'),
  dic: text('dic'),
  email: text('email'),
  detectedAt: timestamp('detected_at', { withTimezone: true, mode: 'date' }).notNull(),
  status: text('status').$type<InvoiceRequestStatus>().notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
  lastAskedAt: timestamp('last_asked_at', { withTimezone: true, mode: 'date' }),
  asksCount: integer('asks_count'),
  lastExtractedFromAt: timestamp('last_extracted_from_at', { withTimezone: true, mode: 'date' }),
});

export type InvoiceRequestRow = typeof invoiceRequests.$inferSelect;
export type InvoiceRequestInsert = typeof invoiceRequests.$inferInsert;

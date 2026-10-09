import { pgTable, text, numeric, date, boolean, timestamp } from 'drizzle-orm/pg-core';
import type { SupplierInvoiceStatus, SupplierInvoiceSource, SupplierDocumentType } from '../../../types/supplierInvoice';

/**
 * Supplier invoices — was Redis JSON array `baker:supplier-invoices`.
 * Phase A: faithful migration. Dedup unique constraints (gmail_message_id,
 * icloud_file_name, normalized invoice_number+ico) are deferred to cutover,
 * once we've confirmed the legacy blob has no duplicates.
 */
export const supplierInvoices = pgTable('supplier_invoices', {
  id: text('id').primaryKey(),
  supplierName: text('supplier_name').notNull(),
  supplierIco: text('supplier_ico'),
  invoiceNumber: text('invoice_number').notNull(),
  invoiceDate: date('invoice_date', { mode: 'string' }).notNull(),
  duzpDate: date('duzp_date', { mode: 'string' }),
  dueDate: date('due_date', { mode: 'string' }),
  amountCzk: numeric('amount_czk').notNull(),
  vatAmountCzk: numeric('vat_amount_czk'),
  invoiceCurrency: text('invoice_currency'),
  category: text('category').notNull(),
  rooms: text('rooms').array(),
  description: text('description'),
  status: text('status').$type<SupplierInvoiceStatus>().notNull(),
  sourceType: text('source_type').$type<SupplierInvoiceSource>().notNull(),
  driveFileId: text('drive_file_id'),
  driveFileName: text('drive_file_name'),
  driveUrl: text('drive_url'),
  gmailMessageId: text('gmail_message_id'),
  icloudFileName: text('icloud_file_name'),
  autoProcessed: boolean('auto_processed'),
  // Drive-folder source dedup (the raw inbox file's id) — was silently dropped before this column existed
  driveSourceFileId: text('drive_source_file_id'),
  // Credit notes (dobropis): negative amounts, linked to the original invoice
  documentType: text('document_type').$type<SupplierDocumentType>(),
  originalInvoiceNumber: text('original_invoice_number'),
  relatedInvoiceId: text('related_invoice_id'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  // Phase 2 reconciliation refs (point at bank_transactions / settlement_groups) — plain text for now
  bankTransactionId: text('bank_transaction_id'),
  reconciledAt: timestamp('reconciled_at', { withTimezone: true, mode: 'date' }),
  settlementTransactionIds: text('settlement_transaction_ids').array(),
  settlementGroupId: text('settlement_group_id'),
});

export type SupplierInvoiceRow = typeof supplierInvoices.$inferSelect;
export type SupplierInvoiceInsert = typeof supplierInvoices.$inferInsert;

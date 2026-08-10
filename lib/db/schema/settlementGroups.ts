import { pgTable, text, numeric, date, timestamp } from 'drizzle-orm/pg-core';
import type { SettlementSource } from '../../../types/settlementGroup';

/**
 * OTA settlement groups — was Redis JSON array `baker:settlement-groups`.
 * `transaction_ids` / `invoice_ids` kept as text[] for now (faithful); they'll
 * be formalized into join tables in Wave 3 once bank_transactions exists.
 */
export const settlementGroups = pgTable('settlement_groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  transactionIds: text('transaction_ids').array().notNull(),
  invoiceIds: text('invoice_ids').array().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  source: text('source').$type<SettlementSource>(),
  periodStart: date('period_start', { mode: 'string' }),
  periodEnd: date('period_end', { mode: 'string' }),
  grossAmount: numeric('gross_amount'),
  commissionAmount: numeric('commission_amount'),
  netAmount: numeric('net_amount'),
  adjustmentsAmount: numeric('adjustments_amount'),
  taxWithheld: numeric('tax_withheld'),
  reportFileId: text('report_file_id'),
  reportFileName: text('report_file_name'),
  reportUrl: text('report_url'),
  revenueInvoiceId: text('revenue_invoice_id'),
});

export type SettlementGroupRow = typeof settlementGroups.$inferSelect;
export type SettlementGroupInsert = typeof settlementGroups.$inferInsert;

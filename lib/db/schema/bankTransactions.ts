import { pgTable, text, numeric, boolean, date, timestamp } from 'drizzle-orm/pg-core';
import type {
  BankTransactionDirection,
  BankTransactionState,
  IgnoreCategoryId,
  RecurringCostCategoryId,
} from '../../../types/bankTransaction';

/**
 * Bank transactions — was Redis JSON array `baker:bank-transactions`.
 * `id` is a deterministic hash of date+amount+direction+account+VS, so those
 * raw source fields are preserved verbatim (date as date, amount as exact
 * numeric) to keep the hash reproducible. Money → unbounded numeric.
 * invoice_ids / deducted_invoice_ids kept as text[] (faithful); formalized into
 * join tables at cutover.
 */
export const bankTransactions = pgTable('bank_transactions', {
  id: text('id').primaryKey(),
  date: date('date', { mode: 'string' }).notNull(),
  valueDate: date('value_date', { mode: 'string' }),
  amount: numeric('amount').notNull(), // always positive; use direction
  direction: text('direction').$type<BankTransactionDirection>().notNull(),
  currency: text('currency').notNull(),
  counterpartyAccount: text('counterparty_account'),
  counterpartyName: text('counterparty_name'),
  variableSymbol: text('variable_symbol'),
  constantSymbol: text('constant_symbol'),
  specificSymbol: text('specific_symbol'),
  description: text('description'),
  myDescription: text('my_description'),
  transactionType: text('transaction_type'),
  originalAmount: numeric('original_amount'),
  originalCurrency: text('original_currency'),
  state: text('state').$type<BankTransactionState>().notNull(),
  invoiceId: text('invoice_id'),
  invoiceIds: text('invoice_ids').array(),
  linkedTransactionId: text('linked_transaction_id'),
  grossAmount: numeric('gross_amount'),
  deductedInvoiceIds: text('deducted_invoice_ids').array(),
  revenueInvoiceId: text('revenue_invoice_id'),
  commissionSettlementId: text('commission_settlement_id'),
  settlementGroupId: text('settlement_group_id'),
  ignoreCategory: text('ignore_category').$type<IgnoreCategoryId>(),
  ignoreNote: text('ignore_note'),
  costCategory: text('cost_category').$type<RecurringCostCategoryId>(),
  costNote: text('cost_note'),
  suggestionDismissed: boolean('suggestion_dismissed'),
  reconciledAt: timestamp('reconciled_at', { withTimezone: true, mode: 'date' }),
  ignoredAt: timestamp('ignored_at', { withTimezone: true, mode: 'date' }),
  importedAt: timestamp('imported_at', { withTimezone: true, mode: 'date' }).notNull(),
});

export type BankTransactionRow = typeof bankTransactions.$inferSelect;
export type BankTransactionInsert = typeof bankTransactions.$inferInsert;

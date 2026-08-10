import { pgTable, text, numeric, timestamp } from 'drizzle-orm/pg-core';
import type { RecurringCostCategoryId } from '../../../types/bankTransaction';

/** User-defined supplier-invoice categories — was `baker:invoice-categories`. */
export const invoiceCategories = pgTable('invoice_categories', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  color: text('color').notNull(), // background hex
});

/** Auto-process whitelist for supplier invoices — was `baker:supplier-whitelist`. */
export const supplierWhitelist = pgTable('supplier_whitelist', {
  id: text('id').primaryKey(),
  supplierName: text('supplier_name').notNull(),
  supplierIco: text('supplier_ico'),
  category: text('category').notNull(),
  addedAt: timestamp('added_at', { withTimezone: true, mode: 'date' }).notNull(),
});

/** Recurring-cost auto-classify rules — was `baker:bank-cost-whitelist`. */
export const bankCostWhitelist = pgTable('bank_cost_whitelist', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  costCategory: text('cost_category').$type<RecurringCostCategoryId>().notNull(),
  counterpartyAccount: text('counterparty_account'),
  variableSymbol: text('variable_symbol'),
  counterpartyNameContains: text('counterparty_name_contains'),
  amount: numeric('amount', { precision: 14, scale: 2 }), // ±1 Kč guard, optional
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
});

export type InvoiceCategoryRow = typeof invoiceCategories.$inferSelect;
export type SupplierWhitelistRow = typeof supplierWhitelist.$inferSelect;
export type BankCostRuleRow = typeof bankCostWhitelist.$inferSelect;

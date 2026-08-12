/**
 * Postgres repositories for the small accounting config lists (Redis→Postgres
 * cutover): invoice categories, the supplier auto-process whitelist, and the
 * bank recurring-cost whitelist. Each `replaceAll` mirrors the routes' whole-array
 * `set` semantics atomically via db.batch. bank_cost_whitelist ships with the
 * bank_transactions wave (it is read/written inside the reconciliation routes).
 */
import { db } from '@/lib/db';
import { invoiceCategories, supplierWhitelist, bankCostWhitelist } from '@/lib/db/schema';
import type { InvoiceCategory, WhitelistedSupplier } from '@/types/supplierInvoice';
import type { BankCostRule } from '@/types/bankCostWhitelist';

const u = <T>(x: T | null): T | undefined => (x == null ? undefined : x);

// ── Invoice categories ──────────────────────────────────────────────
export async function listInvoiceCategoriesPg(): Promise<InvoiceCategory[]> {
  return (await db.select().from(invoiceCategories)).map((r) => ({
    id: r.id,
    label: r.label,
    color: r.color,
  }));
}

export async function replaceAllInvoiceCategoriesPg(items: InvoiceCategory[]): Promise<void> {
  const rows = items.map((c) => ({ id: c.id, label: c.label, color: c.color }));
  if (rows.length === 0) {
    await db.delete(invoiceCategories);
    return;
  }
  await db.batch([db.delete(invoiceCategories), db.insert(invoiceCategories).values(rows)]);
}

// ── Supplier whitelist ──────────────────────────────────────────────
export async function listSupplierWhitelistPg(): Promise<WhitelistedSupplier[]> {
  return (await db.select().from(supplierWhitelist)).map((r) => ({
    id: r.id,
    supplierName: r.supplierName,
    supplierICO: u(r.supplierIco),
    category: r.category,
    addedAt: r.addedAt.toISOString(),
  }));
}

export async function replaceAllSupplierWhitelistPg(items: WhitelistedSupplier[]): Promise<void> {
  const rows = items.map((s) => ({
    id: s.id,
    supplierName: s.supplierName,
    supplierIco: s.supplierICO ?? null,
    category: s.category,
    addedAt: new Date(s.addedAt),
  }));
  if (rows.length === 0) {
    await db.delete(supplierWhitelist);
    return;
  }
  await db.batch([db.delete(supplierWhitelist), db.insert(supplierWhitelist).values(rows)]);
}

// ── Bank recurring-cost whitelist ───────────────────────────────────
export async function listBankCostWhitelistPg(): Promise<BankCostRule[]> {
  return (await db.select().from(bankCostWhitelist)).map((r) => ({
    id: r.id,
    label: r.label,
    costCategory: r.costCategory,
    counterpartyAccount: u(r.counterpartyAccount),
    variableSymbol: u(r.variableSymbol),
    counterpartyNameContains: u(r.counterpartyNameContains),
    amount: r.amount != null ? Number(r.amount) : undefined,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function replaceAllBankCostWhitelistPg(items: BankCostRule[]): Promise<void> {
  const rows = items.map((r) => ({
    id: r.id,
    label: r.label,
    costCategory: r.costCategory,
    counterpartyAccount: r.counterpartyAccount ?? null,
    variableSymbol: r.variableSymbol ?? null,
    counterpartyNameContains: r.counterpartyNameContains ?? null,
    amount: r.amount != null ? String(r.amount) : null,
    createdAt: new Date(r.createdAt),
  }));
  if (rows.length === 0) {
    await db.delete(bankCostWhitelist);
    return;
  }
  await db.batch([db.delete(bankCostWhitelist), db.insert(bankCostWhitelist).values(rows)]);
}

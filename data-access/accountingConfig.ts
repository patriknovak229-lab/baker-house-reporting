/**
 * Postgres repositories for the small accounting config lists (Redis→Postgres
 * cutover): invoice categories and the supplier auto-process whitelist. Each
 * `replaceAll` mirrors the routes' whole-array `set` semantics atomically via
 * db.batch. (bank_cost_whitelist is migrated with the bank_transactions wave,
 * since it is read/written inside the reconciliation routes.)
 */
import { db } from '@/lib/db';
import { invoiceCategories, supplierWhitelist } from '@/lib/db/schema';
import type { InvoiceCategory, WhitelistedSupplier } from '@/types/supplierInvoice';

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

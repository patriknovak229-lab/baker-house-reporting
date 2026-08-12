/**
 * Postgres repository for supplier invoices (Redis→Postgres cutover).
 * Row↔domain mapping restores the app's shapes (money via unbounded numeric
 * String()↔Number(), invoice/duzp/due dates as YYYY-MM-DD, createdAt/reconciledAt
 * → ISO string, rooms/settlementTransactionIds as text[], absent → undefined).
 * toRow mirrors scripts/backfill/supplier-invoices.ts exactly so the live write
 * path and the backfill produce byte-identical rows.
 *
 * Three ops mirror the routes' semantics:
 *   - listPg       → GET + reconcile/statements/settlement reads (newest-first)
 *   - replaceAllPg → supplier-invoices CRUD read-modify-write (whole-array set)
 *   - appendPg     → settlement channel-fees cost record append (concurrency-safe,
 *                    idempotent by id; mirrors utils/settlementRecords
 *                    appendRecords on the Redis side)
 *
 * SCOPE: storage swap only — reconciliation math (utils/paymentReconcile,
 * bank-transactions reconcile) reads this list unchanged. ids are unique by
 * construction; replaceAll dedups last-wins defensively so a stray duplicate id
 * can never fail the batch insert. Dedup unique constraints (gmail_message_id,
 * icloud_file_name, invoice_number+ico) remain deferred — see schema note.
 */
import { asc, desc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { supplierInvoices } from '@/lib/db/schema';
import type { SupplierInvoice } from '@/types/supplierInvoice';
import type { SupplierInvoiceInsert, SupplierInvoiceRow } from '@/lib/db/schema/supplierInvoices';

const u = <T>(x: T | null): T | undefined => (x == null ? undefined : x);
const n = (x?: number | null) => (x != null ? String(x) : null);
const num = (x: string | null): number | undefined => (x != null ? Number(x) : undefined);
const d = (s?: string | null) => (s ? s.slice(0, 10) : null);

function toRow(s: SupplierInvoice): SupplierInvoiceInsert {
  return {
    id: s.id,
    supplierName: s.supplierName,
    supplierIco: s.supplierICO ?? null,
    invoiceNumber: s.invoiceNumber,
    invoiceDate: s.invoiceDate.slice(0, 10),
    duzpDate: d(s.duzpDate),
    dueDate: d(s.dueDate),
    amountCzk: String(s.amountCZK),
    vatAmountCzk: n(s.vatAmountCZK),
    invoiceCurrency: s.invoiceCurrency ?? null,
    category: s.category,
    rooms: s.rooms ?? null,
    description: s.description ?? null,
    status: s.status,
    sourceType: s.sourceType,
    driveFileId: s.driveFileId ?? null,
    driveFileName: s.driveFileName ?? null,
    driveUrl: s.driveUrl ?? null,
    gmailMessageId: s.gmailMessageId ?? null,
    icloudFileName: s.icloudFileName ?? null,
    autoProcessed: s.autoProcessed ?? null,
    createdAt: new Date(s.createdAt),
    bankTransactionId: s.bankTransactionId ?? null,
    reconciledAt: s.reconciledAt ? new Date(s.reconciledAt) : null,
    settlementTransactionIds: s.settlementTransactionIds ?? null,
    settlementGroupId: s.settlementGroupId ?? null,
  };
}

function fromRow(r: SupplierInvoiceRow): SupplierInvoice {
  return {
    id: r.id,
    supplierName: r.supplierName,
    supplierICO: u(r.supplierIco),
    invoiceNumber: r.invoiceNumber,
    invoiceDate: r.invoiceDate,
    duzpDate: u(r.duzpDate),
    dueDate: u(r.dueDate),
    amountCZK: Number(r.amountCzk),
    vatAmountCZK: num(r.vatAmountCzk),
    invoiceCurrency: u(r.invoiceCurrency),
    category: r.category,
    rooms: u(r.rooms),
    description: u(r.description),
    status: r.status,
    sourceType: r.sourceType,
    driveFileId: u(r.driveFileId),
    driveFileName: u(r.driveFileName),
    driveUrl: u(r.driveUrl),
    gmailMessageId: u(r.gmailMessageId),
    icloudFileName: u(r.icloudFileName),
    autoProcessed: u(r.autoProcessed),
    createdAt: r.createdAt.toISOString(),
    bankTransactionId: u(r.bankTransactionId),
    reconciledAt: r.reconciledAt ? r.reconciledAt.toISOString() : undefined,
    settlementTransactionIds: u(r.settlementTransactionIds),
    settlementGroupId: u(r.settlementGroupId),
  };
}

export async function listSupplierInvoicesPg(): Promise<SupplierInvoice[]> {
  return (
    await db
      .select()
      .from(supplierInvoices)
      .orderBy(desc(supplierInvoices.createdAt), asc(supplierInvoices.id))
  ).map(fromRow);
}

export async function replaceAllSupplierInvoicesPg(items: SupplierInvoice[]): Promise<void> {
  // dedup by id, last-wins — a stray duplicate id would otherwise fail the insert
  const byId = new Map<string, SupplierInvoice>();
  for (const it of items) byId.set(it.id, it);
  const rows = [...byId.values()].map(toRow);
  if (rows.length === 0) {
    await db.delete(supplierInvoices);
    return;
  }
  await db.batch([db.delete(supplierInvoices), db.insert(supplierInvoices).values(rows)]);
}

/** Concurrency-safe append — inserts new invoices, leaving any existing id
 *  untouched (idempotent by id, mirroring appendRecords on the Redis side). */
export async function appendSupplierInvoicesPg(items: SupplierInvoice[]): Promise<void> {
  if (items.length === 0) return;
  const rows = items.map(toRow);
  await db.insert(supplierInvoices).values(rows).onConflictDoNothing({ target: supplierInvoices.id });
}

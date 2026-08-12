/**
 * Postgres repository for revenue invoices (Redis→Postgres cutover).
 * Row↔domain mapping restores the app's shapes (money via unbounded numeric
 * String()↔Number(), invoice/due dates as YYYY-MM-DD, createdAt/reconciledAt →
 * ISO string, absent → undefined). toRow mirrors scripts/backfill/revenue-invoices.ts
 * exactly so the live write path and the backfill produce byte-identical rows.
 *
 * Three ops mirror the routes' semantics:
 *   - listPg       → GET + statements/settlement reads (ordered newest-first)
 *   - replaceAllPg → revenue-invoices CRUD read-modify-write (whole-array set)
 *   - appendPg     → settlement gross-revenue record append (concurrency-safe,
 *                    idempotent by id; mirrors utils/settlementRecords
 *                    appendRecords on the Redis side)
 *
 * ids are unique by construction; replaceAll dedups last-wins defensively so a
 * stray duplicate id can never fail the batch insert.
 */
import { asc, desc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { revenueInvoices } from '@/lib/db/schema';
import type { RevenueInvoice } from '@/types/revenueInvoice';
import type { RevenueInvoiceInsert, RevenueInvoiceRow } from '@/lib/db/schema/revenueInvoices';

const u = <T>(x: T | null): T | undefined => (x == null ? undefined : x);
const d = (s?: string | null) => (s ? s.slice(0, 10) : null);

function toRow(r: RevenueInvoice): RevenueInvoiceInsert {
  return {
    id: r.id,
    sourceType: r.sourceType,
    category: r.category,
    status: r.status,
    invoiceNumber: r.invoiceNumber,
    invoiceDate: r.invoiceDate.slice(0, 10),
    dueDate: d(r.dueDate),
    amountCzk: String(r.amountCZK),
    reservationNumber: r.reservationNumber ?? null,
    guestName: r.guestName ?? null,
    clientName: r.clientName ?? null,
    description: r.description ?? null,
    bankTransactionId: r.bankTransactionId ?? null,
    reconciledAt: r.reconciledAt ? new Date(r.reconciledAt) : null,
    settlementGroupId: r.settlementGroupId ?? null,
    driveFileId: r.driveFileId ?? null,
    driveFileName: r.driveFileName ?? null,
    driveUrl: r.driveUrl ?? null,
    createdAt: new Date(r.createdAt),
  };
}

function fromRow(r: RevenueInvoiceRow): RevenueInvoice {
  return {
    id: r.id,
    sourceType: r.sourceType,
    category: r.category,
    status: r.status,
    invoiceNumber: r.invoiceNumber,
    invoiceDate: r.invoiceDate,
    dueDate: u(r.dueDate),
    amountCZK: Number(r.amountCzk),
    reservationNumber: u(r.reservationNumber),
    guestName: u(r.guestName),
    clientName: u(r.clientName),
    description: u(r.description),
    bankTransactionId: u(r.bankTransactionId),
    reconciledAt: r.reconciledAt ? r.reconciledAt.toISOString() : undefined,
    settlementGroupId: u(r.settlementGroupId),
    driveFileId: u(r.driveFileId),
    driveFileName: u(r.driveFileName),
    driveUrl: u(r.driveUrl),
    createdAt: r.createdAt.toISOString(),
  };
}

export async function listRevenueInvoicesPg(): Promise<RevenueInvoice[]> {
  return (
    await db
      .select()
      .from(revenueInvoices)
      .orderBy(desc(revenueInvoices.createdAt), asc(revenueInvoices.id))
  ).map(fromRow);
}

export async function replaceAllRevenueInvoicesPg(items: RevenueInvoice[]): Promise<void> {
  // dedup by id, last-wins — a stray duplicate id would otherwise fail the insert
  const byId = new Map<string, RevenueInvoice>();
  for (const it of items) byId.set(it.id, it);
  const rows = [...byId.values()].map(toRow);
  if (rows.length === 0) {
    await db.delete(revenueInvoices);
    return;
  }
  await db.batch([db.delete(revenueInvoices), db.insert(revenueInvoices).values(rows)]);
}

/** Concurrency-safe append — inserts new invoices, leaving any existing id
 *  untouched (idempotent by id, mirroring appendRecords on the Redis side). */
export async function appendRevenueInvoicesPg(items: RevenueInvoice[]): Promise<void> {
  if (items.length === 0) return;
  const rows = items.map(toRow);
  await db.insert(revenueInvoices).values(rows).onConflictDoNothing({ target: revenueInvoices.id });
}

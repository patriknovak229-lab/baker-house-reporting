/**
 * Postgres repository for auto-detected guest invoice requests (Redis→Postgres
 * cutover). Row↔domain mapping restores the app's shapes: beds24MessageId as a
 * bigint(number) dedup key, timestamps ISO↔Date, required-nullable text fields
 * kept as null, genuinely-optional fields (companyAddress/processedAt/lastAskedAt/
 * asksCount/lastExtractedFromAt) null→undefined so absent keys round-trip.
 * toRow mirrors scripts/backfill/invoice-requests.ts exactly.
 *
 * Whole-array read-modify-write domain (detector dedups by beds24MessageId, the
 * awaiting-info flow + operator Accept/Reject mutate entries): listPg + replaceAll
 * mirror the routes' `redis.get`/`redis.set` semantics. Not capped.
 */
import { asc, desc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { invoiceRequests } from '@/lib/db/schema';
import type { InvoiceRequest } from '@/types/invoiceRequest';
import type { InvoiceRequestInsert, InvoiceRequestRow } from '@/lib/db/schema/invoiceRequests';

const u = <T>(x: T | null): T | undefined => (x == null ? undefined : x);

function toRow(r: InvoiceRequest): InvoiceRequestInsert {
  return {
    id: r.id,
    reservationNumber: r.reservationNumber,
    beds24MessageId: r.beds24MessageId,
    rawMessage: r.rawMessage,
    companyName: r.companyName ?? null,
    companyAddress: r.companyAddress ?? null,
    ico: r.ico ?? null,
    dic: r.dic ?? null,
    email: r.email ?? null,
    detectedAt: new Date(r.detectedAt),
    status: r.status,
    processedAt: r.processedAt ? new Date(r.processedAt) : null,
    lastAskedAt: r.lastAskedAt ? new Date(r.lastAskedAt) : null,
    asksCount: r.asksCount ?? null,
    lastExtractedFromAt: r.lastExtractedFromAt ? new Date(r.lastExtractedFromAt) : null,
  };
}

function fromRow(row: InvoiceRequestRow): InvoiceRequest {
  return {
    id: row.id,
    reservationNumber: row.reservationNumber,
    beds24MessageId: row.beds24MessageId,
    rawMessage: row.rawMessage,
    companyName: row.companyName,
    companyAddress: u(row.companyAddress),
    ico: row.ico,
    dic: row.dic,
    email: row.email,
    detectedAt: row.detectedAt.toISOString(),
    status: row.status,
    processedAt: row.processedAt ? row.processedAt.toISOString() : undefined,
    lastAskedAt: row.lastAskedAt ? row.lastAskedAt.toISOString() : undefined,
    asksCount: u(row.asksCount),
    lastExtractedFromAt: row.lastExtractedFromAt ? row.lastExtractedFromAt.toISOString() : undefined,
  };
}

export async function listInvoiceRequestsPg(): Promise<InvoiceRequest[]> {
  return (
    await db
      .select()
      .from(invoiceRequests)
      .orderBy(desc(invoiceRequests.detectedAt), asc(invoiceRequests.id))
  ).map(fromRow);
}

export async function replaceAllInvoiceRequestsPg(items: InvoiceRequest[]): Promise<void> {
  // dedup by id, last-wins — a stray duplicate id would otherwise fail the insert
  const byId = new Map<string, InvoiceRequest>();
  for (const it of items) byId.set(it.id, it);
  const rows = [...byId.values()].map(toRow);
  if (rows.length === 0) {
    await db.delete(invoiceRequests);
    return;
  }
  await db.batch([db.delete(invoiceRequests), db.insert(invoiceRequests).values(rows)]);
}

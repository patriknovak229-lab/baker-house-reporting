/**
 * Postgres repository for OTA settlement groups (Redis→Postgres cutover).
 * Row↔domain mapping restores the app's shapes (money via unbounded numeric
 * String()↔Number(), period dates as YYYY-MM-DD, createdAt → ISO string,
 * transaction_ids/invoice_ids as text[], absent → undefined). toRow mirrors
 * scripts/backfill/settlement-groups.ts.
 *
 * Three ops mirror the routes' semantics:
 *   - listPg           → GET + statements reads (ordered newest-first)
 *   - replaceAllPg     → settlement-groups/[id] PUT/DELETE (whole-array set)
 *   - appendPg         → settlement-groups POST (concurrency-safe append;
 *                        idempotent by id, mirrors utils/settlementRecords
 *                        appendRecords on the Redis side)
 *
 * ids are crypto.randomUUID() (unique by construction), so replaceAll needs no
 * dedup. transaction_ids/invoice_ids stay text[] (join tables deferred to the
 * bank_transactions wave).
 */
import { desc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { settlementGroups } from '@/lib/db/schema';
import type { SettlementGroup } from '@/types/settlementGroup';
import type { SettlementGroupInsert, SettlementGroupRow } from '@/lib/db/schema/settlementGroups';

const u = <T>(x: T | null): T | undefined => (x == null ? undefined : x);
const n = (x?: number | null) => (x != null ? String(x) : null);
const num = (x: string | null): number | undefined => (x != null ? Number(x) : undefined);

function toRow(g: SettlementGroup): SettlementGroupInsert {
  return {
    id: g.id,
    name: g.name,
    transactionIds: g.transactionIds ?? [],
    invoiceIds: g.invoiceIds ?? [],
    createdAt: new Date(g.createdAt),
    source: g.source ?? null,
    periodStart: g.periodStart ? g.periodStart.slice(0, 10) : null,
    periodEnd: g.periodEnd ? g.periodEnd.slice(0, 10) : null,
    grossAmount: n(g.grossAmount),
    commissionAmount: n(g.commissionAmount),
    netAmount: n(g.netAmount),
    adjustmentsAmount: n(g.adjustmentsAmount),
    taxWithheld: n(g.taxWithheld),
    reportFileId: g.reportFileId ?? null,
    reportFileName: g.reportFileName ?? null,
    reportUrl: g.reportUrl ?? null,
    revenueInvoiceId: g.revenueInvoiceId ?? null,
  };
}

function fromRow(r: SettlementGroupRow): SettlementGroup {
  return {
    id: r.id,
    name: r.name,
    transactionIds: r.transactionIds,
    invoiceIds: r.invoiceIds,
    createdAt: r.createdAt.toISOString(),
    source: u(r.source),
    periodStart: u(r.periodStart),
    periodEnd: u(r.periodEnd),
    grossAmount: num(r.grossAmount),
    commissionAmount: num(r.commissionAmount),
    netAmount: num(r.netAmount),
    adjustmentsAmount: num(r.adjustmentsAmount),
    taxWithheld: num(r.taxWithheld),
    reportFileId: u(r.reportFileId),
    reportFileName: u(r.reportFileName),
    reportUrl: u(r.reportUrl),
    revenueInvoiceId: u(r.revenueInvoiceId),
  };
}

export async function listSettlementGroupsPg(): Promise<SettlementGroup[]> {
  return (await db.select().from(settlementGroups).orderBy(desc(settlementGroups.createdAt))).map(fromRow);
}

export async function replaceAllSettlementGroupsPg(items: SettlementGroup[]): Promise<void> {
  const rows = items.map(toRow);
  if (rows.length === 0) {
    await db.delete(settlementGroups);
    return;
  }
  await db.batch([db.delete(settlementGroups), db.insert(settlementGroups).values(rows)]);
}

/** Concurrency-safe append — inserts new groups, leaving any existing id untouched
 *  (idempotent by id, mirroring appendRecords on the Redis side). */
export async function appendSettlementGroupsPg(items: SettlementGroup[]): Promise<void> {
  if (items.length === 0) return;
  const rows = items.map(toRow);
  await db.insert(settlementGroups).values(rows).onConflictDoNothing({ target: settlementGroups.id });
}

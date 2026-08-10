/** Parity: baker:revenue-invoices vs revenue_invoices. */
import '../_loadEnv';
import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { revenueInvoices } from '../../lib/db/schema';
import type { RevenueInvoice } from '../../types/revenueInvoice';

const KEY = 'baker:revenue-invoices';
const norm = (x: string | null | undefined) => (x == null || x === '' ? null : x);
const epoch = (v: string | Date | null | undefined) => (v ? new Date(v).getTime() : null);
const day = (v: string | null | undefined) => (v ? v.slice(0, 10) : null);
const num = (x: number | string | null | undefined) => (x == null ? null : Number(x));

async function main() {
  const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });
  const a = new Map((((await redis.get<RevenueInvoice[]>(KEY)) ?? []).filter((x) => x?.id)).map((x) => [x.id, x] as const));
  const b = new Map((await db.select().from(revenueInvoices)).map((r) => [r.id, r] as const));
  const m: string[] = [];
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(id); const y = b.get(id);
    if (!x) { m.push(`${id}: PG only`); continue; }
    if (!y) { m.push(`${id}: Redis only`); continue; }
    if (x.sourceType !== y.sourceType) m.push(`${id}: sourceType`);
    if (x.category !== y.category) m.push(`${id}: category`);
    if (x.status !== y.status) m.push(`${id}: status`);
    if (x.invoiceNumber !== y.invoiceNumber) m.push(`${id}: invoiceNumber`);
    if (day(x.invoiceDate) !== day(y.invoiceDate)) m.push(`${id}: invoiceDate`);
    if (day(x.dueDate) !== day(y.dueDate)) m.push(`${id}: dueDate`);
    if (num(x.amountCZK) !== num(y.amountCzk)) m.push(`${id}: amountCZK`);
    if (norm(x.reservationNumber) !== norm(y.reservationNumber)) m.push(`${id}: reservationNumber`);
    if (norm(x.guestName) !== norm(y.guestName)) m.push(`${id}: guestName`);
    if (norm(x.clientName) !== norm(y.clientName)) m.push(`${id}: clientName`);
    if (norm(x.description) !== norm(y.description)) m.push(`${id}: description`);
    if (norm(x.bankTransactionId) !== norm(y.bankTransactionId)) m.push(`${id}: bankTransactionId`);
    if (epoch(x.reconciledAt) !== epoch(y.reconciledAt)) m.push(`${id}: reconciledAt`);
    if (norm(x.settlementGroupId) !== norm(y.settlementGroupId)) m.push(`${id}: settlementGroupId`);
    if (norm(x.driveFileId) !== norm(y.driveFileId)) m.push(`${id}: driveFileId`);
    if (norm(x.driveFileName) !== norm(y.driveFileName)) m.push(`${id}: driveFileName`);
    if (norm(x.driveUrl) !== norm(y.driveUrl)) m.push(`${id}: driveUrl`);
    if (epoch(x.createdAt) !== epoch(y.createdAt)) m.push(`${id}: createdAt`);
  }
  console.log(JSON.stringify({ redisCount: a.size, postgresCount: b.size, mismatches: m }, null, 2));
  if (m.length) { console.error(`❌ ${m.length} mismatch(es)`); process.exit(1); }
  console.log('✅ parity OK');
}
main().catch((e) => { console.error('❌ verify failed:', e); process.exit(1); });

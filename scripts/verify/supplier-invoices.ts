/** Parity: baker:supplier-invoices vs supplier_invoices. */
import '../_loadEnv';
import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { supplierInvoices } from '../../lib/db/schema';
import type { SupplierInvoice } from '../../types/supplierInvoice';

const KEY = 'baker:supplier-invoices';
const norm = (x: string | null | undefined) => (x == null || x === '' ? null : x);
const epoch = (v: string | Date | null | undefined) => (v ? new Date(v).getTime() : null);
const day = (v: string | null | undefined) => (v ? v.slice(0, 10) : null);
const num = (x: number | string | null | undefined) => (x == null ? null : Number(x));
const boolN = (x: boolean | null | undefined) => x ?? null;
const canon = (x: unknown) => JSON.stringify(x ?? []);
const arr = (x: unknown[] | null | undefined) => canon(x ?? []);

async function main() {
  const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });
  const a = new Map((((await redis.get<SupplierInvoice[]>(KEY)) ?? []).filter((x) => x?.id)).map((x) => [x.id, x] as const));
  const b = new Map((await db.select().from(supplierInvoices)).map((r) => [r.id, r] as const));
  const m: string[] = [];
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(id); const y = b.get(id);
    if (!x) { m.push(`${id}: PG only`); continue; }
    if (!y) { m.push(`${id}: Redis only`); continue; }
    if (x.supplierName !== y.supplierName) m.push(`${id}: supplierName`);
    if (norm(x.supplierICO) !== norm(y.supplierIco)) m.push(`${id}: supplierICO`);
    if (x.invoiceNumber !== y.invoiceNumber) m.push(`${id}: invoiceNumber`);
    if (day(x.invoiceDate) !== day(y.invoiceDate)) m.push(`${id}: invoiceDate`);
    if (day(x.duzpDate) !== day(y.duzpDate)) m.push(`${id}: duzpDate`);
    if (day(x.dueDate) !== day(y.dueDate)) m.push(`${id}: dueDate`);
    if (num(x.amountCZK) !== num(y.amountCzk)) m.push(`${id}: amountCZK`);
    if (num(x.vatAmountCZK) !== num(y.vatAmountCzk)) m.push(`${id}: vatAmountCZK`);
    if (norm(x.invoiceCurrency) !== norm(y.invoiceCurrency)) m.push(`${id}: invoiceCurrency`);
    if (x.category !== y.category) m.push(`${id}: category`);
    if (arr(x.rooms) !== arr(y.rooms)) m.push(`${id}: rooms`);
    if (norm(x.description) !== norm(y.description)) m.push(`${id}: description`);
    if (x.status !== y.status) m.push(`${id}: status`);
    if (x.sourceType !== y.sourceType) m.push(`${id}: sourceType`);
    if (norm(x.driveFileId) !== norm(y.driveFileId)) m.push(`${id}: driveFileId`);
    if (norm(x.driveFileName) !== norm(y.driveFileName)) m.push(`${id}: driveFileName`);
    if (norm(x.driveUrl) !== norm(y.driveUrl)) m.push(`${id}: driveUrl`);
    if (norm(x.gmailMessageId) !== norm(y.gmailMessageId)) m.push(`${id}: gmailMessageId`);
    if (norm(x.icloudFileName) !== norm(y.icloudFileName)) m.push(`${id}: icloudFileName`);
    if (boolN(x.autoProcessed) !== boolN(y.autoProcessed)) m.push(`${id}: autoProcessed`);
    if (epoch(x.createdAt) !== epoch(y.createdAt)) m.push(`${id}: createdAt`);
    if (norm(x.bankTransactionId) !== norm(y.bankTransactionId)) m.push(`${id}: bankTransactionId`);
    if (epoch(x.reconciledAt) !== epoch(y.reconciledAt)) m.push(`${id}: reconciledAt`);
    if (arr(x.settlementTransactionIds) !== arr(y.settlementTransactionIds)) m.push(`${id}: settlementTransactionIds`);
    if (norm(x.settlementGroupId) !== norm(y.settlementGroupId)) m.push(`${id}: settlementGroupId`);
  }
  console.log(JSON.stringify({ redisCount: a.size, postgresCount: b.size, mismatches: m }, null, 2));
  if (m.length) { console.error(`❌ ${m.length} mismatch(es)`); process.exit(1); }
  console.log('✅ parity OK');
}
main().catch((e) => { console.error('❌ verify failed:', e); process.exit(1); });

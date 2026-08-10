/** Parity: baker:settlement-groups vs settlement_groups. */
import '../_loadEnv';
import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { settlementGroups } from '../../lib/db/schema';
import type { SettlementGroup } from '../../types/settlementGroup';

const KEY = 'baker:settlement-groups';
const norm = (x: string | null | undefined) => (x == null || x === '' ? null : x);
const epoch = (v: string | Date | null | undefined) => (v ? new Date(v).getTime() : null);
const day = (v: string | null | undefined) => (v ? v.slice(0, 10) : null);
const num = (x: number | string | null | undefined) => (x == null ? null : Number(x));
const arr = (x: string[] | null | undefined) => JSON.stringify(x ?? []);

async function main() {
  const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });
  const a = new Map((((await redis.get<SettlementGroup[]>(KEY)) ?? []).filter((x) => x?.id)).map((x) => [x.id, x] as const));
  const b = new Map((await db.select().from(settlementGroups)).map((r) => [r.id, r] as const));
  const m: string[] = [];
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(id); const y = b.get(id);
    if (!x) { m.push(`${id}: PG only`); continue; }
    if (!y) { m.push(`${id}: Redis only`); continue; }
    if (x.name !== y.name) m.push(`${id}: name`);
    if (arr(x.transactionIds) !== arr(y.transactionIds)) m.push(`${id}: transactionIds`);
    if (arr(x.invoiceIds) !== arr(y.invoiceIds)) m.push(`${id}: invoiceIds`);
    if (epoch(x.createdAt) !== epoch(y.createdAt)) m.push(`${id}: createdAt`);
    if (norm(x.source) !== norm(y.source)) m.push(`${id}: source`);
    if (day(x.periodStart) !== day(y.periodStart)) m.push(`${id}: periodStart`);
    if (day(x.periodEnd) !== day(y.periodEnd)) m.push(`${id}: periodEnd`);
    if (num(x.grossAmount) !== num(y.grossAmount)) m.push(`${id}: grossAmount`);
    if (num(x.commissionAmount) !== num(y.commissionAmount)) m.push(`${id}: commissionAmount`);
    if (num(x.netAmount) !== num(y.netAmount)) m.push(`${id}: netAmount`);
    if (num(x.adjustmentsAmount) !== num(y.adjustmentsAmount)) m.push(`${id}: adjustmentsAmount`);
    if (num(x.taxWithheld) !== num(y.taxWithheld)) m.push(`${id}: taxWithheld`);
    if (norm(x.reportFileId) !== norm(y.reportFileId)) m.push(`${id}: reportFileId`);
    if (norm(x.reportFileName) !== norm(y.reportFileName)) m.push(`${id}: reportFileName`);
    if (norm(x.reportUrl) !== norm(y.reportUrl)) m.push(`${id}: reportUrl`);
    if (norm(x.revenueInvoiceId) !== norm(y.revenueInvoiceId)) m.push(`${id}: revenueInvoiceId`);
  }
  console.log(JSON.stringify({ redisCount: a.size, postgresCount: b.size, mismatches: m }, null, 2));
  if (m.length) { console.error(`❌ ${m.length} mismatch(es)`); process.exit(1); }
  console.log('✅ parity OK');
}
main().catch((e) => { console.error('❌ verify failed:', e); process.exit(1); });

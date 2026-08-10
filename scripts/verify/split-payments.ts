/** Parity: baker:scheduled-split-payments vs split_payments. */
import '../_loadEnv';
import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { splitPayments } from '../../lib/db/schema';
import type { SplitPayment } from '../../types/splitPayment';

const KEY = 'baker:scheduled-split-payments';
const norm = (x: string | null | undefined) => (x == null || x === '' ? null : x);
const epoch = (v: string | Date | null | undefined) => (v ? new Date(v).getTime() : null);
const day = (v: string | null | undefined) => (v ? v.slice(0, 10) : null);
const num = (x: number | string | null | undefined) => (x == null ? null : Number(x));
const intN = (x: number | null | undefined) => (x == null ? null : x);

async function main() {
  const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });
  const a = new Map((((await redis.get<SplitPayment[]>(KEY)) ?? []).filter((x) => x?.id)).map((x) => [x.id, x] as const));
  const b = new Map((await db.select().from(splitPayments)).map((r) => [r.id, r] as const));
  const m: string[] = [];
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(id); const y = b.get(id);
    if (!x) { m.push(`${id}: PG only`); continue; }
    if (!y) { m.push(`${id}: Redis only`); continue; }
    if (x.reservationNumber !== y.reservationNumber) m.push(`${id}: reservationNumber`);
    if (x.paymentNumber !== y.paymentNumber) m.push(`${id}: paymentNumber`);
    if (x.totalPayments !== y.totalPayments) m.push(`${id}: totalPayments`);
    if (x.description !== y.description) m.push(`${id}: description`);
    if (num(x.amountCzk) !== num(y.amountCzk)) m.push(`${id}: amountCzk`);
    if (day(x.sendDate) !== day(y.sendDate)) m.push(`${id}: sendDate`);
    if (norm(x.guestEmail) !== norm(y.guestEmail)) m.push(`${id}: guestEmail`);
    if (norm(x.guestName) !== norm(y.guestName)) m.push(`${id}: guestName`);
    if (norm(x.guestPhone) !== norm(y.guestPhone)) m.push(`${id}: guestPhone`);
    if (x.status !== y.status) m.push(`${id}: status`);
    if (norm(x.stripeSessionId) !== norm(y.stripeSessionId)) m.push(`${id}: stripeSessionId`);
    if (epoch(x.sentAt) !== epoch(y.sentAt)) m.push(`${id}: sentAt`);
    if (norm(x.failureReason) !== norm(y.failureReason)) m.push(`${id}: failureReason`);
    if (intN(x.failureCount) !== intN(y.failureCount)) m.push(`${id}: failureCount`);
    if (epoch(x.createdAt) !== epoch(y.createdAt)) m.push(`${id}: createdAt`);
  }
  console.log(JSON.stringify({ redisCount: a.size, postgresCount: b.size, mismatches: m }, null, 2));
  if (m.length) { console.error(`❌ ${m.length} mismatch(es)`); process.exit(1); }
  console.log('✅ parity OK');
}
main().catch((e) => { console.error('❌ verify failed:', e); process.exit(1); });

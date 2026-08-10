/** Parity: baker:stripe-payments vs stripe_payment_log. */
import '../_loadEnv';
import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { stripePaymentLog } from '../../lib/db/schema';

const KEY = 'baker:stripe-payments';
const norm = (x: string | null | undefined) => (x == null || x === '' ? null : x);
const epoch = (v: string | Date | null | undefined) => (v ? new Date(v).getTime() : null);
const num = (x: number | string | null | undefined) => (x == null ? null : Number(x));

interface Rec { sessionId: string; description: string; amountCzk: number; guestEmail?: string; guestPhone?: string; guestName?: string; reservationNumber?: string; paidAt: string; }

async function main() {
  const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });
  const a = new Map((((await redis.get<Rec[]>(KEY)) ?? []).filter((x) => x?.sessionId)).map((x) => [x.sessionId, x] as const));
  const b = new Map((await db.select().from(stripePaymentLog)).map((r) => [r.sessionId, r] as const));
  const m: string[] = [];
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(id); const y = b.get(id);
    if (!x) { m.push(`${id}: PG only`); continue; }
    if (!y) { m.push(`${id}: Redis only`); continue; }
    if (x.description !== y.description) m.push(`${id}: description`);
    if (num(x.amountCzk) !== num(y.amountCzk)) m.push(`${id}: amountCzk`);
    if (norm(x.guestEmail) !== norm(y.guestEmail)) m.push(`${id}: guestEmail`);
    if (norm(x.guestPhone) !== norm(y.guestPhone)) m.push(`${id}: guestPhone`);
    if (norm(x.guestName) !== norm(y.guestName)) m.push(`${id}: guestName`);
    if (norm(x.reservationNumber) !== norm(y.reservationNumber)) m.push(`${id}: reservationNumber`);
    if (epoch(x.paidAt) !== epoch(y.paidAt)) m.push(`${id}: paidAt`);
  }
  console.log(JSON.stringify({ redisCount: a.size, postgresCount: b.size, mismatches: m }, null, 2));
  if (m.length) { console.error(`❌ ${m.length} mismatch(es)`); process.exit(1); }
  console.log('✅ parity OK');
}
main().catch((e) => { console.error('❌ verify failed:', e); process.exit(1); });

/** Parity: baker:commission-settlements vs commission_settlements. */
import '../_loadEnv';
import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { commissionSettlements } from '../../lib/db/schema';
import type { CommissionSettlement } from '../../types/commissionSettlement';

const KEY = 'baker:commission-settlements';
const norm = (x: string | null | undefined) => (x == null || x === '' ? null : x);
const epoch = (v: string | Date | null | undefined) => (v ? new Date(v).getTime() : null);
const day = (v: string | null | undefined) => (v ? v.slice(0, 10) : null);
const num = (x: number | string | null | undefined) => (x == null ? null : Number(x));
const intN = (x: number | null | undefined) => (x == null ? null : x);
const arr = (x: string[] | null | undefined) => JSON.stringify(x ?? []);

async function main() {
  const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });
  const a = new Map((((await redis.get<CommissionSettlement[]>(KEY)) ?? []).filter((x) => x?.id)).map((x) => [x.id, x] as const));
  const b = new Map((await db.select().from(commissionSettlements)).map((r) => [r.id, r] as const));
  const moneyFields = ['gbv','otaCommission','paymentFees','netSales','cleaning','laundry','consumables','subscriptions','wearTear','misc','operationalCosts','grossProfit','commissionRate','commissionAmount','payableToOwner'] as const;
  const m: string[] = [];
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(id); const y = b.get(id);
    if (!x) { m.push(`${id}: PG only`); continue; }
    if (!y) { m.push(`${id}: Redis only`); continue; }
    if (x.unitId !== y.unitId) m.push(`${id}: unitId`);
    if (x.room !== y.room) m.push(`${id}: room`);
    if (x.ownerName !== y.ownerName) m.push(`${id}: ownerName`);
    if (x.mode !== y.mode) m.push(`${id}: mode`);
    if (x.month !== y.month) m.push(`${id}: month`);
    if (day(x.periodStart) !== day(y.periodStart)) m.push(`${id}: periodStart`);
    if (day(x.periodEnd) !== day(y.periodEnd)) m.push(`${id}: periodEnd`);
    for (const f of moneyFields) {
      if (num((x as unknown as Record<string, number>)[f]) !== num((y as unknown as Record<string, number>)[f])) m.push(`${id}: ${f}`);
    }
    if (arr(x.poolRooms) !== arr(y.poolRooms)) m.push(`${id}: poolRooms`);
    if (intN(x.poolDivisor) !== intN(y.poolDivisor)) m.push(`${id}: poolDivisor`);
    if (num(x.poolGrossProfit) !== num(y.poolGrossProfit)) m.push(`${id}: poolGrossProfit`);
    if ((x.reconciles ?? null) !== (y.reconciles ?? null)) m.push(`${id}: reconciles`);
    if (norm(x.reconcileNote) !== norm(y.reconcileNote)) m.push(`${id}: reconcileNote`);
    if (x.status !== y.status) m.push(`${id}: status`);
    if (norm(x.bankTransactionId) !== norm(y.bankTransactionId)) m.push(`${id}: bankTransactionId`);
    if (epoch(x.reconciledAt) !== epoch(y.reconciledAt)) m.push(`${id}: reconciledAt`);
    if (epoch(x.emailedAt) !== epoch(y.emailedAt)) m.push(`${id}: emailedAt`);
    if (norm(x.emailedTo) !== norm(y.emailedTo)) m.push(`${id}: emailedTo`);
    if (epoch(x.createdAt) !== epoch(y.createdAt)) m.push(`${id}: createdAt`);
    if (x.createdBy !== y.createdBy) m.push(`${id}: createdBy`);
  }
  console.log(JSON.stringify({ redisCount: a.size, postgresCount: b.size, mismatches: m }, null, 2));
  if (m.length) { console.error(`❌ ${m.length} mismatch(es)`); process.exit(1); }
  console.log('✅ parity OK');
}
main().catch((e) => { console.error('❌ verify failed:', e); process.exit(1); });

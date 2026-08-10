/** Backfill `baker:commission-settlements` → Postgres. Idempotent. */
import '../_loadEnv';

import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { commissionSettlements } from '../../lib/db/schema';
import type { CommissionSettlementInsert } from '../../lib/db/schema/commissionSettlements';
import type { CommissionSettlement } from '../../types/commissionSettlement';

const KEY = 'baker:commission-settlements';
const n = (x?: number | null) => (x != null ? String(x) : null);

async function main() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
  const arr = (await redis.get<CommissionSettlement[]>(KEY)) ?? [];
  let up = 0, sk = 0;
  for (const c of arr) {
    if (!c?.id) { sk++; continue; }
    const row: CommissionSettlementInsert = {
      id: c.id,
      unitId: c.unitId,
      room: c.room,
      ownerName: c.ownerName,
      mode: c.mode,
      month: c.month,
      periodStart: c.periodStart.slice(0, 10),
      periodEnd: c.periodEnd.slice(0, 10),
      gbv: String(c.gbv),
      otaCommission: String(c.otaCommission),
      paymentFees: String(c.paymentFees),
      netSales: String(c.netSales),
      cleaning: String(c.cleaning),
      laundry: String(c.laundry),
      consumables: String(c.consumables),
      subscriptions: String(c.subscriptions),
      wearTear: String(c.wearTear),
      misc: String(c.misc),
      operationalCosts: String(c.operationalCosts),
      grossProfit: String(c.grossProfit),
      commissionRate: String(c.commissionRate),
      commissionAmount: String(c.commissionAmount),
      payableToOwner: String(c.payableToOwner),
      poolRooms: c.poolRooms ?? null,
      poolDivisor: c.poolDivisor ?? null,
      poolGrossProfit: n(c.poolGrossProfit),
      reconciles: c.reconciles,
      reconcileNote: c.reconcileNote ?? null,
      status: c.status,
      bankTransactionId: c.bankTransactionId ?? null,
      reconciledAt: c.reconciledAt ? new Date(c.reconciledAt) : null,
      emailedAt: c.emailedAt ? new Date(c.emailedAt) : null,
      emailedTo: c.emailedTo ?? null,
      createdAt: new Date(c.createdAt),
      createdBy: c.createdBy,
    };
    const { id: _id, ...set } = row;
    await db.insert(commissionSettlements).values(row).onConflictDoUpdate({ target: commissionSettlements.id, set });
    up++;
  }
  console.log(JSON.stringify({ redisCount: arr.length, rowsUpserted: up, skipped: sk }, null, 2));
}
main().catch((e) => { console.error('❌ backfill failed:', e); process.exit(1); });

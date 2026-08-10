/** Backfill `baker:settlement-groups` → Postgres. Idempotent. */
import '../_loadEnv';

import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { settlementGroups } from '../../lib/db/schema';
import type { SettlementGroupInsert } from '../../lib/db/schema/settlementGroups';
import type { SettlementGroup } from '../../types/settlementGroup';

const KEY = 'baker:settlement-groups';
const d = (s?: string | null) => (s ? s.slice(0, 10) : null);
const n = (x?: number | null) => (x != null ? String(x) : null);

async function main() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
  const arr = (await redis.get<SettlementGroup[]>(KEY)) ?? [];
  let up = 0, sk = 0;
  for (const g of arr) {
    if (!g?.id) { sk++; continue; }
    const row: SettlementGroupInsert = {
      id: g.id,
      name: g.name,
      transactionIds: g.transactionIds ?? [],
      invoiceIds: g.invoiceIds ?? [],
      createdAt: new Date(g.createdAt),
      source: g.source ?? null,
      periodStart: d(g.periodStart),
      periodEnd: d(g.periodEnd),
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
    const { id: _id, ...set } = row;
    await db.insert(settlementGroups).values(row).onConflictDoUpdate({ target: settlementGroups.id, set });
    up++;
  }
  console.log(JSON.stringify({ redisCount: arr.length, rowsUpserted: up, skipped: sk }, null, 2));
}
main().catch((e) => { console.error('❌ backfill failed:', e); process.exit(1); });

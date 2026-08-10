/** Backfill `baker:scheduled-split-payments` → Postgres. Idempotent. */
import '../_loadEnv';

import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { splitPayments } from '../../lib/db/schema';
import type { SplitPaymentInsert } from '../../lib/db/schema/splitPayments';
import type { SplitPayment } from '../../types/splitPayment';

const KEY = 'baker:scheduled-split-payments';

async function main() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
  const arr = (await redis.get<SplitPayment[]>(KEY)) ?? [];
  let up = 0, sk = 0;
  for (const s of arr) {
    if (!s?.id) { sk++; continue; }
    const row: SplitPaymentInsert = {
      id: s.id,
      reservationNumber: s.reservationNumber,
      paymentNumber: s.paymentNumber,
      totalPayments: s.totalPayments,
      description: s.description,
      amountCzk: String(s.amountCzk),
      sendDate: s.sendDate.slice(0, 10),
      guestEmail: s.guestEmail ?? null,
      guestName: s.guestName ?? null,
      guestPhone: s.guestPhone ?? null,
      status: s.status,
      stripeSessionId: s.stripeSessionId ?? null,
      sentAt: s.sentAt ? new Date(s.sentAt) : null,
      failureReason: s.failureReason ?? null,
      failureCount: s.failureCount ?? null,
      createdAt: new Date(s.createdAt),
    };
    const { id: _id, ...set } = row;
    await db.insert(splitPayments).values(row).onConflictDoUpdate({ target: splitPayments.id, set });
    up++;
  }
  console.log(JSON.stringify({ redisCount: arr.length, rowsUpserted: up, skipped: sk }, null, 2));
}
main().catch((e) => { console.error('❌ backfill failed:', e); process.exit(1); });

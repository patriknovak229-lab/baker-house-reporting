/** Backfill `baker:stripe-payments` → stripe_payment_log. Idempotent. */
import '../_loadEnv';

import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { stripePaymentLog } from '../../lib/db/schema';
import type { StripePaymentLogInsert } from '../../lib/db/schema/stripePayments';

const KEY = 'baker:stripe-payments';

interface StripePaymentRecord {
  sessionId: string;
  description: string;
  amountCzk: number;
  guestEmail?: string;
  guestPhone?: string;
  guestName?: string;
  reservationNumber?: string;
  paidAt: string;
}

async function main() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
  const arr = (await redis.get<StripePaymentRecord[]>(KEY)) ?? [];
  let up = 0, sk = 0;
  for (const r of arr) {
    if (!r?.sessionId) { sk++; continue; }
    const row: StripePaymentLogInsert = {
      sessionId: r.sessionId,
      description: r.description,
      amountCzk: String(r.amountCzk),
      guestEmail: r.guestEmail ?? null,
      guestPhone: r.guestPhone ?? null,
      guestName: r.guestName ?? null,
      reservationNumber: r.reservationNumber ?? null,
      paidAt: new Date(r.paidAt),
    };
    const { sessionId: _s, ...set } = row;
    await db.insert(stripePaymentLog).values(row).onConflictDoUpdate({ target: stripePaymentLog.sessionId, set });
    up++;
  }
  console.log(JSON.stringify({ redisCount: arr.length, rowsUpserted: up, skipped: sk }, null, 2));
}
main().catch((e) => { console.error('❌ backfill failed:', e); process.exit(1); });

/** Backfill `baker:additional-payments` → additional_payments (+ payment_refunds child). Idempotent. */
import '../_loadEnv';

import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { additionalPayments, paymentRefunds } from '../../lib/db/schema';
import type { AdditionalPaymentInsert, PaymentRefundInsert } from '../../lib/db/schema/additionalPayments';
import type { AdditionalPayment } from '../../types/additionalPayment';

const KEY = 'baker:additional-payments';
const n = (x?: number | null) => (x != null ? String(x) : null);

async function main() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
  const arr = (await redis.get<AdditionalPayment[]>(KEY)) ?? [];
  let pay = 0, refund = 0, sk = 0;
  for (const p of arr) {
    if (!p?.id) { sk++; continue; }
    const row: AdditionalPaymentInsert = {
      id: p.id,
      reservationNumber: p.reservationNumber,
      description: p.description,
      amountCzk: String(p.amountCzk),
      guestEmail: p.guestEmail ?? null,
      guestName: p.guestName ?? null,
      status: p.status,
      createdAt: new Date(p.createdAt),
      paidAt: p.paidAt ? new Date(p.paidAt) : null,
      invoiceId: p.invoiceId ?? null,
      stripeFeeCzk: n(p.stripeFeeCzk),
      isMainPayment: p.isMainPayment ?? null,
    };
    const { id: _id, ...set } = row;
    await db.insert(additionalPayments).values(row).onConflictDoUpdate({ target: additionalPayments.id, set });
    pay++;

    for (const r of p.refunds ?? []) {
      if (!r?.id) continue;
      const rrow: PaymentRefundInsert = {
        id: r.id,
        additionalPaymentId: p.id,
        amountCzk: String(r.amountCzk),
        refundedAt: new Date(r.refundedAt),
        reason: r.reason ?? null,
        refundedBy: r.refundedBy ?? null,
        status: r.status,
        failureReason: r.failureReason ?? null,
      };
      const { id: _rid, ...rset } = rrow;
      await db.insert(paymentRefunds).values(rrow).onConflictDoUpdate({ target: paymentRefunds.id, set: rset });
      refund++;
    }
  }
  console.log(JSON.stringify({ redisCount: arr.length, paymentsUpserted: pay, refundsUpserted: refund, skipped: sk }, null, 2));
}
main().catch((e) => { console.error('❌ backfill failed:', e); process.exit(1); });

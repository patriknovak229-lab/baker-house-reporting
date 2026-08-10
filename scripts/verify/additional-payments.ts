/** Parity: baker:additional-payments vs additional_payments (+ payment_refunds). */
import '../_loadEnv';
import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { additionalPayments, paymentRefunds } from '../../lib/db/schema';
import type { AdditionalPayment, PaymentRefund } from '../../types/additionalPayment';

const KEY = 'baker:additional-payments';
const norm = (x: string | null | undefined) => (x == null || x === '' ? null : x);
const epoch = (v: string | Date | null | undefined) => (v ? new Date(v).getTime() : null);
const num = (x: number | string | null | undefined) => (x == null ? null : Number(x));
const boolN = (x: boolean | null | undefined) => x ?? null;

async function main() {
  const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });
  const raw = ((await redis.get<AdditionalPayment[]>(KEY)) ?? []).filter((x) => x?.id);
  const a = new Map(raw.map((x) => [x.id, x] as const));
  const b = new Map((await db.select().from(additionalPayments)).map((r) => [r.id, r] as const));
  const m: string[] = [];
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(id); const y = b.get(id);
    if (!x) { m.push(`pay ${id}: PG only`); continue; }
    if (!y) { m.push(`pay ${id}: Redis only`); continue; }
    if (x.reservationNumber !== y.reservationNumber) m.push(`pay ${id}: reservationNumber`);
    if (x.description !== y.description) m.push(`pay ${id}: description`);
    if (num(x.amountCzk) !== num(y.amountCzk)) m.push(`pay ${id}: amountCzk`);
    if (norm(x.guestEmail) !== norm(y.guestEmail)) m.push(`pay ${id}: guestEmail`);
    if (norm(x.guestName) !== norm(y.guestName)) m.push(`pay ${id}: guestName`);
    if (x.status !== y.status) m.push(`pay ${id}: status`);
    if (epoch(x.createdAt) !== epoch(y.createdAt)) m.push(`pay ${id}: createdAt`);
    if (epoch(x.paidAt) !== epoch(y.paidAt)) m.push(`pay ${id}: paidAt`);
    if (norm(x.invoiceId) !== norm(y.invoiceId)) m.push(`pay ${id}: invoiceId`);
    if (num(x.stripeFeeCzk) !== num(y.stripeFeeCzk)) m.push(`pay ${id}: stripeFeeCzk`);
    if (boolN(x.isMainPayment) !== boolN(y.isMainPayment)) m.push(`pay ${id}: isMainPayment`);
  }

  // Refunds (flatten redis, compare to child table by refund id)
  const ra = new Map<string, { parent: string; r: PaymentRefund }>();
  for (const p of raw) for (const r of p.refunds ?? []) if (r?.id) ra.set(r.id, { parent: p.id, r });
  const rb = new Map((await db.select().from(paymentRefunds)).map((r) => [r.id, r] as const));
  for (const id of new Set([...ra.keys(), ...rb.keys()])) {
    const x = ra.get(id); const y = rb.get(id);
    if (!x) { m.push(`refund ${id}: PG only`); continue; }
    if (!y) { m.push(`refund ${id}: Redis only`); continue; }
    if (x.parent !== y.additionalPaymentId) m.push(`refund ${id}: additionalPaymentId`);
    if (num(x.r.amountCzk) !== num(y.amountCzk)) m.push(`refund ${id}: amountCzk`);
    if (epoch(x.r.refundedAt) !== epoch(y.refundedAt)) m.push(`refund ${id}: refundedAt`);
    if (norm(x.r.reason) !== norm(y.reason)) m.push(`refund ${id}: reason`);
    if (norm(x.r.refundedBy) !== norm(y.refundedBy)) m.push(`refund ${id}: refundedBy`);
    if (x.r.status !== y.status) m.push(`refund ${id}: status`);
    if (norm(x.r.failureReason) !== norm(y.failureReason)) m.push(`refund ${id}: failureReason`);
  }

  console.log(JSON.stringify({ payments: { redis: a.size, pg: b.size }, refunds: { redis: ra.size, pg: rb.size }, mismatches: m }, null, 2));
  if (m.length) { console.error(`❌ ${m.length} mismatch(es)`); process.exit(1); }
  console.log('✅ parity OK');
}
main().catch((e) => { console.error('❌ verify failed:', e); process.exit(1); });

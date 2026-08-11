/**
 * Flag-aware store for Stripe additional payments (+ embedded refunds) — the
 * single read/write boundary the payment routes + reconciliation engine use
 * instead of touching Redis directly. `STORE_ADDITIONAL_PAYMENTS`
 * (redis|dual|postgres, default redis) selects the backend; the Postgres
 * repository is imported lazily so the redis path never loads the DB client.
 *
 * Preserves the routes' whole-array read-modify-write semantics exactly. On the
 * Postgres side, refunds are split into / reassembled from the payment_refunds
 * child table transparently (see data-access), so callers keep treating each
 * payment's `refunds[]` as embedded — including the net-paid calc in
 * utils/paymentReconcile.ts.
 *
 * SCOPE: only the baker:additional-payments key moves. The revenue_invoices and
 * reservation-overrides that these routes / the engine also touch stay on Redis
 * (later waves), as does everything else.
 */
import { Redis } from '@upstash/redis';
import type { AdditionalPayment } from '@/types/additionalPayment';
import { readsFromPostgres, writesToPostgres, writesToRedis } from '@/lib/dataStore';

const KEY = 'baker:additional-payments';
const DOMAIN = 'additionalPayments' as const;

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function pg() {
  return import('@/data-access/additionalPayments');
}

export async function readAllAdditionalPayments(): Promise<AdditionalPayment[]> {
  if (readsFromPostgres(DOMAIN)) return (await pg()).listAdditionalPaymentsPg();
  const redis = getRedis();
  if (!redis) return [];
  return (await redis.get<AdditionalPayment[]>(KEY)) ?? [];
}

export async function writeAllAdditionalPayments(items: AdditionalPayment[]): Promise<void> {
  if (writesToRedis(DOMAIN)) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis not configured');
    await redis.set(KEY, items);
  }
  if (writesToPostgres(DOMAIN)) {
    await (await pg()).replaceAllAdditionalPaymentsPg(items);
  }
}

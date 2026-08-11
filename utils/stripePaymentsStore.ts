/**
 * Flag-aware store for the completed-Stripe-Checkout mirror — the single
 * read/write boundary the stripe webhook (append) and check-payment (read) use
 * instead of touching Redis directly. `STORE_STRIPE_PAYMENTS`
 * (redis|dual|postgres, default redis) selects the backend; the Postgres
 * repository is imported lazily so the redis path never loads the DB client.
 *
 * Preserves the webhook's whole-array append semantics. The Postgres path
 * dedups by sessionId (see data-access) since session_id is the PK; the Redis
 * path stores the array verbatim (no PK), exactly as before.
 *
 * SCOPE: only the baker:stripe-payments key moves. Refunds/fees/status live in
 * baker:additional-payments and are NOT touched by this store.
 */
import { Redis } from '@upstash/redis';
import type { StripePaymentRecord } from '@/app/api/stripe/webhook/route';
import { readsFromPostgres, writesToPostgres, writesToRedis } from '@/lib/dataStore';

const KEY = 'baker:stripe-payments';
const DOMAIN = 'stripePayments' as const;

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function pg() {
  return import('@/data-access/stripePayments');
}

export async function readAllStripePayments(): Promise<StripePaymentRecord[]> {
  if (readsFromPostgres(DOMAIN)) return (await pg()).listStripePaymentsPg();
  const redis = getRedis();
  if (!redis) return [];
  return (await redis.get<StripePaymentRecord[]>(KEY)) ?? [];
}

export async function writeAllStripePayments(items: StripePaymentRecord[]): Promise<void> {
  if (writesToRedis(DOMAIN)) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis not configured');
    await redis.set(KEY, items);
  }
  if (writesToPostgres(DOMAIN)) {
    await (await pg()).replaceAllStripePaymentsPg(items);
  }
}

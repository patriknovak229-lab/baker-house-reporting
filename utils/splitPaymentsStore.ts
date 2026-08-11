/**
 * Flag-aware store for scheduled split payments — the single read/write boundary
 * the split-payments routes use instead of touching Redis directly.
 * `STORE_SPLIT_PAYMENTS` (redis|dual|postgres, default redis) selects the
 * backend; the Postgres repository is imported lazily so the redis path never
 * loads the DB client. Preserves the routes' whole-array read-modify-write
 * semantics exactly.
 *
 * SCOPE: only the baker:scheduled-split-payments key moves. The parallel
 * AdditionalPayment records (baker:additional-payments) that these same routes
 * create/mutate are handled by additionalPaymentsStore, not this store.
 */
import { Redis } from '@upstash/redis';
import type { SplitPayment } from '@/types/splitPayment';
import { readsFromPostgres, writesToPostgres, writesToRedis } from '@/lib/dataStore';

const KEY = 'baker:scheduled-split-payments';
const DOMAIN = 'splitPayments' as const;

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function pg() {
  return import('@/data-access/splitPayments');
}

export async function readAllSplitPayments(): Promise<SplitPayment[]> {
  if (readsFromPostgres(DOMAIN)) return (await pg()).listSplitPaymentsPg();
  const redis = getRedis();
  if (!redis) return [];
  return (await redis.get<SplitPayment[]>(KEY)) ?? [];
}

export async function writeAllSplitPayments(items: SplitPayment[]): Promise<void> {
  if (writesToRedis(DOMAIN)) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis not configured');
    await redis.set(KEY, items);
  }
  if (writesToPostgres(DOMAIN)) {
    await (await pg()).replaceAllSplitPaymentsPg(items);
  }
}

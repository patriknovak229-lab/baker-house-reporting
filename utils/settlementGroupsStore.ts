/**
 * Flag-aware store for OTA settlement groups — the single read/write boundary
 * the settlement-groups + statements routes use instead of touching Redis
 * directly. `STORE_SETTLEMENT_GROUPS` (redis|dual|postgres, default redis)
 * selects the backend; the Postgres repository is imported lazily so the redis
 * path never loads the DB client.
 *
 * Three ops mirror the routes:
 *   - readAll  → GET + statements reads
 *   - writeAll → settlement-groups/[id] PUT/DELETE (whole-array set)
 *   - append   → settlement-groups POST (concurrency-safe append; on the Redis
 *                path delegates to appendRecords for the verify-and-retry
 *                behaviour, on Postgres inserts with onConflictDoNothing)
 *
 * SCOPE: only the baker:settlement-groups key moves. The bank_transactions,
 * supplier_invoices and revenue_invoices that these same routes cross-mutate
 * (incl. the appendRecords calls for those keys) stay on Redis — later waves.
 */
import { Redis } from '@upstash/redis';
import type { SettlementGroup } from '@/types/settlementGroup';
import { appendRecords } from '@/utils/settlementRecords';
import { readsFromPostgres, writesToPostgres, writesToRedis } from '@/lib/dataStore';

const KEY = 'baker:settlement-groups';
const DOMAIN = 'settlementGroups' as const;

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function pg() {
  return import('@/data-access/settlementGroups');
}

export async function readAllSettlementGroups(): Promise<SettlementGroup[]> {
  if (readsFromPostgres(DOMAIN)) return (await pg()).listSettlementGroupsPg();
  const redis = getRedis();
  if (!redis) return [];
  return (await redis.get<SettlementGroup[]>(KEY)) ?? [];
}

export async function writeAllSettlementGroups(items: SettlementGroup[]): Promise<void> {
  if (writesToRedis(DOMAIN)) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis not configured');
    await redis.set(KEY, items);
  }
  if (writesToPostgres(DOMAIN)) {
    await (await pg()).replaceAllSettlementGroupsPg(items);
  }
}

/** Concurrency-safe append (settlement-groups POST). Preserves the Redis
 *  verify-and-retry behaviour via appendRecords; inserts on the Postgres side. */
export async function appendSettlementGroups(items: SettlementGroup[]): Promise<void> {
  if (writesToRedis(DOMAIN)) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis not configured');
    await appendRecords(redis, KEY, items);
  }
  if (writesToPostgres(DOMAIN)) {
    await (await pg()).appendSettlementGroupsPg(items);
  }
}

/**
 * Flag-aware store for revenue invoices — the single read/write boundary the
 * revenue-invoices routes, statements reads and the OTA-settlement flow use
 * instead of touching Redis directly. `STORE_REVENUE_INVOICES`
 * (redis|dual|postgres, default redis) selects the backend; the Postgres
 * repository is imported lazily so the redis path never loads the DB client.
 *
 * Three ops mirror the call sites:
 *   - readAll  → GET + statements/settlement/reconcile reads
 *   - writeAll → CRUD read-modify-write (whole-array set)
 *   - append   → OTA settlement gross-revenue record (concurrency-safe append;
 *                on the Redis path delegates to appendRecords for verify-and-retry,
 *                on Postgres inserts with onConflictDoNothing)
 *
 * SCOPE: only the baker:revenue-invoices key moves. Any bank_transactions /
 * settlement_groups the same routes cross-mutate stay on their own stores.
 */
import { Redis } from '@upstash/redis';
import type { RevenueInvoice } from '@/types/revenueInvoice';
import { appendRecords, REVENUE_KEY } from '@/utils/settlementRecords';
import { readsFromPostgres, writesToPostgres, writesToRedis } from '@/lib/dataStore';

const KEY = REVENUE_KEY;
const DOMAIN = 'revenueInvoices' as const;

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function pg() {
  return import('@/data-access/revenueInvoices');
}

export async function readAllRevenueInvoices(): Promise<RevenueInvoice[]> {
  if (readsFromPostgres(DOMAIN)) return (await pg()).listRevenueInvoicesPg();
  const redis = getRedis();
  if (!redis) return [];
  return (await redis.get<RevenueInvoice[]>(KEY)) ?? [];
}

export async function writeAllRevenueInvoices(items: RevenueInvoice[]): Promise<void> {
  if (writesToRedis(DOMAIN)) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis not configured');
    await redis.set(KEY, items);
  }
  if (writesToPostgres(DOMAIN)) {
    await (await pg()).replaceAllRevenueInvoicesPg(items);
  }
}

/** Concurrency-safe append (OTA settlement gross-revenue record). Preserves the
 *  Redis verify-and-retry behaviour via appendRecords; inserts on Postgres. */
export async function appendRevenueInvoices(items: RevenueInvoice[]): Promise<void> {
  if (writesToRedis(DOMAIN)) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis not configured');
    await appendRecords(redis, KEY, items);
  }
  if (writesToPostgres(DOMAIN)) {
    await (await pg()).appendRevenueInvoicesPg(items);
  }
}

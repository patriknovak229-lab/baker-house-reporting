/**
 * Flag-aware store for the supplier auto-process whitelist — the single
 * read/write boundary the whitelist route uses instead of touching Redis
 * directly. `STORE_SUPPLIER_WHITELIST` (redis|dual|postgres, default redis)
 * selects the backend; the Postgres repository is imported lazily so the redis
 * path never loads the DB client. Preserves the route's whole-array set
 * semantics exactly.
 */
import { Redis } from '@upstash/redis';
import type { WhitelistedSupplier } from '@/types/supplierInvoice';
import { readsFromPostgres, writesToPostgres, writesToRedis } from '@/lib/dataStore';

const KEY = 'baker:supplier-whitelist';
const DOMAIN = 'supplierWhitelist' as const;

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function pg() {
  return import('@/data-access/accountingConfig');
}

export async function readAllSupplierWhitelist(): Promise<WhitelistedSupplier[]> {
  if (readsFromPostgres(DOMAIN)) return (await pg()).listSupplierWhitelistPg();
  const redis = getRedis();
  if (!redis) return [];
  return (await redis.get<WhitelistedSupplier[]>(KEY)) ?? [];
}

export async function writeAllSupplierWhitelist(items: WhitelistedSupplier[]): Promise<void> {
  if (writesToRedis(DOMAIN)) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis not configured');
    await redis.set(KEY, items);
  }
  if (writesToPostgres(DOMAIN)) {
    await (await pg()).replaceAllSupplierWhitelistPg(items);
  }
}

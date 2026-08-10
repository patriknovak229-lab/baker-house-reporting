/**
 * Flag-aware store for vouchers — the single read/write boundary the voucher
 * routes use instead of touching Redis directly. `STORE_VOUCHERS`
 * (redis|dual|postgres, default redis) selects the backend; the Postgres
 * repository is imported lazily so the redis path never loads the DB client.
 * Preserves the routes' whole-array read-modify-write semantics exactly.
 */
import { Redis } from '@upstash/redis';
import type { Voucher } from '@/types/voucher';
import { readsFromPostgres, writesToPostgres, writesToRedis } from '@/lib/dataStore';

const KEY = 'baker:vouchers';
const DOMAIN = 'vouchers' as const;

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function pg() {
  return import('@/data-access/vouchers');
}

export async function readAllVouchers(): Promise<Voucher[]> {
  if (readsFromPostgres(DOMAIN)) return (await pg()).listVouchersPg();
  const redis = getRedis();
  if (!redis) return [];
  return (await redis.get<Voucher[]>(KEY)) ?? [];
}

export async function writeAllVouchers(items: Voucher[]): Promise<void> {
  if (writesToRedis(DOMAIN)) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis not configured');
    await redis.set(KEY, items);
  }
  if (writesToPostgres(DOMAIN)) {
    await (await pg()).replaceAllVouchersPg(items);
  }
}

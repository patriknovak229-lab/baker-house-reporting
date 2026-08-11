/**
 * Flag-aware store for owner commission settlements — the single read/write
 * boundary the Commission-tab routes use instead of touching Redis directly.
 * `STORE_COMMISSION_SETTLEMENTS` (redis|dual|postgres, default redis) selects
 * the backend; the Postgres repository is imported lazily so the redis path
 * never loads the DB client. Preserves the routes' whole-array read-modify-write
 * semantics exactly. Commission math is untouched — this only moves storage.
 *
 * NOTE: the bank-transaction reconciliation link (commission/[id]) writes the
 * settlement's bankTransactionId through THIS store, but the reciprocal
 * bankTransaction.commissionSettlementId still writes to Redis directly
 * (bank_transactions is a later wave).
 */
import { Redis } from '@upstash/redis';
import type { CommissionSettlement } from '@/types/commissionSettlement';
import { readsFromPostgres, writesToPostgres, writesToRedis } from '@/lib/dataStore';

const KEY = 'baker:commission-settlements';
const DOMAIN = 'commissionSettlements' as const;

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function pg() {
  return import('@/data-access/commissionSettlements');
}

export async function readAllCommissionSettlements(): Promise<CommissionSettlement[]> {
  if (readsFromPostgres(DOMAIN)) return (await pg()).listCommissionSettlementsPg();
  const redis = getRedis();
  if (!redis) return [];
  return (await redis.get<CommissionSettlement[]>(KEY)) ?? [];
}

export async function writeAllCommissionSettlements(items: CommissionSettlement[]): Promise<void> {
  if (writesToRedis(DOMAIN)) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis not configured');
    await redis.set(KEY, items);
  }
  if (writesToPostgres(DOMAIN)) {
    await (await pg()).replaceAllCommissionSettlementsPg(items);
  }
}

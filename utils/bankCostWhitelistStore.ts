/**
 * Flag-aware store for the bank recurring-cost whitelist — the read/write
 * boundary the recurring-cost classify action and the CSV-import auto-classify
 * use instead of touching Redis directly. `STORE_BANK_COST_WHITELIST`
 * (redis|dual|postgres, default redis) selects the backend; the Postgres
 * repository is imported lazily so the redis path never loads the DB client.
 * Preserves the routes' whole-array read-modify-write semantics.
 *
 * SCOPE: only the baker:bank-cost-whitelist key moves. The bank_transactions it
 * co-resides with in the reconcile routes go through their own store; the rule-
 * matching logic (matchesCostRule/buildRuleFromTx in types/bankCostWhitelist)
 * is untouched.
 */
import { Redis } from '@upstash/redis';
import type { BankCostRule } from '@/types/bankCostWhitelist';
import { BANK_COST_WHITELIST_KEY } from '@/types/bankCostWhitelist';
import { readsFromPostgres, writesToPostgres, writesToRedis } from '@/lib/dataStore';

const KEY = BANK_COST_WHITELIST_KEY;
const DOMAIN = 'bankCostWhitelist' as const;

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function pg() {
  return import('@/data-access/accountingConfig');
}

export async function readAllBankCostWhitelist(): Promise<BankCostRule[]> {
  if (readsFromPostgres(DOMAIN)) return (await pg()).listBankCostWhitelistPg();
  const redis = getRedis();
  if (!redis) return [];
  return (await redis.get<BankCostRule[]>(KEY)) ?? [];
}

export async function writeAllBankCostWhitelist(items: BankCostRule[]): Promise<void> {
  if (writesToRedis(DOMAIN)) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis not configured');
    await redis.set(KEY, items);
  }
  if (writesToPostgres(DOMAIN)) {
    await (await pg()).replaceAllBankCostWhitelistPg(items);
  }
}

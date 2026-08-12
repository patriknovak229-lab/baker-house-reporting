/**
 * Flag-aware store for bank-statement transactions — the single read/write
 * boundary the reconcile cluster, the bank-transactions CRUD/import routes, the
 * statements readers, and the cross-linking routes (revenue-invoices link_bank,
 * settlement-groups, commission) use instead of touching Redis directly.
 * `STORE_BANK_TRANSACTIONS` (redis|dual|postgres, default redis) selects the
 * backend; the Postgres repository is imported lazily so the redis path never
 * loads the DB client. Preserves the routes' whole-array read-modify-write.
 *
 * HARD-RULE domain — storage swap only. Reconciliation math (utils/paymentReconcile,
 * bank-transactions reconcile/[id]/import, reconcileSuggest) reads this list
 * through readAll unchanged. Co-located keys stay on their own stores:
 * supplier_invoices, revenue_invoices, settlement_groups, commission_settlements
 * (migrated stores); bank_cost_whitelist (its own store); reservation_overrides
 * (still Redis until its own cutover).
 */
import { Redis } from '@upstash/redis';
import type { BankTransaction } from '@/types/bankTransaction';
import { readsFromPostgres, writesToPostgres, writesToRedis } from '@/lib/dataStore';

const KEY = 'baker:bank-transactions';
const DOMAIN = 'bankTransactions' as const;

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function pg() {
  return import('@/data-access/bankTransactions');
}

export async function readAllBankTransactions(): Promise<BankTransaction[]> {
  if (readsFromPostgres(DOMAIN)) return (await pg()).listBankTransactionsPg();
  const redis = getRedis();
  if (!redis) return [];
  return (await redis.get<BankTransaction[]>(KEY)) ?? [];
}

export async function writeAllBankTransactions(items: BankTransaction[]): Promise<void> {
  if (writesToRedis(DOMAIN)) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis not configured');
    await redis.set(KEY, items);
  }
  if (writesToPostgres(DOMAIN)) {
    await (await pg()).replaceAllBankTransactionsPg(items);
  }
}

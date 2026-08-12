/**
 * Flag-aware store for supplier invoices — the single read/write boundary the
 * supplier-invoices routes, reconciliation reads and the OTA-settlement flow use
 * instead of touching Redis directly. `STORE_SUPPLIER_INVOICES`
 * (redis|dual|postgres, default redis) selects the backend; the Postgres
 * repository is imported lazily so the redis path never loads the DB client.
 *
 * Three ops mirror the call sites:
 *   - readAll  → GET + reconcile/statements/settlement reads
 *   - writeAll → CRUD read-modify-write (whole-array set)
 *   - append   → OTA settlement channel-fees cost record (concurrency-safe
 *                append; on the Redis path delegates to appendRecords for
 *                verify-and-retry, on Postgres inserts with onConflictDoNothing)
 *
 * SCOPE: only the baker:supplier-invoices key moves. Reconciliation math
 * (utils/paymentReconcile, bank-transactions reconcile) reads this list through
 * readAll unchanged — storage swap only, no logic change. Co-located keys
 * (bank_transactions, settlement_groups, the config whitelists) stay on their
 * own stores.
 */
import { Redis } from '@upstash/redis';
import type { SupplierInvoice } from '@/types/supplierInvoice';
import { appendRecords, SUPPLIER_KEY } from '@/utils/settlementRecords';
import { readsFromPostgres, writesToPostgres, writesToRedis } from '@/lib/dataStore';

const KEY = SUPPLIER_KEY;
const DOMAIN = 'supplierInvoices' as const;

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function pg() {
  return import('@/data-access/supplierInvoices');
}

export async function readAllSupplierInvoices(): Promise<SupplierInvoice[]> {
  if (readsFromPostgres(DOMAIN)) return (await pg()).listSupplierInvoicesPg();
  const redis = getRedis();
  if (!redis) return [];
  return (await redis.get<SupplierInvoice[]>(KEY)) ?? [];
}

export async function writeAllSupplierInvoices(items: SupplierInvoice[]): Promise<void> {
  if (writesToRedis(DOMAIN)) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis not configured');
    await redis.set(KEY, items);
  }
  if (writesToPostgres(DOMAIN)) {
    await (await pg()).replaceAllSupplierInvoicesPg(items);
  }
}

/** Concurrency-safe append (OTA settlement channel-fees cost record). Preserves
 *  the Redis verify-and-retry behaviour via appendRecords; inserts on Postgres. */
export async function appendSupplierInvoices(items: SupplierInvoice[]): Promise<void> {
  if (writesToRedis(DOMAIN)) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis not configured');
    await appendRecords(redis, KEY, items);
  }
  if (writesToPostgres(DOMAIN)) {
    await (await pg()).appendSupplierInvoicesPg(items);
  }
}

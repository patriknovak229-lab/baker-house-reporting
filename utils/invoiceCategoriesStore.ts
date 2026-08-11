/**
 * Flag-aware store for supplier-invoice categories — the single read/write
 * boundary the categories route uses instead of touching Redis directly.
 * `STORE_INVOICE_CATEGORIES` (redis|dual|postgres, default redis) selects the
 * backend; the Postgres repository is imported lazily so the redis path never
 * loads the DB client. Preserves the route's whole-array set semantics exactly
 * (default-seeding + colour self-heal stay in the route).
 */
import { Redis } from '@upstash/redis';
import type { InvoiceCategory } from '@/types/supplierInvoice';
import { readsFromPostgres, writesToPostgres, writesToRedis } from '@/lib/dataStore';

const KEY = 'baker:invoice-categories';
const DOMAIN = 'invoiceCategories' as const;

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function pg() {
  return import('@/data-access/accountingConfig');
}

export async function readAllInvoiceCategories(): Promise<InvoiceCategory[]> {
  if (readsFromPostgres(DOMAIN)) return (await pg()).listInvoiceCategoriesPg();
  const redis = getRedis();
  if (!redis) return [];
  return (await redis.get<InvoiceCategory[]>(KEY)) ?? [];
}

export async function writeAllInvoiceCategories(items: InvoiceCategory[]): Promise<void> {
  if (writesToRedis(DOMAIN)) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis not configured');
    await redis.set(KEY, items);
  }
  if (writesToPostgres(DOMAIN)) {
    await (await pg()).replaceAllInvoiceCategoriesPg(items);
  }
}

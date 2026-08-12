/**
 * Flag-aware store for auto-detected guest invoice requests — the single
 * read/write boundary the webhook detector, the awaiting-info multi-turn flow,
 * the operator Accept/Reject routes and the display readers use instead of
 * touching Redis directly. `STORE_INVOICE_REQUESTS` (redis|dual|postgres,
 * default redis) selects the backend; the Postgres repository is imported lazily
 * so the redis path never loads the DB client. Preserves the routes' whole-array
 * read-modify-write semantics (dedup by beds24MessageId lives in the routes).
 *
 * SCOPE: only the baker:invoice-requests key moves. The co-located auto-reply
 * pipeline keys (processed/pending/debounce/etc.), the auto-reply logs (own
 * store) and reservation-overrides stay on Redis — the routes keep their Redis
 * client for those.
 */
import { Redis } from '@upstash/redis';
import type { InvoiceRequest } from '@/types/invoiceRequest';
import { readsFromPostgres, writesToPostgres, writesToRedis } from '@/lib/dataStore';

const KEY = 'baker:invoice-requests';
const DOMAIN = 'invoiceRequests' as const;

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function pg() {
  return import('@/data-access/invoiceRequests');
}

export async function readAllInvoiceRequests(): Promise<InvoiceRequest[]> {
  if (readsFromPostgres(DOMAIN)) return (await pg()).listInvoiceRequestsPg();
  const redis = getRedis();
  if (!redis) return [];
  return (await redis.get<InvoiceRequest[]>(KEY)) ?? [];
}

export async function writeAllInvoiceRequests(items: InvoiceRequest[]): Promise<void> {
  if (writesToRedis(DOMAIN)) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis not configured');
    await redis.set(KEY, items);
  }
  if (writesToPostgres(DOMAIN)) {
    await (await pg()).replaceAllInvoiceRequestsPg(items);
  }
}

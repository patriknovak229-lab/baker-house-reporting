/**
 * Flag-aware store for the single Gmail-invoice OAuth credential — the read/
 * write/delete boundary the connect-gmail callback (write), status (read),
 * disconnect (delete), the Gmail-scan (read) and createInvoiceGmailClient
 * (read) use instead of touching Redis directly. `STORE_GMAIL_INVOICE_TOKEN`
 * (redis|dual|postgres, default redis) selects the backend; the Postgres
 * repository is imported lazily so the redis path never loads the DB client.
 *
 * Single value, NOT an array — three ops: read / write (upsert) / delete
 * (disconnect). The delete mirrors `redis.del` so disconnect clears both stores
 * in dual mode.
 *
 * SCOPE: only the baker:gmail-invoice-token key moves. The OAuth CSRF state
 * (baker:gmail-oauth-state) and the Drive folder caches stay on Redis — the
 * callback/scan routes keep their Redis client for those.
 */
import { Redis } from '@upstash/redis';
import type { GmailInvoiceToken } from '@/app/api/accounting/connect-gmail/callback/route';
import { readsFromPostgres, writesToPostgres, writesToRedis } from '@/lib/dataStore';

const KEY = 'baker:gmail-invoice-token';
const DOMAIN = 'gmailInvoiceToken' as const;

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function pg() {
  return import('@/data-access/gmailInvoiceToken');
}

export async function readGmailInvoiceToken(): Promise<GmailInvoiceToken | null> {
  if (readsFromPostgres(DOMAIN)) return (await pg()).readGmailInvoiceTokenPg();
  const redis = getRedis();
  if (!redis) return null;
  return (await redis.get<GmailInvoiceToken>(KEY)) ?? null;
}

export async function writeGmailInvoiceToken(token: GmailInvoiceToken): Promise<void> {
  if (writesToRedis(DOMAIN)) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis not configured');
    await redis.set(KEY, token);
  }
  if (writesToPostgres(DOMAIN)) {
    await (await pg()).writeGmailInvoiceTokenPg(token);
  }
}

export async function deleteGmailInvoiceToken(): Promise<void> {
  if (writesToRedis(DOMAIN)) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis not configured');
    await redis.del(KEY);
  }
  if (writesToPostgres(DOMAIN)) {
    await (await pg()).deleteGmailInvoiceTokenPg();
  }
}

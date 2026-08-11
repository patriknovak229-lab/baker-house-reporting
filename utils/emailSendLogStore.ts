/**
 * Flag-aware store for the guest-message audit log — the single read/write
 * boundary the send/log routes use instead of touching Redis directly.
 * `STORE_EMAIL_SEND_LOG` (redis|dual|postgres, default redis) selects the
 * backend; the Postgres repository is imported lazily so the redis path never
 * loads the DB client. Preserves the routes' whole-array read-modify-write
 * semantics exactly.
 */
import { Redis } from '@upstash/redis';
import type { EmailSendLogEntry } from '@/types/emailSendLog';
import { readsFromPostgres, writesToPostgres, writesToRedis } from '@/lib/dataStore';

const KEY = 'baker:email-send-log';
const DOMAIN = 'emailSendLog' as const;

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function pg() {
  return import('@/data-access/emailSendLog');
}

export async function readAllEmailSendLog(): Promise<EmailSendLogEntry[]> {
  if (readsFromPostgres(DOMAIN)) return (await pg()).listEmailSendLogPg();
  const redis = getRedis();
  if (!redis) return [];
  return (await redis.get<EmailSendLogEntry[]>(KEY)) ?? [];
}

export async function writeAllEmailSendLog(items: EmailSendLogEntry[]): Promise<void> {
  if (writesToRedis(DOMAIN)) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis not configured');
    await redis.set(KEY, items);
  }
  if (writesToPostgres(DOMAIN)) {
    await (await pg()).replaceAllEmailSendLogPg(items);
  }
}

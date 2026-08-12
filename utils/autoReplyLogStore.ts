/**
 * Flag-aware store for the auto-reply audit logs — the single read/write
 * boundary the webhook/draft writers and the display/messages readers use
 * instead of touching Redis directly. `STORE_AUTO_REPLY_LOG`
 * (redis|dual|postgres, default redis) selects the backend; the Postgres
 * repository is imported lazily so the redis path never loads the DB client.
 *
 * TWO independent append-only keys, each with its own read/write pair:
 *   - baker:auto-reply:log       (readAllAutoReplyLog / writeAllAutoReplyLog)
 *   - baker:auto-reply:edit-log  (readAllAutoReplyEditLog / writeAllAutoReplyEditLog)
 *
 * The read/write functions are generic over the caller's local entry shape —
 * the two writers pass the full AutoReplyLogEntry (has `id`); readers pass
 * minimal 2–5 field views — so each call site keeps its exact type with no cast.
 *
 * SCOPE: only these two keys move. Every OTHER `baker:auto-reply:*` key
 * (processed set, pending-drafts/others hashes, last-poll, debounce-until,
 * count/category-sent) and the co-located reservation-overrides / invoice-requests
 * stay on Redis — the writer/reader routes keep their Redis client for those.
 * The routes own the whole-array read-modify-write + cap-at-500 logic (which
 * differs by writer — webhook slice(-500), draft slice(0,500)); this store only
 * swaps the load/persist boundary, preserving that logic byte-for-byte.
 */
import { Redis } from '@upstash/redis';
import { readsFromPostgres, writesToPostgres, writesToRedis } from '@/lib/dataStore';

const LOG_KEY = 'baker:auto-reply:log';
const EDIT_LOG_KEY = 'baker:auto-reply:edit-log';
const DOMAIN = 'autoReplyLog' as const;

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function pg() {
  return import('@/data-access/autoReplyLog');
}

// ── log (baker:auto-reply:log) ──────────────────────────────────────────────
export async function readAllAutoReplyLog<T = Record<string, unknown>>(): Promise<T[]> {
  if (readsFromPostgres(DOMAIN)) return (await pg()).listAutoReplyLogPg<T>();
  const redis = getRedis();
  if (!redis) return [];
  return (await redis.get<T[]>(LOG_KEY)) ?? [];
}

export async function writeAllAutoReplyLog<T extends { id: string }>(items: readonly T[]): Promise<void> {
  if (writesToRedis(DOMAIN)) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis not configured');
    await redis.set(LOG_KEY, items);
  }
  if (writesToPostgres(DOMAIN)) {
    await (await pg()).replaceAllAutoReplyLogPg(items);
  }
}

// ── edit-log (baker:auto-reply:edit-log) ────────────────────────────────────
export async function readAllAutoReplyEditLog<T = Record<string, unknown>>(): Promise<T[]> {
  if (readsFromPostgres(DOMAIN)) return (await pg()).listAutoReplyEditLogPg<T>();
  const redis = getRedis();
  if (!redis) return [];
  return (await redis.get<T[]>(EDIT_LOG_KEY)) ?? [];
}

export async function writeAllAutoReplyEditLog<T>(items: readonly T[]): Promise<void> {
  if (writesToRedis(DOMAIN)) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis not configured');
    await redis.set(EDIT_LOG_KEY, items);
  }
  if (writesToPostgres(DOMAIN)) {
    await (await pg()).replaceAllAutoReplyEditLogPg(items);
  }
}

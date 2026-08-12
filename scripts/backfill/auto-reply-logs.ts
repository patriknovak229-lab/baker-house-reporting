/**
 * Backfill the auto-reply audit logs → Postgres:
 *   baker:auto-reply:log       → auto_reply_log       (keyed by entry.id)
 *   baker:auto-reply:edit-log  → auto_reply_edit_log  (keyed by content hash)
 * Full entries stored as jsonb. Idempotent.
 *
 * FULL REPLACE (delete-all → insert), NOT per-row upsert: both keys are capped
 * at 500 in Redis, so the webhook's slice(-500) evicts old entries over time. An
 * upsert-only backfill would leave those evicted rows behind in Postgres (drift
 * → parity failure). Delete-all + insert mirrors the live store's replaceAll and
 * keeps Postgres byte-identical to the current Redis array.
 * Run: npx tsx scripts/backfill/auto-reply-logs.ts
 */
import '../_loadEnv';

import { createHash } from 'node:crypto';
import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { autoReplyLog, autoReplyEditLog } from '../../lib/db/schema';

const LOG_KEY = 'baker:auto-reply:log';
const EDIT_LOG_KEY = 'baker:auto-reply:edit-log';

function canonical(x: unknown): string {
  return JSON.stringify(x, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}
const hashOf = (x: unknown) => createHash('sha256').update(canonical(x)).digest('hex');
const toDate = (v: unknown): Date | null =>
  typeof v === 'string' && v ? new Date(v) : null;

async function main() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });

  // log — keyed by entry.id; skip id-less entries, dedup by id last-wins.
  const log = (await redis.get<Record<string, unknown>[]>(LOG_KEY)) ?? [];
  const byId = new Map<string, Record<string, unknown>>();
  let logSkipped = 0;
  for (const entry of log) {
    const id = entry?.id;
    if (typeof id !== 'string' || !id) { logSkipped++; continue; }
    byId.set(id, entry);
  }
  const logRows = [...byId.entries()].map(([id, entry]) => ({
    id,
    decidedAt: toDate(entry.decidedAt),
    entry,
  }));
  if (logRows.length === 0) {
    await db.delete(autoReplyLog);
  } else {
    await db.batch([db.delete(autoReplyLog), db.insert(autoReplyLog).values(logRows)]);
  }

  // edit-log — keyed by content hash; dedup by hash last-wins.
  const editLog = (await redis.get<Record<string, unknown>[]>(EDIT_LOG_KEY)) ?? [];
  const byHash = new Map<string, Record<string, unknown>>();
  for (const entry of editLog) byHash.set(hashOf(entry), entry);
  const editRows = [...byHash.entries()].map(([hash, entry]) => ({
    hash,
    editedAt: toDate(entry.editedAt),
    entry,
  }));
  if (editRows.length === 0) {
    await db.delete(autoReplyEditLog);
  } else {
    await db.batch([db.delete(autoReplyEditLog), db.insert(autoReplyEditLog).values(editRows)]);
  }

  console.log(
    JSON.stringify(
      {
        log: { redisCount: log.length, rowsInserted: logRows.length, skipped: logSkipped },
        editLog: { redisCount: editLog.length, rowsInserted: editRows.length },
      },
      null,
      2,
    ),
  );
}

main().catch((err) => { console.error('❌ backfill failed:', err); process.exit(1); });

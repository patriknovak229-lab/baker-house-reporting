/**
 * Backfill the auto-reply audit logs → Postgres:
 *   baker:auto-reply:log       → auto_reply_log       (keyed by entry.id)
 *   baker:auto-reply:edit-log  → auto_reply_edit_log  (keyed by content hash)
 * Full entries stored as jsonb. Idempotent.
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

  const log = (await redis.get<Record<string, unknown>[]>(LOG_KEY)) ?? [];
  let logUpserted = 0;
  let logSkipped = 0;
  for (const entry of log) {
    const id = entry?.id;
    if (typeof id !== 'string' || !id) { logSkipped++; continue; }
    const row = { id, decidedAt: toDate(entry.decidedAt), entry };
    await db
      .insert(autoReplyLog)
      .values(row)
      .onConflictDoUpdate({ target: autoReplyLog.id, set: { decidedAt: row.decidedAt, entry } });
    logUpserted++;
  }

  const editLog = (await redis.get<Record<string, unknown>[]>(EDIT_LOG_KEY)) ?? [];
  let editUpserted = 0;
  for (const entry of editLog) {
    const hash = hashOf(entry);
    const row = { hash, editedAt: toDate(entry.editedAt), entry };
    await db
      .insert(autoReplyEditLog)
      .values(row)
      .onConflictDoUpdate({ target: autoReplyEditLog.hash, set: { editedAt: row.editedAt, entry } });
    editUpserted++;
  }

  console.log(
    JSON.stringify(
      {
        log: { redisCount: log.length, rowsUpserted: logUpserted, skipped: logSkipped },
        editLog: { redisCount: editLog.length, rowsUpserted: editUpserted },
      },
      null,
      2,
    ),
  );
}

main().catch((err) => { console.error('❌ backfill failed:', err); process.exit(1); });

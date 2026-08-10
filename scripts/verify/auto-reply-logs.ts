/** Parity: auto-reply log + edit-log (Redis) vs Postgres (full-entry jsonb). */
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

async function main() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });

  const mismatches: string[] = [];

  // log — keyed by entry.id
  const log = (await redis.get<Record<string, unknown>[]>(LOG_KEY)) ?? [];
  const logRedis = new Map<string, unknown>();
  for (const e of log) if (typeof e?.id === 'string') logRedis.set(e.id, e);
  const logRows = await db.select().from(autoReplyLog);
  const logPg = new Map(logRows.map((r) => [r.id, r.entry] as const));
  for (const id of new Set([...logRedis.keys(), ...logPg.keys()])) {
    const a = logRedis.get(id);
    const b = logPg.get(id);
    if (a === undefined) { mismatches.push(`log ${id}: in Postgres only`); continue; }
    if (b === undefined) { mismatches.push(`log ${id}: in Redis only`); continue; }
    if (canonical(a) !== canonical(b)) mismatches.push(`log ${id}: entry differs`);
  }

  // edit-log — keyed by content hash
  const editLog = (await redis.get<Record<string, unknown>[]>(EDIT_LOG_KEY)) ?? [];
  const editRedis = new Map<string, unknown>();
  for (const e of editLog) editRedis.set(hashOf(e), e);
  const editRows = await db.select().from(autoReplyEditLog);
  const editPg = new Map(editRows.map((r) => [r.hash, r.entry] as const));
  for (const h of new Set([...editRedis.keys(), ...editPg.keys()])) {
    const a = editRedis.get(h);
    const b = editPg.get(h);
    if (a === undefined) { mismatches.push(`edit ${h.slice(0, 8)}: in Postgres only`); continue; }
    if (b === undefined) { mismatches.push(`edit ${h.slice(0, 8)}: in Redis only`); continue; }
    if (canonical(a) !== canonical(b)) mismatches.push(`edit ${h.slice(0, 8)}: entry differs`);
  }

  console.log(
    JSON.stringify(
      {
        log: { redisCount: logRedis.size, postgresCount: logPg.size },
        editLog: { redisCount: editRedis.size, postgresCount: editPg.size },
        mismatches,
      },
      null,
      2,
    ),
  );
  if (mismatches.length) { console.error(`❌ ${mismatches.length} mismatch(es)`); process.exit(1); }
  console.log('✅ parity OK');
}

main().catch((err) => { console.error('❌ verify failed:', err); process.exit(1); });

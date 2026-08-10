/** Parity: baker:email-send-log (Redis) vs email_send_log (Postgres). */
import '../_loadEnv';

import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { emailSendLog } from '../../lib/db/schema';
import type { EmailSendLogEntry } from '../../types/emailSendLog';

const KEY = 'baker:email-send-log';
const norm = (x: string | null | undefined) => (x == null || x === '' ? null : x);
const epoch = (v: string | Date | null | undefined) => (v ? new Date(v).getTime() : null);

async function main() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });

  const arr = (await redis.get<EmailSendLogEntry[]>(KEY)) ?? [];
  const redisMap = new Map<string, EmailSendLogEntry>();
  for (const e of arr) if (e?.id) redisMap.set(e.id, e);

  const rows = await db.select().from(emailSendLog);
  const pgMap = new Map(rows.map((r) => [r.id, r] as const));

  const mismatches: string[] = [];
  for (const id of new Set([...redisMap.keys(), ...pgMap.keys()])) {
    const a = redisMap.get(id);
    const b = pgMap.get(id);
    if (!a) { mismatches.push(`${id}: in Postgres only`); continue; }
    if (!b) { mismatches.push(`${id}: in Redis only`); continue; }
    if (a.reservationNumber !== b.reservationNumber) mismatches.push(`${id}: reservationNumber`);
    if (a.templateId !== b.templateId) mismatches.push(`${id}: templateId`);
    if (a.templateLabel !== b.templateLabel) mismatches.push(`${id}: templateLabel`);
    if (norm(a.channel) !== norm(b.channel)) mismatches.push(`${id}: channel`);
    if (a.to !== b.to) mismatches.push(`${id}: to`);
    if ((a.subject ?? '') !== b.subject) mismatches.push(`${id}: subject`);
    if (epoch(a.sentAt) !== epoch(b.sentAt)) mismatches.push(`${id}: sentAt`);
    if (a.sentBy !== b.sentBy) mismatches.push(`${id}: sentBy`);
  }

  console.log(JSON.stringify({ redisCount: redisMap.size, postgresCount: pgMap.size, mismatches }, null, 2));
  if (mismatches.length) { console.error(`❌ ${mismatches.length} mismatch(es)`); process.exit(1); }
  console.log('✅ parity OK');
}

main().catch((err) => { console.error('❌ verify failed:', err); process.exit(1); });

/**
 * Backfill `baker:email-send-log` (Redis JSON array) → Postgres.
 * Idempotent. Run: npx tsx scripts/backfill/email-send-log.ts
 */
import '../_loadEnv';

import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { emailSendLog } from '../../lib/db/schema';
import type { EmailSendLogInsert } from '../../lib/db/schema/emailSendLog';
import type { EmailSendLogEntry } from '../../types/emailSendLog';

const KEY = 'baker:email-send-log';

async function main() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });

  const arr = (await redis.get<EmailSendLogEntry[]>(KEY)) ?? [];
  let rowsUpserted = 0;
  let skipped = 0;

  for (const e of arr) {
    if (!e?.id) { skipped++; continue; }
    const row: EmailSendLogInsert = {
      id: e.id,
      reservationNumber: e.reservationNumber,
      templateId: e.templateId,
      templateLabel: e.templateLabel,
      channel: e.channel ?? null,
      to: e.to,
      subject: e.subject ?? '',
      sentAt: new Date(e.sentAt),
      sentBy: e.sentBy,
    };
    const { id: _id, ...set } = row;
    await db.insert(emailSendLog).values(row).onConflictDoUpdate({ target: emailSendLog.id, set });
    rowsUpserted++;
  }

  console.log(JSON.stringify({ redisCount: arr.length, rowsUpserted, skipped }, null, 2));
}

main().catch((err) => { console.error('❌ backfill failed:', err); process.exit(1); });

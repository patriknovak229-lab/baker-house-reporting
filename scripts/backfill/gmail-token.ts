/**
 * Backfill `baker:gmail-invoice-token` (single Redis object) → app_settings.
 * Idempotent. Run: npx tsx scripts/backfill/gmail-token.ts
 */
import '../_loadEnv';

import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { appSettings } from '../../lib/db/schema';

const KEY = 'baker:gmail-invoice-token';
const SETTING = 'gmail-invoice-token';

async function main() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });

  const token = await redis.get<{ connectedAt?: string } & Record<string, unknown>>(KEY);
  if (!token) {
    console.log(JSON.stringify({ found: false, rowsUpserted: 0 }, null, 2));
    return;
  }

  const updatedAt = token.connectedAt ? new Date(token.connectedAt) : new Date();
  await db
    .insert(appSettings)
    .values({ key: SETTING, value: token, updatedAt })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: token, updatedAt } });

  console.log(JSON.stringify({ found: true, rowsUpserted: 1 }, null, 2));
}

main().catch((err) => { console.error('❌ backfill failed:', err); process.exit(1); });

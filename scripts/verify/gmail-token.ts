/** Parity: baker:gmail-invoice-token (Redis) vs app_settings['gmail-invoice-token']. */
import '../_loadEnv';

import { Redis } from '@upstash/redis';
import { eq } from 'drizzle-orm';
import { db } from '../../lib/db';
import { appSettings } from '../../lib/db/schema';

const KEY = 'baker:gmail-invoice-token';
const SETTING = 'gmail-invoice-token';

function canonical(x: unknown): string {
  return JSON.stringify(x, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

async function main() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });

  const redisToken = await redis.get<Record<string, unknown>>(KEY);
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, SETTING)).limit(1);
  const pgToken = row?.value ?? null;

  const mismatches: string[] = [];
  if (!redisToken && !pgToken) {
    // both empty — nothing to migrate
  } else if (!redisToken) {
    mismatches.push('token: in Postgres only');
  } else if (!pgToken) {
    mismatches.push('token: in Redis only');
  } else if (canonical(redisToken) !== canonical(pgToken)) {
    mismatches.push('token: value differs');
  }

  console.log(
    JSON.stringify(
      { redisHasToken: !!redisToken, postgresHasToken: !!pgToken, mismatches },
      null,
      2,
    ),
  );
  if (mismatches.length) { console.error(`❌ ${mismatches.length} mismatch(es)`); process.exit(1); }
  console.log('✅ parity OK');
}

main().catch((err) => { console.error('❌ verify failed:', err); process.exit(1); });

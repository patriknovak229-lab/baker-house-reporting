/** Backfill `baker:reservation-overrides` (Redis map) → Postgres. Idempotent. */
import '../_loadEnv';

import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { reservationOverrides } from '../../lib/db/schema';

const KEY = 'baker:reservation-overrides';

async function main() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
  const raw = await redis.get<Record<string, unknown>>(KEY);
  const map = raw && typeof raw === 'object' ? raw : {};
  const entries = Object.entries(map);

  let up = 0, sk = 0;
  for (const [reservationNumber, fields] of entries) {
    if (!reservationNumber || fields == null || typeof fields !== 'object') { sk++; continue; }
    await db
      .insert(reservationOverrides)
      .values({ reservationNumber, data: fields })
      .onConflictDoUpdate({ target: reservationOverrides.reservationNumber, set: { data: fields } });
    up++;
  }
  console.log(JSON.stringify({ redisCount: entries.length, rowsUpserted: up, skipped: sk }, null, 2));
}
main().catch((e) => { console.error('❌ backfill failed:', e); process.exit(1); });

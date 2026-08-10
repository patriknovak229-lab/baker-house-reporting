/**
 * Backfill `baker:occupancy-snapshots` (Redis hash) → Postgres.
 * Idempotent (ON CONFLICT DO UPDATE), safe to re-run. Reads live Upstash,
 * writes Neon. Run with: npx tsx scripts/backfill/occupancy-snapshots.ts
 */
import '../_loadEnv';

import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { occupancySnapshots } from '../../lib/db/schema';
import type { OccupancySnapshot } from '../../types/occupancySnapshot';

const KEY = 'baker:occupancy-snapshots';

function parse(raw: unknown): OccupancySnapshot | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as OccupancySnapshot;
    } catch {
      return null;
    }
  }
  return raw as OccupancySnapshot;
}

async function main() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });

  const raw = (await redis.hgetall<Record<string, unknown>>(KEY)) ?? {};
  const entries = Object.entries(raw);

  let rowsUpserted = 0;
  let skipped = 0;

  for (const [field, val] of entries) {
    const snap = parse(val);
    if (!snap || !snap.token) {
      console.warn(`  skip: unparseable/tokenless field "${field}"`);
      skipped++;
      continue;
    }
    const row = {
      token: snap.token,
      createdAt: new Date(snap.createdAt),
      createdBy: snap.createdBy,
      expiresAt: snap.expiresAt ? new Date(snap.expiresAt) : null,
      data: snap.data,
    };
    const { token: _token, ...set } = row;
    await db
      .insert(occupancySnapshots)
      .values(row)
      .onConflictDoUpdate({ target: occupancySnapshots.token, set });
    rowsUpserted++;
  }

  console.log(
    JSON.stringify({ redisCount: entries.length, rowsUpserted, skipped }, null, 2),
  );
}

main().catch((err) => {
  console.error('❌ backfill failed:', err);
  process.exit(1);
});

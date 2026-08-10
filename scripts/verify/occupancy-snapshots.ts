/**
 * Parity check for occupancy snapshots: Redis hash vs Postgres table.
 * Compares token sets, timestamps (by epoch), createdBy, and data (deep).
 * Exits non-zero on any mismatch. Run: npx tsx scripts/verify/occupancy-snapshots.ts
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

const epoch = (v: string | null): number | null =>
  v ? new Date(v).getTime() : null;

/** Order-insensitive deep equality via canonical JSON (sorted keys). */
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

  const rawRedis = (await redis.hgetall<Record<string, unknown>>(KEY)) ?? {};
  const redisMap = new Map<string, OccupancySnapshot>();
  for (const val of Object.values(rawRedis)) {
    const s = parse(val);
    if (s?.token) redisMap.set(s.token, s);
  }

  const pgRows = await db.select().from(occupancySnapshots);
  const pgMap = new Map<string, OccupancySnapshot>();
  for (const r of pgRows) {
    pgMap.set(r.token, {
      token: r.token,
      createdAt: r.createdAt.toISOString(),
      createdBy: r.createdBy,
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      data: r.data,
    });
  }

  const mismatches: string[] = [];
  const allTokens = new Set([...redisMap.keys(), ...pgMap.keys()]);

  for (const token of allTokens) {
    const a = redisMap.get(token);
    const b = pgMap.get(token);
    if (!a) { mismatches.push(`${token}: in Postgres only`); continue; }
    if (!b) { mismatches.push(`${token}: in Redis only`); continue; }
    if (epoch(a.createdAt) !== epoch(b.createdAt)) mismatches.push(`${token}: createdAt differs`);
    if (epoch(a.expiresAt) !== epoch(b.expiresAt)) mismatches.push(`${token}: expiresAt differs`);
    if (a.createdBy !== b.createdBy) mismatches.push(`${token}: createdBy differs`);
    if (canonical(a.data) !== canonical(b.data)) mismatches.push(`${token}: data differs`);
  }

  console.log(
    JSON.stringify(
      { redisCount: redisMap.size, postgresCount: pgMap.size, mismatches },
      null,
      2,
    ),
  );

  if (mismatches.length > 0) {
    console.error(`❌ ${mismatches.length} mismatch(es)`);
    process.exit(1);
  }
  console.log('✅ parity OK');
}

main().catch((err) => {
  console.error('❌ verify failed:', err);
  process.exit(1);
});

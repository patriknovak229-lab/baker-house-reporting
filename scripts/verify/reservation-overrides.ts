/** Parity: baker:reservation-overrides (Redis map) vs reservation_overrides. */
import '../_loadEnv';
import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { reservationOverrides } from '../../lib/db/schema';

const KEY = 'baker:reservation-overrides';

function canonical(x: unknown): string {
  return JSON.stringify(x, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

async function main() {
  const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });
  const raw = (await redis.get<Record<string, unknown>>(KEY)) ?? {};
  const a = new Map(Object.entries(raw));
  const b = new Map((await db.select().from(reservationOverrides)).map((r) => [r.reservationNumber, r.data] as const));

  const m: string[] = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(key); const y = b.get(key);
    if (x === undefined) { m.push(`${key}: PG only`); continue; }
    if (y === undefined) { m.push(`${key}: Redis only`); continue; }
    if (canonical(x) !== canonical(y)) m.push(`${key}: data differs`);
  }
  console.log(JSON.stringify({ redisCount: a.size, postgresCount: b.size, mismatches: m.slice(0, 40), mismatchTotal: m.length }, null, 2));
  if (m.length) { console.error(`❌ ${m.length} mismatch(es)`); process.exit(1); }
  console.log('✅ parity OK');
}
main().catch((e) => { console.error('❌ verify failed:', e); process.exit(1); });

/**
 * Parity check for vouchers: Redis JSON array vs Postgres table.
 * Compares id sets and every field (value numerically, timestamps by epoch,
 * expires_at by calendar day, absent/empty normalized to null).
 * Exits non-zero on any mismatch. Run: npx tsx scripts/verify/vouchers.ts
 */
import '../_loadEnv';

import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { vouchers } from '../../lib/db/schema';
import type { Voucher } from '../../types/voucher';

const KEY = 'baker:vouchers';

const norm = (x: string | null | undefined): string | null =>
  x == null || x === '' ? null : x;
const epoch = (v: string | Date | null | undefined): number | null =>
  v ? new Date(v).getTime() : null;
const day = (v: string | null | undefined): string | null =>
  v ? v.slice(0, 10) : null;

async function main() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });

  const arr = (await redis.get<Voucher[]>(KEY)) ?? [];
  const redisMap = new Map<string, Voucher>();
  for (const v of arr) if (v?.id) redisMap.set(v.id, v);

  const rows = await db.select().from(vouchers);
  const pgMap = new Map(rows.map((r) => [r.id, r] as const));

  const mismatches: string[] = [];
  const ids = new Set([...redisMap.keys(), ...pgMap.keys()]);

  for (const id of ids) {
    const a = redisMap.get(id);
    const b = pgMap.get(id);
    if (!a) { mismatches.push(`${id}: in Postgres only`); continue; }
    if (!b) { mismatches.push(`${id}: in Redis only`); continue; }
    if (a.code !== b.code) mismatches.push(`${id}: code`);
    if (a.discountType !== b.discountType) mismatches.push(`${id}: discountType`);
    if (Number(a.value) !== Number(b.value)) mismatches.push(`${id}: value`);
    if (a.status !== b.status) mismatches.push(`${id}: status`);
    if (norm(a.reservationNumber) !== norm(b.reservationNumber)) mismatches.push(`${id}: reservationNumber`);
    if (norm(a.redeemedOnReservationNumber) !== norm(b.redeemedOnReservationNumber)) mismatches.push(`${id}: redeemedOnReservationNumber`);
    if (norm(a.guestName) !== norm(b.guestName)) mismatches.push(`${id}: guestName`);
    if (norm(a.guestEmail) !== norm(b.guestEmail)) mismatches.push(`${id}: guestEmail`);
    if (norm(a.guestPhone) !== norm(b.guestPhone)) mismatches.push(`${id}: guestPhone`);
    if (day(a.expiresAt) !== day(b.expiresAt)) mismatches.push(`${id}: expiresAt`);
    if (epoch(a.createdAt) !== epoch(b.createdAt)) mismatches.push(`${id}: createdAt`);
    if (a.createdBy !== b.createdBy) mismatches.push(`${id}: createdBy`);
    if (epoch(a.usedAt) !== epoch(b.usedAt)) mismatches.push(`${id}: usedAt`);
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

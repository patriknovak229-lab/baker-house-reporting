/**
 * Backfill `baker:vouchers` (Redis JSON array) → Postgres.
 * Idempotent (ON CONFLICT DO UPDATE), safe to re-run. Reads live Upstash,
 * writes Neon. Run with: npx tsx scripts/backfill/vouchers.ts
 */
import '../_loadEnv';

import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { vouchers } from '../../lib/db/schema';
import type { VoucherInsert } from '../../lib/db/schema/vouchers';
import type { Voucher } from '../../types/voucher';

const KEY = 'baker:vouchers';

async function main() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });

  const arr = (await redis.get<Voucher[]>(KEY)) ?? [];

  let rowsUpserted = 0;
  let skipped = 0;

  for (const v of arr) {
    if (!v?.id) {
      console.warn('  skip: voucher without id');
      skipped++;
      continue;
    }
    const row: VoucherInsert = {
      id: v.id,
      code: v.code,
      discountType: v.discountType,
      value: String(v.value),
      status: v.status,
      reservationNumber: v.reservationNumber ?? null,
      redeemedOnReservationNumber: v.redeemedOnReservationNumber ?? null,
      guestName: v.guestName ?? null,
      guestEmail: v.guestEmail ?? null,
      guestPhone: v.guestPhone ?? null,
      expiresAt: v.expiresAt.slice(0, 10),
      createdAt: new Date(v.createdAt),
      createdBy: v.createdBy,
      usedAt: v.usedAt ? new Date(v.usedAt) : null,
    };
    const { id: _id, ...set } = row;
    await db
      .insert(vouchers)
      .values(row)
      .onConflictDoUpdate({ target: vouchers.id, set });
    rowsUpserted++;
  }

  console.log(
    JSON.stringify({ redisCount: arr.length, rowsUpserted, skipped }, null, 2),
  );
}

main().catch((err) => {
  console.error('❌ backfill failed:', err);
  process.exit(1);
});

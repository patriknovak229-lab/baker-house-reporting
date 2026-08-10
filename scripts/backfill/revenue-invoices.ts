/** Backfill `baker:revenue-invoices` → Postgres. Idempotent. */
import '../_loadEnv';

import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { revenueInvoices } from '../../lib/db/schema';
import type { RevenueInvoiceInsert } from '../../lib/db/schema/revenueInvoices';
import type { RevenueInvoice } from '../../types/revenueInvoice';

const KEY = 'baker:revenue-invoices';
const d = (s?: string | null) => (s ? s.slice(0, 10) : null);

async function main() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
  const arr = (await redis.get<RevenueInvoice[]>(KEY)) ?? [];
  let up = 0, sk = 0;
  for (const r of arr) {
    if (!r?.id) { sk++; continue; }
    const row: RevenueInvoiceInsert = {
      id: r.id,
      sourceType: r.sourceType,
      category: r.category,
      status: r.status,
      invoiceNumber: r.invoiceNumber,
      invoiceDate: r.invoiceDate.slice(0, 10),
      dueDate: d(r.dueDate),
      amountCzk: String(r.amountCZK),
      reservationNumber: r.reservationNumber ?? null,
      guestName: r.guestName ?? null,
      clientName: r.clientName ?? null,
      description: r.description ?? null,
      bankTransactionId: r.bankTransactionId ?? null,
      reconciledAt: r.reconciledAt ? new Date(r.reconciledAt) : null,
      settlementGroupId: r.settlementGroupId ?? null,
      driveFileId: r.driveFileId ?? null,
      driveFileName: r.driveFileName ?? null,
      driveUrl: r.driveUrl ?? null,
      createdAt: new Date(r.createdAt),
    };
    const { id: _id, ...set } = row;
    await db.insert(revenueInvoices).values(row).onConflictDoUpdate({ target: revenueInvoices.id, set });
    up++;
  }
  console.log(JSON.stringify({ redisCount: arr.length, rowsUpserted: up, skipped: sk }, null, 2));
}
main().catch((e) => { console.error('❌ backfill failed:', e); process.exit(1); });

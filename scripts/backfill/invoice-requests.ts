/**
 * Backfill `baker:invoice-requests` (Redis JSON array) → Postgres.
 * Idempotent. Run: npx tsx scripts/backfill/invoice-requests.ts
 */
import '../_loadEnv';

import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { invoiceRequests } from '../../lib/db/schema';
import type { InvoiceRequestInsert } from '../../lib/db/schema/invoiceRequests';
import type { InvoiceRequest } from '../../types/invoiceRequest';

const KEY = 'baker:invoice-requests';

async function main() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });

  const arr = (await redis.get<InvoiceRequest[]>(KEY)) ?? [];
  let rowsUpserted = 0;
  let skipped = 0;

  for (const r of arr) {
    if (!r?.id) { skipped++; continue; }
    const row: InvoiceRequestInsert = {
      id: r.id,
      reservationNumber: r.reservationNumber,
      beds24MessageId: r.beds24MessageId,
      rawMessage: r.rawMessage,
      companyName: r.companyName ?? null,
      companyAddress: r.companyAddress ?? null,
      ico: r.ico ?? null,
      dic: r.dic ?? null,
      email: r.email ?? null,
      detectedAt: new Date(r.detectedAt),
      status: r.status,
      processedAt: r.processedAt ? new Date(r.processedAt) : null,
      lastAskedAt: r.lastAskedAt ? new Date(r.lastAskedAt) : null,
      asksCount: r.asksCount ?? null,
      lastExtractedFromAt: r.lastExtractedFromAt ? new Date(r.lastExtractedFromAt) : null,
    };
    const { id: _id, ...set } = row;
    await db.insert(invoiceRequests).values(row).onConflictDoUpdate({ target: invoiceRequests.id, set });
    rowsUpserted++;
  }

  console.log(JSON.stringify({ redisCount: arr.length, rowsUpserted, skipped }, null, 2));
}

main().catch((err) => { console.error('❌ backfill failed:', err); process.exit(1); });

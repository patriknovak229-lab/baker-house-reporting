/** Parity: baker:invoice-requests (Redis) vs invoice_requests (Postgres). */
import '../_loadEnv';

import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { invoiceRequests } from '../../lib/db/schema';
import type { InvoiceRequest } from '../../types/invoiceRequest';

const KEY = 'baker:invoice-requests';
const norm = (x: string | null | undefined) => (x == null || x === '' ? null : x);
const epoch = (v: string | Date | null | undefined) => (v ? new Date(v).getTime() : null);
const numOrNull = (x: number | null | undefined) => (x == null ? null : x);

async function main() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });

  const arr = (await redis.get<InvoiceRequest[]>(KEY)) ?? [];
  const redisMap = new Map<string, InvoiceRequest>();
  for (const r of arr) if (r?.id) redisMap.set(r.id, r);

  const rows = await db.select().from(invoiceRequests);
  const pgMap = new Map(rows.map((r) => [r.id, r] as const));

  const mismatches: string[] = [];
  for (const id of new Set([...redisMap.keys(), ...pgMap.keys()])) {
    const a = redisMap.get(id);
    const b = pgMap.get(id);
    if (!a) { mismatches.push(`${id}: in Postgres only`); continue; }
    if (!b) { mismatches.push(`${id}: in Redis only`); continue; }
    if (a.reservationNumber !== b.reservationNumber) mismatches.push(`${id}: reservationNumber`);
    if (a.beds24MessageId !== b.beds24MessageId) mismatches.push(`${id}: beds24MessageId`);
    if (a.rawMessage !== b.rawMessage) mismatches.push(`${id}: rawMessage`);
    if (norm(a.companyName) !== norm(b.companyName)) mismatches.push(`${id}: companyName`);
    if (norm(a.companyAddress) !== norm(b.companyAddress)) mismatches.push(`${id}: companyAddress`);
    if (norm(a.ico) !== norm(b.ico)) mismatches.push(`${id}: ico`);
    if (norm(a.dic) !== norm(b.dic)) mismatches.push(`${id}: dic`);
    if (norm(a.email) !== norm(b.email)) mismatches.push(`${id}: email`);
    if (epoch(a.detectedAt) !== epoch(b.detectedAt)) mismatches.push(`${id}: detectedAt`);
    if (a.status !== b.status) mismatches.push(`${id}: status`);
    if (epoch(a.processedAt) !== epoch(b.processedAt)) mismatches.push(`${id}: processedAt`);
    if (epoch(a.lastAskedAt) !== epoch(b.lastAskedAt)) mismatches.push(`${id}: lastAskedAt`);
    if (numOrNull(a.asksCount) !== numOrNull(b.asksCount)) mismatches.push(`${id}: asksCount`);
    if (epoch(a.lastExtractedFromAt) !== epoch(b.lastExtractedFromAt)) mismatches.push(`${id}: lastExtractedFromAt`);
  }

  console.log(JSON.stringify({ redisCount: redisMap.size, postgresCount: pgMap.size, mismatches }, null, 2));
  if (mismatches.length) { console.error(`❌ ${mismatches.length} mismatch(es)`); process.exit(1); }
  console.log('✅ parity OK');
}

main().catch((err) => { console.error('❌ verify failed:', err); process.exit(1); });

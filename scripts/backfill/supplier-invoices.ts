/** Backfill `baker:supplier-invoices` → Postgres. Idempotent. */
import '../_loadEnv';

import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { supplierInvoices } from '../../lib/db/schema';
import type { SupplierInvoiceInsert } from '../../lib/db/schema/supplierInvoices';
import type { SupplierInvoice } from '../../types/supplierInvoice';

const KEY = 'baker:supplier-invoices';
const d = (s?: string | null) => (s ? s.slice(0, 10) : null);
const n = (x?: number | null) => (x != null ? String(x) : null);

async function main() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
  const arr = (await redis.get<SupplierInvoice[]>(KEY)) ?? [];
  let up = 0, sk = 0;
  for (const s of arr) {
    if (!s?.id) { sk++; continue; }
    const row: SupplierInvoiceInsert = {
      id: s.id,
      supplierName: s.supplierName,
      supplierIco: s.supplierICO ?? null,
      invoiceNumber: s.invoiceNumber,
      invoiceDate: s.invoiceDate.slice(0, 10),
      duzpDate: d(s.duzpDate),
      dueDate: d(s.dueDate),
      amountCzk: String(s.amountCZK),
      vatAmountCzk: n(s.vatAmountCZK),
      invoiceCurrency: s.invoiceCurrency ?? null,
      category: s.category,
      rooms: s.rooms ?? null,
      description: s.description ?? null,
      status: s.status,
      sourceType: s.sourceType,
      driveFileId: s.driveFileId ?? null,
      driveFileName: s.driveFileName ?? null,
      driveUrl: s.driveUrl ?? null,
      gmailMessageId: s.gmailMessageId ?? null,
      icloudFileName: s.icloudFileName ?? null,
      autoProcessed: s.autoProcessed ?? null,
      createdAt: new Date(s.createdAt),
      bankTransactionId: s.bankTransactionId ?? null,
      reconciledAt: s.reconciledAt ? new Date(s.reconciledAt) : null,
      settlementTransactionIds: s.settlementTransactionIds ?? null,
      settlementGroupId: s.settlementGroupId ?? null,
    };
    const { id: _id, ...set } = row;
    await db.insert(supplierInvoices).values(row).onConflictDoUpdate({ target: supplierInvoices.id, set });
    up++;
  }
  console.log(JSON.stringify({ redisCount: arr.length, rowsUpserted: up, skipped: sk }, null, 2));
}
main().catch((e) => { console.error('❌ backfill failed:', e); process.exit(1); });

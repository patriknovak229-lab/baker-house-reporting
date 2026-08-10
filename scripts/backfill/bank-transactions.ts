/** Backfill `baker:bank-transactions` → Postgres. Idempotent. */
import '../_loadEnv';

import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { bankTransactions } from '../../lib/db/schema';
import type { BankTransactionInsert } from '../../lib/db/schema/bankTransactions';
import type { BankTransaction } from '../../types/bankTransaction';

const KEY = 'baker:bank-transactions';
const d = (s?: string | null) => (s ? s.slice(0, 10) : null);
const n = (x?: number | null) => (x != null ? String(x) : null);

async function main() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
  const arr = (await redis.get<BankTransaction[]>(KEY)) ?? [];
  let up = 0, sk = 0;
  for (const t of arr) {
    if (!t?.id) { sk++; continue; }
    const row: BankTransactionInsert = {
      id: t.id,
      date: t.date.slice(0, 10),
      valueDate: d(t.valueDate),
      amount: String(t.amount),
      direction: t.direction,
      currency: t.currency,
      counterpartyAccount: t.counterpartyAccount ?? null,
      counterpartyName: t.counterpartyName ?? null,
      variableSymbol: t.variableSymbol ?? null,
      constantSymbol: t.constantSymbol ?? null,
      specificSymbol: t.specificSymbol ?? null,
      description: t.description ?? null,
      myDescription: t.myDescription ?? null,
      transactionType: t.transactionType ?? null,
      originalAmount: n(t.originalAmount),
      originalCurrency: t.originalCurrency ?? null,
      state: t.state,
      invoiceId: t.invoiceId ?? null,
      invoiceIds: t.invoiceIds ?? null,
      linkedTransactionId: t.linkedTransactionId ?? null,
      grossAmount: n(t.grossAmount),
      deductedInvoiceIds: t.deductedInvoiceIds ?? null,
      revenueInvoiceId: t.revenueInvoiceId ?? null,
      commissionSettlementId: t.commissionSettlementId ?? null,
      settlementGroupId: t.settlementGroupId ?? null,
      ignoreCategory: t.ignoreCategory ?? null,
      ignoreNote: t.ignoreNote ?? null,
      costCategory: t.costCategory ?? null,
      costNote: t.costNote ?? null,
      suggestionDismissed: t.suggestionDismissed ?? null,
      reconciledAt: t.reconciledAt ? new Date(t.reconciledAt) : null,
      ignoredAt: t.ignoredAt ? new Date(t.ignoredAt) : null,
      importedAt: new Date(t.importedAt),
    };
    const { id: _id, ...set } = row;
    await db.insert(bankTransactions).values(row).onConflictDoUpdate({ target: bankTransactions.id, set });
    up++;
  }
  console.log(JSON.stringify({ redisCount: arr.length, rowsUpserted: up, skipped: sk }, null, 2));
}
main().catch((e) => { console.error('❌ backfill failed:', e); process.exit(1); });

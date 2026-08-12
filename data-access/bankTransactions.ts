/**
 * Postgres repository for bank-statement transactions (Redis→Postgres cutover).
 * HARD-RULE domain: reconciliation reads/writes this list; the storage swap must
 * return byte-identical data. toRow mirrors scripts/backfill/bank-transactions.ts
 * exactly. The `id` is a deterministic hash of date+amount+direction+account+VS,
 * so those raw source fields are preserved verbatim (date as YYYY-MM-DD, amount
 * as exact unbounded numeric) — the hash stays reproducible.
 *
 * Money → unbounded numeric String()↔Number(); invoice_ids / deducted_invoice_ids
 * as text[]; timestamps ISO↔Date; absent → undefined. listPg + replaceAll mirror
 * the routes' whole-array redis.get / redis.set. Not capped.
 */
import { asc, desc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { bankTransactions } from '@/lib/db/schema';
import type { BankTransaction } from '@/types/bankTransaction';
import type { BankTransactionInsert, BankTransactionRow } from '@/lib/db/schema/bankTransactions';

const u = <T>(x: T | null): T | undefined => (x == null ? undefined : x);
const n = (x?: number | null) => (x != null ? String(x) : null);
const num = (x: string | null): number | undefined => (x != null ? Number(x) : undefined);
const d = (s?: string | null) => (s ? s.slice(0, 10) : null);

function toRow(t: BankTransaction): BankTransactionInsert {
  return {
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
}

function fromRow(r: BankTransactionRow): BankTransaction {
  return {
    id: r.id,
    date: r.date,
    valueDate: u(r.valueDate),
    amount: Number(r.amount),
    direction: r.direction,
    currency: r.currency,
    counterpartyAccount: u(r.counterpartyAccount),
    counterpartyName: u(r.counterpartyName),
    variableSymbol: u(r.variableSymbol),
    constantSymbol: u(r.constantSymbol),
    specificSymbol: u(r.specificSymbol),
    description: u(r.description),
    myDescription: u(r.myDescription),
    transactionType: u(r.transactionType),
    originalAmount: num(r.originalAmount),
    originalCurrency: u(r.originalCurrency),
    state: r.state,
    invoiceId: u(r.invoiceId),
    invoiceIds: u(r.invoiceIds),
    linkedTransactionId: u(r.linkedTransactionId),
    grossAmount: num(r.grossAmount),
    deductedInvoiceIds: u(r.deductedInvoiceIds),
    revenueInvoiceId: u(r.revenueInvoiceId),
    commissionSettlementId: u(r.commissionSettlementId),
    settlementGroupId: u(r.settlementGroupId),
    ignoreCategory: u(r.ignoreCategory),
    ignoreNote: u(r.ignoreNote),
    costCategory: u(r.costCategory),
    costNote: u(r.costNote),
    suggestionDismissed: u(r.suggestionDismissed),
    reconciledAt: r.reconciledAt ? r.reconciledAt.toISOString() : undefined,
    ignoredAt: r.ignoredAt ? r.ignoredAt.toISOString() : undefined,
    importedAt: r.importedAt.toISOString(),
  };
}

export async function listBankTransactionsPg(): Promise<BankTransaction[]> {
  return (
    await db
      .select()
      .from(bankTransactions)
      .orderBy(desc(bankTransactions.date), asc(bankTransactions.id))
  ).map(fromRow);
}

/** Collapse same-hash duplicate rows the way the app's dedupeById (import route)
 *  does: keep the row whose state is meaningful (not unmatched/revenue),
 *  first-wins on a tie. Guarantees a stray legacy same-hash duplicate can never
 *  drop a reconciled link when the whole array is rewritten. (Clean data has no
 *  duplicate ids, so this is a defensive no-op there.) */
const txRank = (s: BankTransaction['state']) => (s === 'unmatched' || s === 'revenue' ? 0 : 1);

export async function replaceAllBankTransactionsPg(items: BankTransaction[]): Promise<void> {
  const byId = new Map<string, BankTransaction>();
  for (const it of items) {
    const cur = byId.get(it.id);
    if (!cur || txRank(it.state) > txRank(cur.state)) byId.set(it.id, it);
  }
  const rows = [...byId.values()].map(toRow);
  if (rows.length === 0) {
    await db.delete(bankTransactions);
    return;
  }
  await db.batch([db.delete(bankTransactions), db.insert(bankTransactions).values(rows)]);
}

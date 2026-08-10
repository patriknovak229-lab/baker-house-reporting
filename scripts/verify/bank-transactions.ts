/** Parity: baker:bank-transactions vs bank_transactions. */
import '../_loadEnv';
import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { bankTransactions } from '../../lib/db/schema';
import type { BankTransaction } from '../../types/bankTransaction';

const KEY = 'baker:bank-transactions';
const norm = (x: string | null | undefined) => (x == null || x === '' ? null : x);
const epoch = (v: string | Date | null | undefined) => (v ? new Date(v).getTime() : null);
const day = (v: string | null | undefined) => (v ? v.slice(0, 10) : null);
const num = (x: number | string | null | undefined) => (x == null ? null : Number(x));
const boolN = (x: boolean | null | undefined) => x ?? null;
const arr = (x: string[] | null | undefined) => JSON.stringify(x ?? []);

async function main() {
  const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });
  const a = new Map((((await redis.get<BankTransaction[]>(KEY)) ?? []).filter((x) => x?.id)).map((x) => [x.id, x] as const));
  const b = new Map((await db.select().from(bankTransactions)).map((r) => [r.id, r] as const));
  const m: string[] = [];
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(id); const y = b.get(id);
    if (!x) { m.push(`${id}: PG only`); continue; }
    if (!y) { m.push(`${id}: Redis only`); continue; }
    if (day(x.date) !== day(y.date)) m.push(`${id}: date`);
    if (day(x.valueDate) !== day(y.valueDate)) m.push(`${id}: valueDate`);
    if (num(x.amount) !== num(y.amount)) m.push(`${id}: amount`);
    if (x.direction !== y.direction) m.push(`${id}: direction`);
    if (x.currency !== y.currency) m.push(`${id}: currency`);
    if (norm(x.counterpartyAccount) !== norm(y.counterpartyAccount)) m.push(`${id}: counterpartyAccount`);
    if (norm(x.counterpartyName) !== norm(y.counterpartyName)) m.push(`${id}: counterpartyName`);
    if (norm(x.variableSymbol) !== norm(y.variableSymbol)) m.push(`${id}: variableSymbol`);
    if (norm(x.constantSymbol) !== norm(y.constantSymbol)) m.push(`${id}: constantSymbol`);
    if (norm(x.specificSymbol) !== norm(y.specificSymbol)) m.push(`${id}: specificSymbol`);
    if (norm(x.description) !== norm(y.description)) m.push(`${id}: description`);
    if (norm(x.myDescription) !== norm(y.myDescription)) m.push(`${id}: myDescription`);
    if (norm(x.transactionType) !== norm(y.transactionType)) m.push(`${id}: transactionType`);
    if (num(x.originalAmount) !== num(y.originalAmount)) m.push(`${id}: originalAmount`);
    if (norm(x.originalCurrency) !== norm(y.originalCurrency)) m.push(`${id}: originalCurrency`);
    if (x.state !== y.state) m.push(`${id}: state`);
    if (norm(x.invoiceId) !== norm(y.invoiceId)) m.push(`${id}: invoiceId`);
    if (arr(x.invoiceIds) !== arr(y.invoiceIds)) m.push(`${id}: invoiceIds`);
    if (norm(x.linkedTransactionId) !== norm(y.linkedTransactionId)) m.push(`${id}: linkedTransactionId`);
    if (num(x.grossAmount) !== num(y.grossAmount)) m.push(`${id}: grossAmount`);
    if (arr(x.deductedInvoiceIds) !== arr(y.deductedInvoiceIds)) m.push(`${id}: deductedInvoiceIds`);
    if (norm(x.revenueInvoiceId) !== norm(y.revenueInvoiceId)) m.push(`${id}: revenueInvoiceId`);
    if (norm(x.commissionSettlementId) !== norm(y.commissionSettlementId)) m.push(`${id}: commissionSettlementId`);
    if (norm(x.settlementGroupId) !== norm(y.settlementGroupId)) m.push(`${id}: settlementGroupId`);
    if (norm(x.ignoreCategory) !== norm(y.ignoreCategory)) m.push(`${id}: ignoreCategory`);
    if (norm(x.ignoreNote) !== norm(y.ignoreNote)) m.push(`${id}: ignoreNote`);
    if (norm(x.costCategory) !== norm(y.costCategory)) m.push(`${id}: costCategory`);
    if (norm(x.costNote) !== norm(y.costNote)) m.push(`${id}: costNote`);
    if (boolN(x.suggestionDismissed) !== boolN(y.suggestionDismissed)) m.push(`${id}: suggestionDismissed`);
    if (epoch(x.reconciledAt) !== epoch(y.reconciledAt)) m.push(`${id}: reconciledAt`);
    if (epoch(x.ignoredAt) !== epoch(y.ignoredAt)) m.push(`${id}: ignoredAt`);
    if (epoch(x.importedAt) !== epoch(y.importedAt)) m.push(`${id}: importedAt`);
  }
  console.log(JSON.stringify({ redisCount: a.size, postgresCount: b.size, mismatches: m.slice(0, 40), mismatchTotal: m.length }, null, 2));
  if (m.length) { console.error(`❌ ${m.length} mismatch(es)`); process.exit(1); }
  console.log('✅ parity OK');
}
main().catch((e) => { console.error('❌ verify failed:', e); process.exit(1); });

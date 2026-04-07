import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { BankTransaction } from '@/types/bankTransaction';
import type { SupplierInvoice } from '@/types/supplierInvoice';

const TX_KEY  = 'baker:bank-transactions';
const INV_KEY = 'baker:supplier-invoices';

function getRedis(): Redis | null {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function normStr(s: string) { return s.toLowerCase().trim(); }

function isConfidentMatch(tx: BankTransaction, inv: SupplierInvoice): boolean {
  if (Math.abs(tx.amount - inv.amountCZK) >= 1) return false;
  const nameMatch = tx.counterpartyName && normStr(tx.counterpartyName).includes(normStr(inv.supplierName));
  const vsMatch   = tx.variableSymbol   && normStr(tx.variableSymbol) === normStr(inv.invoiceNumber);
  return !!(nameMatch || vsMatch);
}

export async function POST(request: Request) {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  const [rawTx, rawInv] = await Promise.all([redis.get(TX_KEY), redis.get(INV_KEY)]);
  const transactions = (Array.isArray(rawTx)  ? rawTx  : []) as BankTransaction[];
  const invoices     = (Array.isArray(rawInv) ? rawInv : []) as SupplierInvoice[];

  const unmatchedDebits  = transactions.filter((t) => t.direction === 'debit' && t.state === 'unmatched');
  const pendingInvoices  = invoices.filter((inv) => inv.status === 'pending' && !inv.bankTransactionId);

  if (unmatchedDebits.length === 0 || pendingInvoices.length === 0) {
    return NextResponse.json({ matched: 0, transactions });
  }

  const now = new Date().toISOString();
  let matched = 0;
  const availableInvoices = [...pendingInvoices];

  for (const tx of unmatchedDebits) {
    const hits = availableInvoices.filter((inv) => isConfidentMatch(tx, inv));
    if (hits.length !== 1) continue;

    const inv = hits[0];
    const txIdx  = transactions.findIndex((t) => t.id === tx.id);
    const invIdx = invoices.findIndex((i) => i.id === inv.id);
    if (txIdx === -1 || invIdx === -1) continue;

    transactions[txIdx] = { ...transactions[txIdx], state: 'reconciled', invoiceId: inv.id, reconciledAt: now };
    invoices[invIdx]    = { ...invoices[invIdx], status: 'reconciled', bankTransactionId: tx.id, reconciledAt: now };

    // Remove from pool so the same invoice can't match twice
    availableInvoices.splice(availableInvoices.findIndex((i) => i.id === inv.id), 1);
    matched++;
  }

  if (matched > 0) {
    await Promise.all([redis.set(TX_KEY, transactions), redis.set(INV_KEY, invoices)]);
  }

  return NextResponse.json({ matched, transactions });
}

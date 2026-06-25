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

/** Word-overlap name score (0–4): 4=exact, 3=mutual substring, 2=one-directional, 1=word overlap */
function calcNameScore(txCounterparty: string, invSupplier: string): number {
  const a = txCounterparty.toLowerCase().trim();
  const b = invSupplier.toLowerCase().trim();
  if (!a || !b) return 0;
  if (a === b) return 4;
  if (a.includes(b) && b.includes(a)) return 3;
  if (a.includes(b) || b.includes(a)) return 2;
  const aw = a.split(/\s+/), bw = b.split(/\s+/);
  const overlap = aw.filter((w) => bw.some((bwi) => bwi.includes(w) || w.includes(bwi))).length;
  return overlap > 0 ? 1 : 0;
}

/** Common legal-form / generic tokens that must NOT count as a name match on their own */
const GENERIC_NAME_TOKENS = new Set([
  's.r.o.', 'sro', 'a.s.', 'as', 'spol.', 'k.s.', 'v.o.s.', 'o.s.', 'z.s.',
  'gmbh', 'inc', 'inc.', 'ltd', 'ltd.', 'llc', 'co', 'co.', 'corp', 'corp.',
  'b.v.', 'bv', 'pbc', 'limited', 'company', 'group',
]);

/** True if the two names share a meaningful word (>= 4 chars, not a generic/legal token). */
function meaningfulNameOverlap(txName: string, invName: string): boolean {
  const sig = (s: string) =>
    s.toLowerCase().split(/[\s,]+/).filter((w) => w.length >= 4 && !GENERIC_NAME_TOKENS.has(w));
  const a = sig(txName);
  const b = sig(invName);
  return a.some((w) => b.some((bw) => bw.includes(w) || w.includes(bw)));
}

function isConfidentMatch(tx: BankTransaction, inv: SupplierInvoice): boolean {
  const isForeign = inv.invoiceCurrency && inv.invoiceCurrency !== 'CZK';
  const compareTo = isForeign ? (tx.originalAmount ?? tx.amount) : tx.amount;
  const diff = Math.abs(compareTo - inv.amountCZK);
  const tolerance = Math.max(2, inv.amountCZK * 0.01);
  if (diff > tolerance) return false;

  const ns = calcNameScore(tx.counterpartyName ?? '', inv.supplierName);
  const vsMatch = !!tx.variableSymbol &&
    tx.variableSymbol.toLowerCase().trim() === inv.invoiceNumber.toLowerCase().trim();

  // Strong signal: exact variable symbol, or one name clearly contains the other.
  if (vsMatch || ns >= 2) return true;

  // Weak name only (e.g. bank trading name "IKEA BRNO OD" vs legal "IKEA Česká
  // republika s.r.o." share just "ikea"). Safe to auto-match when there's a
  // MEANINGFUL shared word, a near-exact amount AND a close date — and the caller
  // enforces this is the ONLY candidate (hits.length === 1), so there's no ambiguity.
  const nearExact = diff <= Math.max(1, inv.amountCZK * 0.005);
  const daysDiff = Math.abs(
    (new Date(tx.date).getTime() - new Date(inv.invoiceDate).getTime()) / 86_400_000,
  );
  if (nearExact && daysDiff <= 45 && meaningfulNameOverlap(tx.counterpartyName ?? '', inv.supplierName)) {
    return true;
  }

  return false;
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

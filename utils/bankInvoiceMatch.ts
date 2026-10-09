/**
 * Bank debit ↔ supplier invoice matching — the ONE implementation behind the
 * Auto-match button (POST /api/bank-transactions/reconcile), the CSV import
 * and the drawer / list suggestion. Pure (no I/O), so it also runs client-side.
 *
 * Calibrated on the 163 manual matches as of 2026-10-09:
 *  - CZK payments match the invoice to the crown (141 of 147 within 1 Kč), so the
 *    old 1 % slack only applies when the payment carries the invoice number.
 *  - 90 % of payments land between 5 days before and 3 days after the invoice
 *    date; prepaid e-shop orders up to ~5 weeks before.
 *  - Banks show trading names ("B080 Modrice" = Action, "IKEA CZ ecom") or no
 *    name at all (transfers), so identity comes from the invoice number on the
 *    payment, from counterparties already matched before ("learned"), or from a
 *    shared name word — never from the amount alone.
 *
 * Auto-match only takes a pair that is clearly the best for BOTH the payment and
 * the invoice; same-supplier twins (two equal invoices, one payment) stay manual.
 * Credit notes are out of scope here (they pair with incoming refunds).
 */
import type { BankTransaction } from '@/types/bankTransaction';
import type { SupplierInvoice } from '@/types/supplierInvoice';

export type MatchEvidence = 'invoice_number' | 'learned' | 'name';

export interface MatchCandidate {
  invoice: SupplierInvoice;
  score: number;
  exactAmount: boolean;
  evidence: MatchEvidence[];
  /** Days from invoice date to payment (negative = paid before the invoice date) */
  lagDays: number;
  /** Passes the auto-match bar on its own (rivals are checked separately) */
  autoEligible: boolean;
}

export interface AutoMatch {
  tx: BankTransaction;
  invoice: SupplierInvoice;
  /** Human-readable why, persisted on the transaction as autoMatchReason */
  reason: string;
}

/** counterparty key → supplier keys it has been reconciled to before */
export type CounterpartyMemory = Map<string, Set<string>>;

// ── Tunables ─────────────────────────────────────────────────────────────────

/** Auto-match window: payment at most this many days BEFORE the invoice date… */
const AUTO_MAX_DAYS_BEFORE = 40;
/** …and at most this many days after max(invoice date, due date). */
const AUTO_MAX_DAYS_AFTER_DUE = 45;
/** Suggestions (user confirms) look further either way. */
const SUGGEST_MAX_DAYS = 90;
/** A pair must out-score every rival on both sides by this much to auto-match. */
const AUTO_MARGIN = 15;

/** Tokens that identify nobody: legal forms, countries, gateways, cities, filler. */
const GENERIC_TOKENS = new Set([
  'sro', 'spol', 'gmbh', 'inc', 'ltd', 'llc', 'corp', 'pbc', 'limited', 'company', 'group',
  'czech', 'republic', 'republika', 'ceska', 'cesko', 'czk', 'eur', 'usd', 'com', 'www', 'eshop', 'shop',
  'retail', 'market', 'trade', 'the', 'and', 'odstepny', 'zavod', 'platba', 'payment',
  'gopay', 'payu', 'comgate', 'paypal', 'stripe', 'tpy', 'sumup', 'brno', 'praha',
]);

// ── Normalisation ────────────────────────────────────────────────────────────

function normText(s: string | undefined | null): string {
  return (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Meaningful words of a name: ≥3 chars, not generic, not a bare number. */
export function nameTokens(s: string | undefined | null): string[] {
  return normText(s)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !GENERIC_TOKENS.has(w) && !/^\d+$/.test(w));
}

function digitsOf(s: string | undefined | null): string {
  return (s ?? '').replace(/\D/g, '').replace(/^0+/, '');
}

function isCardPayment(tx: BankTransaction): boolean {
  return (tx.counterpartyAccount ?? '').includes('*');
}

/** Stable supplier identity: IČO digits when present, else the first name word. */
export function supplierKey(inv: SupplierInvoice): string {
  const ico = digitsOf(inv.supplierICO);
  if (ico.length >= 6) return `ico:${ico}`;
  return `name:${nameTokens(inv.supplierName)[0] ?? normText(inv.supplierName).trim()}`;
}

/** How the bank identifies the payee: the account for transfers, the merchant descriptor for both. */
export function counterpartyKeys(tx: BankTransaction): string[] {
  const keys: string[] = [];
  if (tx.counterpartyAccount && !isCardPayment(tx)) keys.push(`acct:${tx.counterpartyAccount.trim()}`);
  const words = nameTokens(tx.counterpartyName);
  if (words.length > 0) keys.push(`cp:${words.join(' ')}`);
  return keys;
}

function linkedInvoiceIds(tx: BankTransaction): string[] {
  if (tx.invoiceIds && tx.invoiceIds.length > 0) return tx.invoiceIds;
  return tx.invoiceId ? [tx.invoiceId] : [];
}

function isMatchableInvoice(inv: SupplierInvoice): boolean {
  return inv.status === 'pending' && !inv.bankTransactionId
    && (inv.documentType ?? 'invoice') === 'invoice' && inv.amountCZK > 0;
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso.slice(0, 10)) - Date.parse(fromIso.slice(0, 10))) / 86_400_000);
}

// ── Signals ──────────────────────────────────────────────────────────────────

/** Remember which supplier every already-reconciled debit's counterparty turned out to be. */
export function learnCounterparties(transactions: BankTransaction[], invoices: SupplierInvoice[]): CounterpartyMemory {
  const byId = new Map(invoices.map((i) => [i.id, i]));
  const memory: CounterpartyMemory = new Map();
  for (const tx of transactions) {
    if (tx.direction !== 'debit' || tx.state !== 'reconciled') continue;
    const keys = counterpartyKeys(tx);
    if (keys.length === 0) continue;
    for (const invId of linkedInvoiceIds(tx)) {
      const inv = byId.get(invId);
      if (!inv) continue;
      const sk = supplierKey(inv);
      for (const k of keys) {
        if (!memory.has(k)) memory.set(k, new Set());
        memory.get(k)!.add(sk);
      }
    }
  }
  return memory;
}

/** 'exact' (to the crown / cent), 'near' (≤ 1 %), or null. Foreign invoices compare the original-currency amount. */
function amountFit(tx: BankTransaction, inv: SupplierInvoice): 'exact' | 'near' | null {
  const currency = (inv.invoiceCurrency || 'CZK').toUpperCase();
  let diff: number;
  let exactTol: number;
  let nearTol: number;
  if (currency !== 'CZK') {
    if (tx.originalAmount == null) return null;
    if (tx.originalCurrency && tx.originalCurrency.toUpperCase() !== currency) return null;
    diff = Math.abs(tx.originalAmount - inv.amountCZK);
    exactTol = 0.01;
    nearTol = Math.max(0.02, inv.amountCZK * 0.01);
  } else {
    diff = Math.abs(tx.amount - inv.amountCZK);
    exactTol = 1;
    nearTol = Math.max(2, inv.amountCZK * 0.01);
  }
  if (diff <= exactTol + 1e-9) return 'exact';
  if (diff <= nearTol + 1e-9) return 'near';
  return null;
}

/** The invoice number appears as the variable symbol or in the payment message ("FV2612173 RYWA S.R.O."). */
function invoiceNumberOnPayment(tx: BankTransaction, inv: SupplierInvoice): boolean {
  const numDigits = digitsOf(inv.invoiceNumber);
  const vs = digitsOf(tx.variableSymbol);
  if (vs.length >= 4 && vs === numDigits) return true;

  const words = normText(`${tx.description ?? ''} ${tx.myDescription ?? ''}`).split(/[^a-z0-9]+/).filter(Boolean);
  const num = normText(inv.invoiceNumber).replace(/[^a-z0-9]/g, '');
  if (num.length >= 5 && words.includes(num)) return true;
  if (numDigits.length >= 6 && words.some((w) => /^\d+$/.test(w) && w.replace(/^0+/, '') === numDigits)) return true;
  return false;
}

function nameOverlap(tx: BankTransaction, inv: SupplierInvoice): boolean {
  const a = nameTokens(tx.counterpartyName);
  const b = nameTokens(inv.supplierName);
  return a.some((x) => b.some((y) => x === y || (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x)))));
}

function learnedMatch(tx: BankTransaction, inv: SupplierInvoice, memory: CounterpartyMemory): boolean {
  const sk = supplierKey(inv);
  return counterpartyKeys(tx).some((k) => memory.get(k)?.has(sk));
}

// ── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Score one debit against one invoice, or null when amount/date rule it out.
 * mode 'auto' uses the tight auto-match window; 'suggest' the wider one.
 */
export function scoreCandidate(
  tx: BankTransaction,
  inv: SupplierInvoice,
  memory: CounterpartyMemory,
  mode: 'auto' | 'suggest',
): MatchCandidate | null {
  if ((inv.documentType ?? 'invoice') !== 'invoice' || inv.amountCZK <= 0) return null;
  const fit = amountFit(tx, inv);
  if (!fit) return null;

  const lagDays = daysBetween(inv.invoiceDate, tx.date);
  if (mode === 'auto') {
    const lastDay = inv.dueDate && inv.dueDate > inv.invoiceDate ? inv.dueDate : inv.invoiceDate;
    if (lagDays < -AUTO_MAX_DAYS_BEFORE || daysBetween(lastDay, tx.date) > AUTO_MAX_DAYS_AFTER_DUE) return null;
  } else if (Math.abs(lagDays) > SUGGEST_MAX_DAYS) {
    return null;
  }

  const evidence: MatchEvidence[] = [];
  if (invoiceNumberOnPayment(tx, inv)) evidence.push('invoice_number');
  if (learnedMatch(tx, inv, memory)) evidence.push('learned');
  if (nameOverlap(tx, inv)) evidence.push('name');

  const exactAmount = fit === 'exact';
  const hasNumber = evidence.includes('invoice_number');
  const autoEligible = hasNumber || (exactAmount && evidence.length > 0);

  // Evidence dominates; the date term (max 6) only orders candidates and can
  // never bridge AUTO_MARGIN on its own, so same-evidence twins stay manual.
  const score =
    (hasNumber ? 100 : 0) +
    (evidence.includes('learned') ? 40 : 0) +
    (evidence.includes('name') ? 20 : 0) +
    (exactAmount ? 10 : 0) -
    Math.min(Math.abs(lagDays), 60) * 0.1;

  return { invoice: inv, score, exactAmount, evidence, lagDays, autoEligible };
}

export function describeMatch(c: MatchCandidate): string {
  const parts: string[] = [];
  if (c.evidence.includes('invoice_number')) parts.push('invoice no. on payment');
  if (c.evidence.includes('learned')) parts.push('paid this supplier before');
  if (c.evidence.includes('name')) parts.push('name match');
  parts.push(c.exactAmount ? 'exact amount' : 'amount within 1 %');
  parts.push(c.lagDays === 0 ? 'same day' : `${c.lagDays > 0 ? '+' : ''}${c.lagDays} d`);
  return parts.join(' · ');
}

// ── Auto-match ───────────────────────────────────────────────────────────────

/**
 * Pair unmatched debits with pending invoices. Considers every pair at once
 * (order-independent) and accepts a pair only when it beats every remaining
 * rival of BOTH the payment and the invoice by AUTO_MARGIN; repeats until
 * nothing more resolves.
 */
export function findAutoMatches(
  transactions: BankTransaction[],
  invoices: SupplierInvoice[],
  memory: CounterpartyMemory,
): AutoMatch[] {
  const debits = transactions.filter((t) => t.direction === 'debit' && t.state === 'unmatched');
  const pool = invoices.filter(isMatchableInvoice);

  const pairs: Array<{ tx: BankTransaction; c: MatchCandidate }> = [];
  for (const tx of debits) {
    for (const inv of pool) {
      const c = scoreCandidate(tx, inv, memory, 'auto');
      if (c?.autoEligible) pairs.push({ tx, c });
    }
  }
  pairs.sort((a, b) => b.c.score - a.c.score);

  const usedTx = new Set<string>();
  const usedInv = new Set<string>();
  const out: AutoMatch[] = [];

  for (let progress = true; progress; ) {
    progress = false;
    const live = pairs.filter((p) => !usedTx.has(p.tx.id) && !usedInv.has(p.c.invoice.id));
    for (const p of live) {
      if (usedTx.has(p.tx.id) || usedInv.has(p.c.invoice.id)) continue;
      const clearlyBest = live.every((q) =>
        q === p
        || usedTx.has(q.tx.id) || usedInv.has(q.c.invoice.id)
        || (q.tx.id !== p.tx.id && q.c.invoice.id !== p.c.invoice.id)
        || p.c.score - q.c.score >= AUTO_MARGIN,
      );
      if (!clearlyBest) continue;
      out.push({ tx: p.tx, invoice: p.c.invoice, reason: describeMatch(p.c) });
      usedTx.add(p.tx.id);
      usedInv.add(p.c.invoice.id);
      progress = true;
    }
  }
  return out;
}

// ── Suggestion (drawer pre-select + list ✦ hint) ─────────────────────────────

/**
 * Best pending invoice for a debit on a looser bar than auto-match (±90 days;
 * amount within ~1 % when there is an identity signal, else exact) — the user
 * confirms it. Returns the top candidate when it has any identity evidence or
 * is the only candidate, else null. (A 1 %-off amount with no signal at all —
 * laundry 3 107 vs a Penny receipt of 3 095.86 — is noise, not a suggestion.)
 */
export function findSuggestion(
  tx: BankTransaction,
  invoices: SupplierInvoice[],
  memory: CounterpartyMemory = new Map(),
): SupplierInvoice | null {
  const scored = invoices
    .filter(isMatchableInvoice)
    .map((inv) => scoreCandidate(tx, inv, memory, 'suggest'))
    .filter((c): c is MatchCandidate => c !== null && (c.evidence.length > 0 || c.exactAmount))
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  return scored[0].evidence.length > 0 || scored.length === 1 ? scored[0].invoice : null;
}

/**
 * Incoming-payment (credit) matching for the Auto-match button — the two lanes
 * next to the supplier-invoice matcher in utils/bankInvoiceMatch:
 *
 *  1. OTA payouts → settlements. A settlement report's net equals its bank
 *     payout(s) to the haléř (all 12 Jan–Jun 2026 settlements). Booking pays once
 *     per report; Airbnb pays per reservation via Citibank. So: the UNIQUE set of
 *     unlinked payouts from the channel's payer, inside the period window, that
 *     sums exactly to the settlement's remaining net. Backtested on Jan–Jun:
 *     exactly one combination per month, always the one linked by hand.
 *     (Booking's PDF "ID platby" is not the reference the bank shows, so the
 *     amount is the key.)
 *
 *  2. Payments → issued invoices (direct / corporate stays). Clients pay with the
 *     invoice number as variable symbol (INV-92798373-1 → VS 927983731), so the
 *     invoice number on the payment is the identity; same clear-best rule as costs.
 *
 *  3. Refunds → supplier credit notes, one bank line per document (agreed design:
 *     the invoice ↔ its debit, each credit note ↔ its own refund; the group under
 *     the original invoice gives the net). Same supplier + same amount credit
 *     notes are interchangeable (Alza goodwills: 3 × 1 499, 3 × 729), so they pair
 *     in date / number order instead of being blocked as ambiguous twins.
 *
 * Pure (no I/O). Only touches credits still in state 'revenue' and unlinked.
 */
import type { BankTransaction } from '@/types/bankTransaction';
import type { RevenueInvoice } from '@/types/revenueInvoice';
import type { SupplierInvoice } from '@/types/supplierInvoice';
import { isReportSettlement, type SettlementGroup } from '@/types/settlementGroup';
import {
  amountFit, assignClearBest, counterpartyKeys, daysBetween, invoiceNumberOnPayment, nameOverlap, supplierKey,
  type CandidatePair, type CounterpartyMemory,
} from './bankInvoiceMatch';
import { findOriginalInvoice } from './invoiceChecks';

/** A credit nobody has claimed yet */
function isOpenCredit(t: BankTransaction): boolean {
  return t.direction === 'credit' && t.state === 'revenue'
    && !t.settlementGroupId && !t.revenueInvoiceId && !t.suggestionDismissed;
}

const cents = (x: number) => Math.round(x * 100);

// ── 1. OTA payouts → settlements ─────────────────────────────────────────────

/** Who the bank shows as payer, and how far around the report period payouts land */
const CHANNELS: Partial<Record<NonNullable<SettlementGroup['source']>, { payer: RegExp; daysBefore: number; daysAfter: number; label: string }>> = {
  // Booking: one payout per report, 15 days before … 6 days after period end seen
  booking: { payer: /booking/i, daysBefore: 5, daysAfter: 20, label: 'Booking.com' },
  // Airbnb: per-reservation payouts inside the month, last one ~1 day after it
  airbnb: { payer: /citibank|airbnb/i, daysBefore: 5, daysAfter: 10, label: 'Airbnb' },
};

/** Largest candidate pool / combination we search — beyond this it's not "obvious" any more */
const MAX_CANDIDATES = 24;
const MAX_PAYOUTS = 10;

export interface SettlementPayoutMatch {
  group: SettlementGroup;
  payouts: BankTransaction[];
  reason: string;
}

/** All subsets of `items` summing exactly to `target` cents — stops after `limit` solutions. */
function exactSubsets(items: BankTransaction[], target: number, limit: number): BankTransaction[][] {
  const sorted = [...items].sort((a, b) => cents(b.amount) - cents(a.amount));
  const suffix = sorted.map((_, i) => sorted.slice(i).reduce((s, t) => s + cents(t.amount), 0));
  const found: BankTransaction[][] = [];
  const pick: BankTransaction[] = [];
  const walk = (i: number, rest: number) => {
    if (found.length >= limit) return;
    if (rest === 0) { found.push([...pick]); return; }
    if (i >= sorted.length || pick.length >= MAX_PAYOUTS || rest < 0 || suffix[i] < rest) return;
    pick.push(sorted[i]);
    walk(i + 1, rest - cents(sorted[i].amount));
    pick.pop();
    walk(i + 1, rest);
  };
  walk(0, target);
  return found;
}

export function findSettlementPayouts(transactions: BankTransaction[], groups: SettlementGroup[]): SettlementPayoutMatch[] {
  const byId = new Map(transactions.map((t) => [t.id, t]));
  const open = transactions.filter(isOpenCredit);
  const proposals: SettlementPayoutMatch[] = [];

  for (const group of groups) {
    const channel = group.source ? CHANNELS[group.source] : undefined;
    if (!channel || !isReportSettlement(group) || group.netAmount == null || !group.periodStart) continue;
    const periodEnd = group.periodEnd ?? group.periodStart;

    const linked = group.transactionIds.reduce((s, id) => s + cents(byId.get(id)?.amount ?? 0), 0);
    const remaining = cents(group.netAmount) - linked;
    if (remaining <= 0) continue;

    const pool = open.filter((t) =>
      channel.payer.test(t.counterpartyName ?? '')
      && daysBetween(group.periodStart!, t.date) >= -channel.daysBefore
      && daysBetween(periodEnd, t.date) <= channel.daysAfter);
    if (pool.length === 0 || pool.length > MAX_CANDIDATES) continue;

    const solutions = exactSubsets(pool, remaining, 2);
    if (solutions.length !== 1) continue; // none, or ambiguous
    const payouts = solutions[0];
    proposals.push({
      group,
      payouts,
      reason: payouts.length === 1
        ? `${channel.label} payout = settlement net (exact)`
        : `${payouts.length} ${channel.label} payouts sum to settlement net (exact)`,
    });
  }

  // A payout claimed by two settlements is ambiguous — leave both to the user
  const claims = new Map<string, number>();
  for (const p of proposals) for (const t of p.payouts) claims.set(t.id, (claims.get(t.id) ?? 0) + 1);
  return proposals.filter((p) => p.payouts.every((t) => claims.get(t.id) === 1));
}

// ── 2. Payments → issued invoices ────────────────────────────────────────────

const ISSUED_MAX_DAYS_BEFORE = 60;   // deposit paid before the invoice date
const ISSUED_MAX_DAYS_AFTER_DUE = 120;

export interface IssuedInvoiceMatch {
  tx: BankTransaction;
  invoice: RevenueInvoice;
  reason: string;
}

function isOpenIssuedInvoice(inv: RevenueInvoice): boolean {
  return inv.status === 'pending' && !inv.bankTransactionId && !inv.settlementGroupId
    && inv.category !== 'ota_gross' && inv.category !== 'mistake' && inv.amountCZK > 0;
}

export function findIssuedInvoiceMatches(transactions: BankTransaction[], invoices: RevenueInvoice[]): IssuedInvoiceMatch[] {
  const credits = transactions.filter(isOpenCredit);
  const pool = invoices.filter(isOpenIssuedInvoice);

  type Data = { invoice: RevenueInvoice; reason: string };
  const pairs: Array<CandidatePair<Data>> = [];
  for (const tx of credits) {
    for (const inv of pool) {
      const diff = Math.abs(tx.amount - inv.amountCZK);
      const exact = diff <= 1;
      if (!exact && diff > Math.max(2, inv.amountCZK * 0.01)) continue;

      const lag = daysBetween(inv.invoiceDate, tx.date);
      const lastDay = inv.dueDate && inv.dueDate > inv.invoiceDate ? inv.dueDate : inv.invoiceDate;
      if (lag < -ISSUED_MAX_DAYS_BEFORE || daysBetween(lastDay, tx.date) > ISSUED_MAX_DAYS_AFTER_DUE) continue;

      const hasNumber = invoiceNumberOnPayment(tx, inv.invoiceNumber);
      const hasName = nameOverlap(tx, inv.clientName ?? inv.guestName);
      if (!hasNumber && !(hasName && exact)) continue;

      const parts = [
        ...(hasNumber ? ['invoice no. on payment'] : []),
        ...(hasName ? ['name match'] : []),
        exact ? 'exact amount' : 'amount within 1 %',
        lag === 0 ? 'same day' : `${lag > 0 ? '+' : ''}${lag} d`,
      ];
      pairs.push({
        tx,
        targetId: inv.id,
        score: (hasNumber ? 100 : 0) + (hasName ? 20 : 0) + (exact ? 10 : 0) - Math.min(Math.abs(lag), 60) * 0.1,
        data: { invoice: inv, reason: parts.join(' · ') },
      });
    }
  }
  return assignClearBest(pairs).map((p) => ({ tx: p.tx, invoice: p.data.invoice, reason: p.data.reason }));
}

// ── 3. Refunds → supplier credit notes ──────────────────────────────────────

/** Refund booked up to a week before the credit note is issued … or 45 days after */
const REFUND_MAX_DAYS_BEFORE = 7;
const REFUND_MAX_DAYS_AFTER = 45;

export interface CreditNoteRefundMatch {
  tx: BankTransaction;
  creditNote: SupplierInvoice;
  reason: string;
}

function isOpenCreditNote(inv: SupplierInvoice): boolean {
  return inv.documentType === 'credit_note' && inv.status === 'pending' && !inv.bankTransactionId && inv.amountCZK < 0;
}

export function findCreditNoteRefunds(
  transactions: BankTransaction[],
  invoices: SupplierInvoice[],
  memory: CounterpartyMemory,
): CreditNoteRefundMatch[] {
  const credits = transactions.filter(isOpenCredit);
  const notes = invoices.filter(isOpenCreditNote);
  if (credits.length === 0 || notes.length === 0) return [];
  const invById = new Map(invoices.map((i) => [i.id, i]));
  const txById = new Map(transactions.map((t) => [t.id, t]));

  /** Bank keys of the payment that paid the credit note's original invoice ("same card it was bought with") */
  const originalPayerKeys = (note: SupplierInvoice): string[] => {
    const original = (note.relatedInvoiceId && invById.get(note.relatedInvoiceId))
      || findOriginalInvoice(note.supplierName, note.supplierICO, note.originalInvoiceNumber, invoices);
    const paidBy = original && original.bankTransactionId ? txById.get(original.bankTransactionId) : undefined;
    return paidBy ? counterpartyKeys(paidBy) : [];
  };

  type Pair = { tx: BankTransaction; note: SupplierInvoice; evidence: string[]; lag: number };
  const pairs: Pair[] = [];
  for (const note of notes) {
    const refund = { ...note, amountCZK: -note.amountCZK };   // compare as a positive amount
    const noteDate = note.duzpDate ?? note.invoiceDate;
    const payerKeys = originalPayerKeys(note);
    const sk = supplierKey(note);
    for (const tx of credits) {
      if (amountFit(tx, refund) !== 'exact') continue;
      const lag = daysBetween(noteDate, tx.date);
      if (lag < -REFUND_MAX_DAYS_BEFORE || lag > REFUND_MAX_DAYS_AFTER) continue;

      const keys = counterpartyKeys(tx);
      const evidence: string[] = [];
      if (invoiceNumberOnPayment(tx, note.invoiceNumber)
          || (note.originalInvoiceNumber && invoiceNumberOnPayment(tx, note.originalInvoiceNumber))) evidence.push('document no. on payment');
      if (keys.some((k) => payerKeys.includes(k))) evidence.push('same payer as the original purchase');
      else if (keys.some((k) => memory.get(k)?.has(sk))) evidence.push('paid this supplier before');
      if (nameOverlap(tx, note.supplierName)) evidence.push('name match');
      if (evidence.length === 0) continue;
      pairs.push({ tx, note, evidence, lag });
    }
  }

  // Interchangeable documents: same supplier + same amount. A refund that could
  // belong to two different classes is ambiguous — leave it to the user.
  const classOf = (n: SupplierInvoice) => `${supplierKey(n)}|${Math.round(-n.amountCZK * 100)}`;
  const classesOfTx = new Map<string, Set<string>>();
  for (const p of pairs) {
    if (!classesOfTx.has(p.tx.id)) classesOfTx.set(p.tx.id, new Set());
    classesOfTx.get(p.tx.id)!.add(classOf(p.note));
  }
  const usable = pairs.filter((p) => classesOfTx.get(p.tx.id)!.size === 1);

  // Within a class, earliest credit note takes the earliest eligible refund
  const byClass = new Map<string, Pair[]>();
  for (const p of usable) byClass.set(classOf(p.note), [...(byClass.get(classOf(p.note)) ?? []), p]);
  const out: CreditNoteRefundMatch[] = [];
  const usedTx = new Set<string>();
  for (const classPairs of byClass.values()) {
    const classNotes = [...new Map(classPairs.map((p) => [p.note.id, p.note])).values()].sort((a, b) =>
      (a.duzpDate ?? a.invoiceDate).localeCompare(b.duzpDate ?? b.invoiceDate) || a.invoiceNumber.localeCompare(b.invoiceNumber));
    for (const note of classNotes) {
      const pick = classPairs
        .filter((p) => p.note.id === note.id && !usedTx.has(p.tx.id))
        .sort((a, b) => a.tx.date.localeCompare(b.tx.date) || a.tx.id.localeCompare(b.tx.id))[0];
      if (!pick) continue;
      usedTx.add(pick.tx.id);
      out.push({
        tx: pick.tx,
        creditNote: note,
        reason: ['refund of credit note', ...pick.evidence, 'exact amount', pick.lag === 0 ? 'same day' : `${pick.lag > 0 ? '+' : ''}${pick.lag} d`].join(' · '),
      });
    }
  }
  return out;
}

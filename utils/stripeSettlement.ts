/**
 * Stripe payout → settlement, the same model as the Booking / Airbnb settlement
 * reports, except Stripe itself tells us what a payout contains (no upload):
 *
 *   payout = Σ charges (web bookings, payment links) − refunds − Stripe fees
 *
 * Booked as: one "Web bookings (Stripe)" revenue record for the charges that
 * have no revenue record yet, one Stripe-fees cost record, and the bank payout
 * grouped — all dated by the payout (bank) date, the cash basis Patrik chose.
 *
 * Bookings that already have a revenue record are LINKED, not counted again:
 *   • payment links created in the app → their `pay-<sessionId>` record;
 *   • website bookings for which an invoice was issued on request (e.g. BH-89925619,
 *     Hlavacova) → the invoice becomes a document covered by the settlement.
 *
 * A website charge is tied to its reservation by the stay dates the website puts
 * on the Stripe session (arrival / departure) + the Direct-Web booking in Beds24
 * with that stay and price.
 *
 * Pure: the Stripe I/O lives in utils/stripePayouts.ts.
 */
import type { BankTransaction } from '@/types/bankTransaction';
import type { RevenueInvoice } from '@/types/revenueInvoice';
import type { SupplierInvoice } from '@/types/supplierInvoice';
import type { SettlementGroup } from '@/types/settlementGroup';
import { DISTRIBUTION_FEES_CATEGORY } from './settlementRecords';

/** One balance transaction of a payout, already resolved to its checkout session */
export interface PayoutLine {
  id: string;                 // txn_…
  kind: 'charge' | 'refund' | 'fee' | 'other';
  date: string;               // YYYY-MM-DD the money moved
  amount: number;             // CZK, signed (refunds negative)
  fee: number;                // CZK Stripe kept on this line
  net: number;                // CZK, signed
  sessionId?: string;         // cs_… of the (original) checkout
  metadata?: Record<string, string>;
  customerName?: string;
  description?: string;
}

export interface StripePayoutContents {
  payoutId: string;
  amount: number;             // CZK paid out
  arrivalDate: string;        // YYYY-MM-DD
  lines: PayoutLine[];
}

/** The slice of a Beds24 booking needed to recognise a web booking */
export interface WebBookingRef {
  reservationNumber: string;
  channel: string;
  checkInDate: string | null;
  checkOutDate: string | null;
  price: number;
  isCancelled: boolean;
  guestName: string;
}

export interface PlannedLine {
  line: PayoutLine;
  /** 'web' = website booking, 'payment_link' = link created in the app */
  source: 'web' | 'payment_link' | 'refund' | 'fee' | 'other';
  reservationNumbers: string[];
  guest?: string;
  stay?: string;
  /** Existing revenue records that already count this charge */
  covered: Array<{ id: string; invoiceNumber: string; amount: number }>;
}

export interface StripeSettlementPlan {
  transactionId: string;
  payoutId: string;
  date: string;               // payout (bank) date — the booking date of every record
  gross: number;              // charges − refunds ± adjustments
  fees: number;
  net: number;                // = payout = bank credit
  /** Σ net of the lines equals the payout and the bank credit, to the haléř */
  ties: boolean;
  lines: PlannedLine[];
  /** Revenue still to book (gross minus charges already on a revenue record) */
  newRevenue: number;
  linkRevenueIds: string[];
  /** Anything a human should look at — Auto-match only books plans without issues */
  issues: string[];
  reason: string;
}

const cents = (x: number) => Math.round(x * 100);
const sameMoney = (a: number, b: number) => Math.abs(a - b) <= 1;

/** "Web booking 2026-06-30 → 2026-07-01" — the description the app logs for website sessions */
function stayFromText(s?: string): { arrival?: string; departure?: string } {
  const m = (s ?? '').match(/(\d{4}-\d{2}-\d{2})\D+(\d{4}-\d{2}-\d{2})/);
  return m ? { arrival: m[1], departure: m[2] } : {};
}

/**
 * The Direct-Web booking(s) a website charge paid for: same stay; the one with the
 * charged price, or several rows of one multi-room order that sum to it.
 */
export function matchWebBooking(
  arrival: string | undefined,
  departure: string | undefined,
  amount: number,
  bookings: WebBookingRef[],
): WebBookingRef[] {
  if (!arrival || !departure) return [];
  const sameStay = bookings.filter((b) => b.channel === 'Direct-Web' && b.checkInDate === arrival && b.checkOutDate === departure);
  const active = sameStay.filter((b) => !b.isCancelled);
  const exact = active.filter((b) => sameMoney(b.price, amount));
  if (exact.length === 1) return exact;
  if (active.length >= 2 && sameMoney(active.reduce((s, b) => s + b.price, 0), amount)) return active;
  if (active.length === 1) return active;            // e.g. a voucher made the charge differ
  if (active.length === 0 && sameStay.length === 1) return sameStay; // cancelled after paying
  return [];
}

function isFreeRecord(r: RevenueInvoice): boolean {
  return !r.bankTransactionId && !r.settlementGroupId && r.category !== 'mistake' && r.category !== 'ota_gross';
}

export function planStripeSettlement(input: {
  tx: BankTransaction;
  payout: StripePayoutContents;
  revenueInvoices: RevenueInvoice[];
  bookings: WebBookingRef[];
}): StripeSettlementPlan {
  const { tx, payout, revenueInvoices, bookings } = input;
  const issues: string[] = [];
  const claimed = new Set<string>();
  const planned: PlannedLine[] = [];

  for (const line of payout.lines) {
    if (line.kind === 'fee' || line.kind === 'other') {
      planned.push({ line, source: line.kind, reservationNumbers: [], covered: [] });
      continue;
    }
    const meta = line.metadata ?? {};
    const linkReservation = meta.reservationNumber?.trim();
    const stay = meta.arrival && meta.departure ? { arrival: meta.arrival, departure: meta.departure } : stayFromText(line.description);
    const stayText = stay.arrival ? `${stay.arrival} → ${stay.departure}` : undefined;

    if (line.kind === 'refund') {
      const res = linkReservation ? [linkReservation]
        : matchWebBooking(stay.arrival, stay.departure, -line.amount, bookings).map((b) => b.reservationNumber);
      planned.push({ line, source: 'refund', reservationNumbers: res, guest: line.customerName, stay: stayText, covered: [] });
      continue;
    }

    // Charge: payment link (has the reservation number) or website booking (stay dates)
    const source: PlannedLine['source'] = linkReservation ? 'payment_link' : 'web';
    const matched = linkReservation ? [] : matchWebBooking(stay.arrival, stay.departure, line.amount, bookings);
    const reservationNumbers = linkReservation ? [linkReservation] : matched.map((b) => b.reservationNumber);
    const guest = line.customerName || matched[0]?.guestName;

    const covered: PlannedLine['covered'] = [];
    const payRecord = line.sessionId ? revenueInvoices.find((r) => r.id === `pay-${line.sessionId}`) : undefined;
    if (payRecord && isFreeRecord(payRecord) && !claimed.has(payRecord.id)) {
      covered.push({ id: payRecord.id, invoiceNumber: payRecord.invoiceNumber, amount: payRecord.amountCZK });
    }
    if (source === 'web') {
      // An invoice issued on request for a website booking is a document, not separate revenue
      for (const r of revenueInvoices) {
        if (r.sourceType === 'issued' && r.reservationNumber && reservationNumbers.includes(r.reservationNumber)
            && isFreeRecord(r) && !claimed.has(r.id) && !covered.some((c) => c.id === r.id)) {
          covered.push({ id: r.id, invoiceNumber: r.invoiceNumber, amount: r.amountCZK });
        }
      }
      const paidElsewhere = revenueInvoices.filter((r) => r.sourceType === 'issued' && r.reservationNumber
        && reservationNumbers.includes(r.reservationNumber) && (r.bankTransactionId || r.settlementGroupId));
      for (const r of paidElsewhere) {
        issues.push(`${r.invoiceNumber} (${r.reservationNumber}) is already matched to another payment, yet the guest also paid ${line.amount.toLocaleString('cs-CZ')} Kč by card`);
      }
      if (reservationNumbers.length === 0) {
        issues.push(`Couldn't tie the ${line.amount.toLocaleString('cs-CZ')} Kč website payment of ${line.date}${stayText ? ` (stay ${stayText})` : ''} to a Beds24 booking — check no invoice was issued for it`);
      }
    }
    for (const c of covered) claimed.add(c.id);
    const coveredSum = covered.reduce((s, c) => s + c.amount, 0);
    if (covered.length > 0 && !sameMoney(coveredSum, line.amount)) {
      issues.push(`${covered.map((c) => c.invoiceNumber).join(' + ')} = ${coveredSum.toLocaleString('cs-CZ')} Kč but Stripe charged ${line.amount.toLocaleString('cs-CZ')} Kč`);
    }
    planned.push({ line, source, reservationNumbers, guest, stay: stayText, covered });
  }

  const sum = (f: (l: PayoutLine) => number) => payout.lines.reduce((s, l) => s + cents(f(l)), 0) / 100;
  const gross = sum((l) => (l.kind === 'fee' ? 0 : l.amount));
  const fees = sum((l) => l.fee + (l.kind === 'fee' ? -l.amount : 0));
  const net = sum((l) => l.net);
  const ties = cents(net) === cents(payout.amount) && cents(payout.amount) === cents(tx.amount);
  if (!ties) {
    issues.unshift(`Payout contents add up to ${net.toLocaleString('cs-CZ')} Kč, the bank shows ${tx.amount.toLocaleString('cs-CZ')} Kč`);
  }

  const coveredCharges = planned
    .filter((p) => (p.source === 'web' || p.source === 'payment_link') && p.covered.length > 0)
    .reduce((s, p) => s + cents(p.line.amount), 0) / 100;
  const newRevenue = Math.round((gross - coveredCharges) * 100) / 100;
  const bookingsCount = planned.filter((p) => p.source === 'web' || p.source === 'payment_link').length;

  return {
    transactionId: tx.id,
    payoutId: payout.payoutId,
    date: tx.date,
    gross,
    fees,
    net,
    ties,
    lines: planned,
    newRevenue,
    linkRevenueIds: planned.flatMap((p) => p.covered.map((c) => c.id)),
    issues,
    reason: `Stripe payout ${payout.payoutId} · ${bookingsCount} booking${bookingsCount !== 1 ? 's' : ''} · fees ${fees.toLocaleString('cs-CZ')} Kč · ties to the bank exactly`,
  };
}

/**
 * A Stripe credit Auto-match / the drawer may book: still unlinked revenue. Payouts
 * already tagged by hand (e.g. "Net settlement" for Apr–Jul 2026) belong to closed
 * months and are left alone — Unmatch one first to rebuild it on purpose.
 */
export function isOpenStripeCredit(t: BankTransaction): boolean {
  if (t.direction !== 'credit' || !/stripe/i.test(t.counterpartyName ?? '')) return false;
  return t.state === 'revenue' && !t.settlementGroupId && !t.revenueInvoiceId;
}

export interface StripeSettlementRecords {
  group: SettlementGroup;
  revenueRecord: RevenueInvoice | null;
  feeRecord: SupplierInvoice | null;
}

/** The records a plan books (ids derive from the payout, so a payout can't be booked twice) */
export function buildStripeSettlementRecords(plan: StripeSettlementPlan, groupId: string, nowIso: string): StripeSettlementRecords {
  const short = plan.payoutId.slice(-8);
  const reservations = plan.lines.filter((p) => p.source === 'web' && p.covered.length === 0).flatMap((p) => p.reservationNumbers);
  const revenueRecord: RevenueInvoice | null = Math.abs(plan.newRevenue) >= 0.005 ? {
    id: `stripe-rev-${plan.payoutId}`,
    sourceType: 'direct',
    category: 'accommodation_direct',
    status: 'reconciled',
    invoiceNumber: `STRIPE-${short}`,
    invoiceDate: plan.date,
    dueDate: plan.date,
    amountCZK: plan.newRevenue,
    clientName: 'Web bookings (Stripe)',
    description: `Web bookings paid via Stripe · payout ${plan.date}${reservations.length ? ` · ${reservations.join(', ')}` : ''}`,
    settlementGroupId: groupId,
    reconciledAt: nowIso,
    createdAt: nowIso,
  } : null;
  const feeRecord: SupplierInvoice | null = plan.fees >= 0.005 ? {
    id: `stripe-fee-${plan.payoutId}`,
    supplierName: 'Stripe Technology Europe Ltd',
    invoiceNumber: `stripe-fees-${short}`,
    invoiceDate: plan.date,
    dueDate: plan.date,
    amountCZK: plan.fees,
    category: DISTRIBUTION_FEES_CATEGORY,
    status: 'reconciled',
    sourceType: 'manual',
    settlementGroupId: groupId,
    autoProcessed: true,
    description: `Stripe processing fees · payout ${plan.date}`,
    createdAt: nowIso,
  } : null;
  const group: SettlementGroup = {
    id: groupId,
    name: `Stripe payout ${plan.date}`,
    transactionIds: [plan.transactionId],
    invoiceIds: feeRecord ? [feeRecord.id] : [],
    createdAt: nowIso,
    source: 'stripe',
    periodStart: plan.date,
    periodEnd: plan.date,
    grossAmount: plan.gross,
    commissionAmount: plan.fees,
    netAmount: plan.net,
    revenueInvoiceId: revenueRecord?.id,
    stripePayoutId: plan.payoutId,
  };
  return { group, revenueRecord, feeRecord };
}

/**
 * Apply a plan to the in-memory collections (callers persist them). Throws when
 * the credit is no longer open or this payout was already booked.
 */
export function applyStripeSettlement(
  plan: StripeSettlementPlan,
  data: { transactions: BankTransaction[]; revenueInvoices: RevenueInvoice[]; supplierInvoices: SupplierInvoice[]; groups: SettlementGroup[] },
  groupId: string,
  nowIso: string,
): StripeSettlementRecords {
  const ti = data.transactions.findIndex((t) => t.id === plan.transactionId);
  if (ti === -1 || !isOpenStripeCredit(data.transactions[ti])) throw new Error('This Stripe payout is already linked');
  if (data.groups.some((g) => g.stripePayoutId === plan.payoutId)) throw new Error('This Stripe payout is already booked');

  const records = buildStripeSettlementRecords(plan, groupId, nowIso);
  data.groups.push(records.group);
  if (records.revenueRecord) data.revenueInvoices.push(records.revenueRecord);
  if (records.feeRecord) data.supplierInvoices.push(records.feeRecord);

  const link = new Set(plan.linkRevenueIds);
  for (let i = 0; i < data.revenueInvoices.length; i++) {
    const r = data.revenueInvoices[i];
    if (link.has(r.id)) data.revenueInvoices[i] = { ...r, status: 'reconciled', settlementGroupId: groupId, reconciledAt: nowIso };
  }
  data.transactions[ti] = {
    ...data.transactions[ti],
    state: 'grouped',
    settlementGroupId: groupId,
    grossAmount: undefined,
    deductedInvoiceIds: undefined,
    reconciledAt: nowIso,
    autoMatchReason: plan.reason,
  };
  return records;
}

/**
 * Server-side loader + service for the VAT section.
 *
 * Reads the same stores the P&L and reconciliation use (so the VAT numbers sit
 * on the same records), normalises them into the pure engine's input
 * (haléře, Prague-local dates), and exposes month / overview computations to
 * the API routes.
 */
import { readAllSupplierInvoices } from '@/utils/supplierInvoicesStore';
import { readAllRevenueInvoices } from '@/utils/revenueInvoicesStore';
import { readAllSettlementGroups } from '@/utils/settlementGroupsStore';
import { readAllStripePayments } from '@/utils/stripePaymentsStore';
import { readAllAdditionalPayments } from '@/utils/additionalPaymentsStore';
import { readAllBankTransactions } from '@/utils/bankTransactionsStore';
import { isReportSettlement } from '@/types/settlementGroup';
import type { VatMonthResult, VatOverview, VatSettings } from '@/types/vat';
import { readVatSettings } from '@/data-access/vatSettings';
import { db } from '@/lib/db';
import { bookingsMirror } from '@/lib/db/schema';
import { toHal } from './money';
import {
  type InReservation, type InRefund, type InRevenueInvoice, type InSettlement, type InStripePayment, type InSupplierInvoice,
  type RevenueBuild, type VatEngineInput, buildRevenue, computeThreshold, computeVatMonth, overviewMonth, thresholdFlags,
} from './engine';
import { loadFxLookup } from './cnb';

const PRAGUE_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit' });

/** ISO timestamp → the calendar date in Prague (a 23:30 UTC payment on the 30th is the 1st locally). */
export function pragueDate(isoTimestamp: string): string {
  return PRAGUE_DATE.format(new Date(isoTimestamp));
}

export function pragueToday(): string {
  return PRAGUE_DATE.format(new Date());
}

const STAY_RE = /(\d{4}-\d{2}-\d{2})\s*(?:→|->|–|-)\s*(\d{4}-\d{2}-\d{2})/;

export interface VatData {
  settings: VatSettings;
  input: Omit<VatEngineInput, 'month' | 'today'>;
  revenue: RevenueBuild;
  /** Warnings about the data sources themselves (e.g. booking data unavailable). */
  sourceWarnings: string[];
}

async function loadReservations(warnings: string[]): Promise<Record<string, InReservation>> {
  try {
    const rows = await db
      .select({
        reservationNumber: bookingsMirror.reservationNumber,
        channel: bookingsMirror.channel,
        checkIn: bookingsMirror.checkInDate,
        checkOut: bookingsMirror.checkOutDate,
        isCancelled: bookingsMirror.isCancelled,
        status: bookingsMirror.status,
      })
      .from(bookingsMirror);
    const out: Record<string, InReservation> = {};
    for (const r of rows) {
      out[r.reservationNumber] = {
        channel: r.channel,
        checkIn: r.checkIn ?? null,
        checkOut: r.checkOut ?? null,
        cancelled: r.isCancelled || r.status === 'cancelled',
      };
    }
    return out;
  } catch (err) {
    console.error('[vat] bookings mirror unavailable:', err);
    warnings.push('Booking data (stay dates, channels) could not be loaded — direct sales fall back to payment / invoice dates.');
    return {};
  }
}

export async function loadVatData(): Promise<VatData> {
  const sourceWarnings: string[] = [];
  const [supplier, revenue, groups, stripe, additional, bank, settings, reservations] = await Promise.all([
    readAllSupplierInvoices(),
    readAllRevenueInvoices(),
    readAllSettlementGroups(),
    readAllStripePayments(),
    readAllAdditionalPayments(),
    readAllBankTransactions(),
    readVatSettings(),
    loadReservations(sourceWarnings),
  ]);

  const bankDate = new Map<string, string>();
  for (const tx of bank ?? []) if (tx.direction === 'credit') bankDate.set(tx.id, tx.date);

  const settlements: InSettlement[] = (groups ?? []).filter(isReportSettlement).map((g) => ({
    id: g.id,
    name: g.name,
    source: g.source === 'booking' || g.source === 'airbnb' ? g.source : 'other',
    periodStart: g.periodStart ?? null,
    periodEnd: g.periodEnd ?? null,
    grossHal: g.grossAmount === undefined || g.grossAmount === null ? null : toHal(g.grossAmount),
    commissionHal: g.commissionAmount === undefined || g.commissionAmount === null ? null : toHal(g.commissionAmount),
    adjustmentsHal: g.adjustmentsAmount === undefined || g.adjustmentsAmount === null ? null : toHal(g.adjustmentsAmount),
  }));

  const revenueInvoices: InRevenueInvoice[] = (revenue ?? []).map((r) => ({
    id: r.id,
    number: r.invoiceNumber,
    date: r.invoiceDate,
    amountHal: toHal(r.amountCZK),
    category: r.category,
    sourceType: r.sourceType,
    reservationNumber: r.reservationNumber?.trim() || null,
    clientName: r.clientName?.trim() || null,
    guestName: r.guestName?.trim() || null,
    settlementGroupId: r.settlementGroupId ?? null,
    paidDate: r.bankTransactionId ? bankDate.get(r.bankTransactionId) ?? null : null,
  }));

  const stripePayments: InStripePayment[] = (stripe ?? []).map((p) => {
    const stay = STAY_RE.exec(p.description ?? '');
    return {
      sessionId: p.sessionId,
      description: p.description ?? '',
      amountHal: toHal(p.amountCzk),
      reservationNumber: p.reservationNumber && /^BH-\d+$/.test(p.reservationNumber) ? p.reservationNumber : null,
      paidDate: pragueDate(p.paidAt),
      live: p.sessionId.startsWith('cs_live_'),
      stayFrom: stay?.[1] ?? null,
      stayTo: stay?.[2] ?? null,
    };
  });

  const refunds: InRefund[] = [];
  for (const ap of additional ?? []) {
    for (const rf of ap.refunds ?? []) {
      if (rf.status !== 'succeeded') continue;
      refunds.push({
        id: rf.id,
        reservationNumber: ap.reservationNumber || null,
        amountHal: toHal(rf.amountCzk),
        date: pragueDate(rf.refundedAt),
        description: ap.description ?? '',
      });
    }
  }

  const supplierInvoices: InSupplierInvoice[] = (supplier ?? []).map((s) => ({
    id: s.id,
    supplierName: s.supplierName ?? '',
    supplierIco: s.supplierICO ?? null,
    invoiceNumber: s.invoiceNumber ?? '',
    date: s.duzpDate || s.invoiceDate,
    invoiceDate: s.invoiceDate,
    dueDate: s.dueDate ?? null,
    currency: (s.invoiceCurrency || 'CZK').toUpperCase(),
    amountMinor: toHal(s.amountCZK),
    vatMinor: toHal(s.vatAmountCZK ?? 0),
    breakdown: s.vatBreakdown?.map((r) => ({ rate: Number(r.rate), baseMinor: toHal(r.base ?? 0), vatMinor: toHal(r.vat ?? 0) })) ?? null,
    category: s.category,
    creditNote: s.documentType === 'credit_note',
    status: s.status,
    settlementGroupId: s.settlementGroupId ?? null,
    paid: s.status === 'reconciled' || !!s.bankTransactionId || (s.settlementTransactionIds?.length ?? 0) > 0,
  }));

  const fx = await loadFxLookup(supplierInvoices.filter((s) => s.currency !== 'CZK').map((s) => s.date));

  const input: Omit<VatEngineInput, 'month' | 'today'> = {
    settings, settlements, revenueInvoices, stripePayments, refunds, reservations, supplierInvoices, fx,
  };
  return { settings, input, revenue: buildRevenue(input), sourceWarnings };
}

/** One month, ready for the UI / exports (threshold + data-source flags included). */
export function monthResult(data: VatData, month: string, today = pragueToday()): VatMonthResult {
  const r = computeVatMonth({ ...data.input, month, today }, data.revenue);
  const threshold = computeThreshold(data.revenue, Number(month.slice(0, 4)));
  const extra = thresholdFlags(threshold, data.settings.config.payerFrom);
  for (const w of data.sourceWarnings) extra.push({ code: 'DATA_SOURCE', severity: 'warning', title: w });
  const order = { error: 0, warning: 1, info: 2 } as const;
  r.flags = [...extra, ...r.flags].sort((a, b) => order[a.severity] - order[b.severity]);
  r.generatedAt = new Date().toISOString();
  return r;
}

export function overview(data: VatData, year: number, today = pragueToday()): VatOverview {
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const month = `${year}-${String(m).padStart(2, '0')}`;
    // Same computation as the month view (incl. threshold flags) so the counts always agree
    months.push(overviewMonth(monthResult(data, month, today)));
  }
  return { year, months, threshold: computeThreshold(data.revenue, year), payerFrom: data.settings.config.payerFrom };
}

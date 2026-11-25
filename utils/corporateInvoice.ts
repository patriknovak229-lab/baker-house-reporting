/**
 * Corporate invoices — shared vocabulary and the pure rules behind them.
 *
 * A corporate agreement is paid on invoice. An invoice bills a RANGE OF NIGHTS
 * of one agreement:
 *
 *   monthly — one calendar month (the nights slept in it). Scheduled ahead,
 *             one row per month, issued + emailed by the 09:00 cron on its
 *             issue date.
 *   adhoc   — any range the operator picks (often the whole agreement),
 *             issued now or scheduled for one date.
 *
 * Both kinds go through the same line builder, so a stay that crosses a month
 * end is split the same way whichever invoices end up covering it: the stay's
 * price is spread over its nights in WHOLE CROWNS (largest remainder, so the
 * nights always sum back to the stay price exactly) and an invoice takes the
 * nights inside its range. Two invoices over adjacent ranges therefore always
 * add up to the stays, to the crown.
 *
 * Client-safe: no server imports. The Corporate detail panel computes its
 * preview with these functions, the API and the cron issue with them.
 */
import { addDays, isYmd, nightsBetween } from './corporateSchedule';
import { allocateCzk } from './invoiceUtils';
import type { StayStatus } from './corporateShared';

// ─── Enumerations ────────────────────────────────────────────────────────────

export type CorporateInvoiceKind = 'monthly' | 'adhoc';

/**
 * scheduled — waiting for its issue date; no number yet, amount not frozen.
 * issued    — numbered and frozen (PDF available), not emailed yet.
 * sent      — emailed to the company's invoice address.
 * paid      — payment confirmed (bank match in Accounting, or by hand).
 * void      — cancelled. A scheduled one simply never goes out; an issued one
 *             keeps its number and its revenue record is marked a mistake.
 */
export type CorporateInvoiceStatus = 'scheduled' | 'issued' | 'sent' | 'paid' | 'void';

export const INVOICE_STATUS_LABELS: Record<CorporateInvoiceStatus, string> = {
  scheduled: 'Scheduled',
  issued: 'Issued',
  sent: 'Sent',
  paid: 'Paid',
  void: 'Void',
};

/** When a MONTHLY invoice is issued, relative to the month it bills. */
export type IssueTiming =
  | { kind: 'before_month'; days: number } // in advance: N days before the 1st
  | { kind: 'month_start' } // the 1st of the billed month
  | { kind: 'month_end' } // the last day of the billed month
  | { kind: 'after_month' }; // the 1st of the following month (in arrears)

/**
 * When the company has to pay.
 *   days_after_issue — "splatnost 14 dní", the Czech default.
 *   day_of_month     — a fixed day relative to the BILLED month:
 *                      monthOffset −1 = the month before (pay in advance),
 *                      0 = the billed month, +1 = the month after.
 *                      `day` 31 means "the last day", whatever the month's length.
 */
export type DueRule =
  | { kind: 'days_after_issue'; days: number }
  | { kind: 'day_of_month'; day: number; monthOffset: -1 | 0 | 1 };

export const ISSUE_TIMING_PRESETS: { key: string; label: string; timing: IssueTiming }[] = [
  { key: 'before-14', label: 'In advance — 14 days before the month', timing: { kind: 'before_month', days: 14 } },
  { key: 'before-7', label: 'In advance — 7 days before the month', timing: { kind: 'before_month', days: 7 } },
  { key: 'month-start', label: 'On the 1st of the billed month', timing: { kind: 'month_start' } },
  { key: 'month-end', label: 'On the last day of the billed month', timing: { kind: 'month_end' } },
  { key: 'after-month', label: 'On the 1st of the following month (in arrears)', timing: { kind: 'after_month' } },
];

export const DUE_RULE_PRESETS: { key: string; label: string; rule: DueRule }[] = [
  { key: 'days-14', label: '14 days after issue', rule: { kind: 'days_after_issue', days: 14 } },
  { key: 'days-7', label: '7 days after issue', rule: { kind: 'days_after_issue', days: 7 } },
  { key: 'days-30', label: '30 days after issue', rule: { kind: 'days_after_issue', days: 30 } },
  { key: 'prev-end', label: 'By the end of the previous month (paid in advance)', rule: { kind: 'day_of_month', day: 31, monthOffset: -1 } },
  { key: 'same-15', label: 'By the 15th of the billed month', rule: { kind: 'day_of_month', day: 15, monthOffset: 0 } },
  { key: 'same-end', label: 'By the end of the billed month', rule: { kind: 'day_of_month', day: 31, monthOffset: 0 } },
  { key: 'next-15', label: 'By the 15th of the following month', rule: { kind: 'day_of_month', day: 15, monthOffset: 1 } },
];

// ─── Records as the API hands them to the client ─────────────────────────────

/** One stay (or the part of it inside the invoiced range) on an invoice. */
export interface CorporateInvoiceLine {
  stayId: string;
  seq: number;
  reservationNumber: string | null;
  roomId: number;
  /** Who slept there, as Beds24 has it (or the agreement's guest). May be empty. */
  guestName: string;
  /** First night of this stay inside the range. */
  from: string;
  /** Morning after the last night inside the range (checkout-style end). */
  until: string;
  nights: number;
  amountCzk: number;
  /** The whole stay, for context on the line. */
  stayArrival: string;
  stayDeparture: string;
  stayNights: number;
  stayPriceCzk: number;
  /** beds24 = dates/price read from the live booking; agreement = our stay row. */
  source: 'beds24' | 'agreement';
}

/** Who the invoice is addressed to — snapshotted when it is issued. */
export interface CorporateBillTo {
  companyName: string;
  companyAddress: string;
  ico: string;
  vatNumber: string;
  billingEmail: string;
}

export interface CorporateInvoice {
  id: string;
  agreementId: string;
  kind: CorporateInvoiceKind;
  status: CorporateInvoiceStatus;
  /** First night billed (YYYY-MM-DD). */
  periodFrom: string;
  /** Last night billed, inclusive (YYYY-MM-DD) — same convention as the agreement's endDate. */
  periodTo: string;
  /** 'YYYY-MM' for a monthly invoice. */
  billedMonth: string | null;
  /** Planned issue date while scheduled; the real one once issued. */
  issueDate: string;
  dueDate: string;
  dueRule: DueRule | null;
  includePaymentDetails: boolean;
  invoiceNumber: string | null;
  /** Frozen at issue; null while scheduled. */
  amountCzk: number | null;
  lines: CorporateInvoiceLine[] | null;
  billTo: CorporateBillTo | null;
  sentAt: string | null;
  sentTo: string | null;
  sendCount: number;
  paidAt: string | null;
  paidSource: 'manual' | 'bank' | null;
  /** Payment check hidden from Transactions until this date. */
  paymentCheckSnoozedUntil: string | null;
  /** Last problem issuing or sending it. */
  error: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A stay as the line builder needs it — from our stay row, or overlaid with Beds24. */
export interface InvoiceSourceStay {
  stayId: string;
  seq: number;
  reservationNumber: string | null;
  roomId: number;
  guestName: string;
  arrival: string;
  departure: string;
  priceCzk: number;
  source: 'beds24' | 'agreement';
}

export interface InvoicePreview {
  periodFrom: string;
  periodTo: string;
  lines: CorporateInvoiceLine[];
  totalCzk: number;
  nights: number;
  /** Differences between our stay rows and Beds24, stays left off, etc. */
  notes: string[];
  /** Wanted stays inside the range that are not booked (planned / failed). */
  pending: { seq: number; arrival: string; departure: string; status: StayStatus }[];
  /** False when Beds24 couldn't be read and the lines come from our rows only. */
  verified: boolean;
}

// ─── Month helpers ───────────────────────────────────────────────────────────

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isYm(v: unknown): v is string {
  return typeof v === 'string' && YM.test(v);
}

/** 'YYYY-MM' of a date. */
export function monthOf(ymd: string): string {
  return ymd.slice(0, 7);
}

/** Move a 'YYYY-MM' by `n` months (n may be negative). */
export function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export function firstDayOfMonth(ym: string): string {
  return `${ym}-01`;
}

export function lastDayOfMonth(ym: string): string {
  return addDays(firstDayOfMonth(shiftMonth(ym, 1)), -1);
}

/** Day `day` of `ym`, clamped to the month's length (31 → the last day). */
export function dayOfMonth(ym: string, day: number): string {
  const last = lastDayOfMonth(ym);
  const lastDay = Number(last.slice(8, 10));
  const d = Math.min(Math.max(1, Math.round(day)), lastDay);
  return `${ym}-${String(d).padStart(2, '0')}`;
}

/** "December 2026" */
export function monthLabel(ym: string): string {
  return new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** "prosinec 2026 / December 2026" for the invoice document. */
export function monthLabelBilingual(ym: string): string {
  const d = new Date(`${ym}-01T00:00:00Z`);
  const cs = d.toLocaleDateString('cs-CZ', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return `${cs} / ${monthLabel(ym)}`;
}

// ─── Issue + due dates ───────────────────────────────────────────────────────

/** Planned issue date for the invoice billing `ym`. Never before `today`. */
export function issueDateFor(timing: IssueTiming, ym: string, today: string): string {
  let d: string;
  switch (timing.kind) {
    case 'before_month':
      d = addDays(firstDayOfMonth(ym), -Math.max(0, Math.round(timing.days)));
      break;
    case 'month_start':
      d = firstDayOfMonth(ym);
      break;
    case 'month_end':
      d = lastDayOfMonth(ym);
      break;
    case 'after_month':
      d = firstDayOfMonth(shiftMonth(ym, 1));
      break;
  }
  return d < today ? today : d;
}

/**
 * The due date for an invoice billing `billedMonth` (YYYY-MM), issued on
 * `issueDate` (YYYY-MM-DD), under `rule`. Returns YYYY-MM-DD.
 *
 * Contract (see utils/corporateInvoice.test.ts):
 *   days_after_issue 14, issued 2026-11-25            → 2026-12-09
 *   day_of_month 31, offset −1, billed 2026-12        → 2026-11-30  (end of previous month)
 *   day_of_month 15, offset 0,  billed 2027-01        → 2027-01-15
 *   day_of_month 31, offset 0,  billed 2027-02        → 2027-02-28  (clamped to the month)
 *   day_of_month 15, offset +1, billed 2026-12        → 2027-01-15  (crosses the year)
 *
 * It may return a date BEFORE `issueDate` (e.g. "end of previous month" for
 * an invoice issued late) — the caller flags that row; don't clamp it here.
 */
export function dueDateFor(rule: DueRule, billedMonth: string, issueDate: string): string {
  if (rule.kind === 'days_after_issue') return addDays(issueDate, rule.days);
  // day_of_month: move to the right month, then pick the day (31 = that month's last day).
  // A result before issueDate is kept on purpose: the form and server flag it.
  return dayOfMonth(shiftMonth(billedMonth, rule.monthOffset), rule.day);
}

export function describeDueRule(rule: DueRule | null): string {
  if (!rule) return 'fixed date';
  const preset = DUE_RULE_PRESETS.find((p) => JSON.stringify(p.rule) === JSON.stringify(rule));
  if (preset) return preset.label;
  if (rule.kind === 'days_after_issue') return `${rule.days} days after issue`;
  const which = rule.monthOffset === -1 ? 'previous' : rule.monthOffset === 1 ? 'following' : 'billed';
  return `By day ${rule.day >= 31 ? 'last' : rule.day} of the ${which} month`;
}

/** Untrusted → DueRule, or null. */
export function parseDueRule(raw: unknown): DueRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'days_after_issue') {
    const days = Number(r.days);
    return Number.isInteger(days) && days >= 0 && days <= 120 ? { kind: 'days_after_issue', days } : null;
  }
  if (r.kind === 'day_of_month') {
    const day = Number(r.day);
    const monthOffset = Number(r.monthOffset);
    if (!Number.isInteger(day) || day < 1 || day > 31) return null;
    if (monthOffset !== -1 && monthOffset !== 0 && monthOffset !== 1) return null;
    return { kind: 'day_of_month', day, monthOffset };
  }
  return null;
}

// ─── Lines ───────────────────────────────────────────────────────────────────

/**
 * The stay price spread over its nights in whole crowns, summing exactly to
 * the price. 16 321 over 9 nights → 1 814 × 7 + 1 813 × 2 (or so) — never a
 * fraction of a crown on a corporate invoice, never a crown lost or gained.
 */
export function perNightAmounts(priceCzk: number, nights: number): number[] {
  if (nights <= 0) return [];
  // allocateCzk works in haléře; asking it to split hundredths of the price
  // and scaling back gives whole crowns with the same exactness guarantee.
  return allocateCzk(Math.round(priceCzk) / 100, new Array(nights).fill(1)).map((x) => Math.round(x * 100));
}

/**
 * The invoice lines for the nights `periodFrom` … `periodTo` (both inclusive
 * nights) of `stays`. A stay with no night in the range contributes nothing.
 */
export function buildInvoiceLines(
  stays: InvoiceSourceStay[],
  periodFrom: string,
  periodTo: string,
): { lines: CorporateInvoiceLine[]; totalCzk: number; nights: number } {
  const lines: CorporateInvoiceLine[] = [];
  const rangeEnd = addDays(periodTo, 1); // exclusive
  for (const s of [...stays].sort((a, b) => a.arrival.localeCompare(b.arrival) || a.seq - b.seq)) {
    const stayNights = nightsBetween(s.arrival, s.departure);
    if (stayNights <= 0) continue;
    const from = s.arrival > periodFrom ? s.arrival : periodFrom;
    const until = s.departure < rangeEnd ? s.departure : rangeEnd;
    const nights = nightsBetween(from, until);
    if (nights <= 0) continue;
    const perNight = perNightAmounts(s.priceCzk, stayNights);
    const offset = nightsBetween(s.arrival, from);
    const amountCzk = perNight.slice(offset, offset + nights).reduce((a, b) => a + b, 0);
    lines.push({
      stayId: s.stayId,
      seq: s.seq,
      reservationNumber: s.reservationNumber,
      roomId: s.roomId,
      guestName: s.guestName,
      from,
      until,
      nights,
      amountCzk,
      stayArrival: s.arrival,
      stayDeparture: s.departure,
      stayNights,
      stayPriceCzk: s.priceCzk,
      source: s.source,
    });
  }
  return {
    lines,
    totalCzk: lines.reduce((a, l) => a + l.amountCzk, 0),
    nights: lines.reduce((a, l) => a + l.nights, 0),
  };
}

/** Every month that holds at least one night of these stays, in order. */
export function monthsWithNights(stays: { arrival: string; departure: string }[]): string[] {
  const months = new Set<string>();
  for (const s of stays) {
    const lastNight = addDays(s.departure, -1);
    if (lastNight < s.arrival) continue;
    for (let m = monthOf(s.arrival); m <= monthOf(lastNight); m = shiftMonth(m, 1)) months.add(m);
  }
  return [...months].sort();
}

/** Do two inclusive night ranges share a night? */
export function rangesOverlap(aFrom: string, aTo: string, bFrom: string, bTo: string): boolean {
  return aFrom <= bTo && bFrom <= aTo;
}

/** The invoices that still claim their nights (everything but void). */
export function claimsNights(status: CorporateInvoiceStatus): boolean {
  return status !== 'void';
}

/** The first existing invoice whose range overlaps, or null. */
export function overlappingInvoice<T extends Pick<CorporateInvoice, 'status' | 'periodFrom' | 'periodTo'>>(
  existing: T[],
  periodFrom: string,
  periodTo: string,
): T | null {
  return existing.find((i) => claimsNights(i.status) && rangesOverlap(i.periodFrom, i.periodTo, periodFrom, periodTo)) ?? null;
}

// ─── Numbering ───────────────────────────────────────────────────────────────

/**
 * `INV-C2026-001` — a yearly sequence of its own. The digits (2026001) are the
 * variable symbol the company pays with, and Accounting's auto-match finds the
 * invoice by them. Seven digits can't collide with the booking-based guest
 * invoices (`INV-<8-digit Beds24 id>[-seq]`), so a payment never matches the
 * wrong document.
 */
export function corporateInvoiceNumber(year: number, seq: number): string {
  return `INV-C${year}-${String(seq).padStart(3, '0')}`;
}

export const CORPORATE_INVOICE_NUMBER_RE = /^INV-C(\d{4})-(\d{3,})$/;

export function variableSymbol(invoiceNumber: string): string {
  return invoiceNumber.replace(/\D/g, '');
}

// ─── Payment checks ──────────────────────────────────────────────────────────

/**
 * Is this invoice past its due date and still unpaid, as of `today`? It shows
 * up the day AFTER the due date — paying on the due date is on time.
 */
export function needsPaymentCheck(
  inv: Pick<CorporateInvoice, 'status' | 'dueDate' | 'paymentCheckSnoozedUntil'>,
  today: string,
): boolean {
  if (inv.status !== 'sent' && inv.status !== 'issued') return false;
  if (!(inv.dueDate < today)) return false;
  if (inv.paymentCheckSnoozedUntil && inv.paymentCheckSnoozedUntil > today) return false;
  return true;
}

export function daysPastDue(dueDate: string, today: string): number {
  return Math.max(0, nightsBetween(dueDate, today));
}

// ─── Billing details ─────────────────────────────────────────────────────────

/**
 * What an agreement still lacks before it can be invoiced — empty when it can.
 * A Czech invoice must name the customer and its address and identifier; we
 * also need somewhere to send it.
 */
export function missingBillingDetails(a: {
  companyName: string | null;
  companyAddress: string | null;
  ico: string | null;
  vatNumber: string | null;
  billingEmail: string | null;
}): string[] {
  const missing: string[] = [];
  if (!a.companyName?.trim()) missing.push('company name');
  if (!a.companyAddress?.trim()) missing.push('address');
  if (!a.ico?.trim() && !a.vatNumber?.trim()) missing.push('IČO or DIČ');
  if (!a.billingEmail?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.billingEmail.trim())) missing.push('invoice email');
  return missing;
}

export function isValidRange(from: unknown, to: unknown): from is string {
  return isYmd(from) && isYmd(to) && (from as string) <= (to as string);
}

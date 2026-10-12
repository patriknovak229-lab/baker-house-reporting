/**
 * VAT engine — turns the app's records for one month into the VAT return
 * (přiznání k DPH, DPHDP3) and the control statement (kontrolní hlášení,
 * DPHKH1), plus the red flags an operator must look at before filing.
 *
 * PURE: no I/O, no clock. Everything comes in through `VatEngineInput` (see
 * utils/vat/loadInputs.ts for how the app's stores are normalised into it),
 * so every rule here is unit-testable with synthetic data.
 *
 * Money is integer haléře throughout (utils/vat/money.ts).
 *
 * Tax-point rules (when the VAT obligation arises):
 *   - Booking.com / Airbnb: the settlement's accrual period (Booking by
 *     departure, Airbnb by payout ≈ check-in) — the host is paid around or
 *     after the stay, so the period is the taxable-supply date proxy.
 *   - Direct sales: the EARLIER of the payment date (a prepayment is taxed when
 *     received, § 20a) and the check-out date (DUZP). Falls back to the invoice
 *     date only when neither is known (flagged).
 *   - Stripe refunds: negative on the refund date (corrective tax document).
 */
import type {
  A2Kind, VatA2Row, VatDapRow, VatDecision, VatExcludedDoc, VatFlag, VatFlagItem, VatKhC,
  VatMonthResult, VatPurchaseDoc, VatRateTotals, VatRevenueLine, VatSettings, VatThreshold,
  VatOverviewMonth, RevenueSource, ExcludedReason,
} from '@/types/vat';
import { type Hal, fxToHal, roundDiv, splitGross, toWholeCzk, vatOnBase, formatHal } from './money';
import { classifySupplier, normalizeTaxId } from './classify';
import {
  AIRBNB_RATIO_TOLERANCE, AIRBNB_VAT_INCLUDED_RATIOS, CZ_LEGAL_FORM_RE, GOODS_CATEGORIES,
  KH_DETAIL_LIMIT_HAL, OTA_IDENTITY, RATE_REDUCED, RATE_STANDARD, THRESHOLD_IMMEDIATE_HAL,
  THRESHOLD_STANDARD_HAL, UNUSUAL_REDUCED_RATE_CATEGORIES, unpaidReversalMonths,
} from './config';
import { addDays, daysBetween, filingDeadline, monthEnd, monthStart, prevMonth } from './czechCalendar';
import { khXmlIssues } from './khXml';

// ─── Normalised inputs ───────────────────────────────────────────────────────

export interface InSettlement {
  id: string;
  name: string;
  source: 'booking' | 'airbnb' | 'other';
  periodStart: string | null;
  periodEnd: string | null;
  grossHal: Hal | null;
  commissionHal: Hal | null;
  adjustmentsHal: Hal | null;
}

export interface InRevenueInvoice {
  id: string;
  number: string;
  date: string;
  amountHal: Hal;
  category: string;
  sourceType: string;
  reservationNumber: string | null;
  clientName: string | null;
  guestName: string | null;
  settlementGroupId: string | null;
  /** Bank credit date when the invoice is matched to an incoming payment. */
  paidDate: string | null;
}

export interface InStripePayment {
  sessionId: string;
  description: string;
  amountHal: Hal;
  reservationNumber: string | null;
  paidDate: string;
  /** false for test-mode sessions (cs_test_…) — ignored. */
  live: boolean;
  stayFrom: string | null;
  stayTo: string | null;
}

export interface InRefund {
  id: string;
  reservationNumber: string | null;
  amountHal: Hal;
  date: string;
  description: string;
}

export interface InReservation {
  channel: string;
  checkIn: string | null;
  checkOut: string | null;
  cancelled: boolean;
}

export interface InBreakdownRow {
  rate: number;
  baseMinor: number;
  vatMinor: number;
}

export interface InSupplierInvoice {
  id: string;
  supplierName: string;
  supplierIco: string | null;
  invoiceNumber: string;
  /** Accrual date: DUZP, else the invoice date. */
  date: string;
  invoiceDate: string;
  dueDate: string | null;
  currency: string;
  /** Total incl. VAT in the invoice currency's minor units (haléře for CZK). */
  amountMinor: number;
  vatMinor: number;
  breakdown: InBreakdownRow[] | null;
  category: string;
  creditNote: boolean;
  status: string;
  settlementGroupId: string | null;
  paid: boolean;
}

export interface FxRate {
  rateMilli: number;
  unit: number;
  fixingDate: string;
}

export type FxLookup = (currency: string, date: string) => FxRate | null;

export interface VatEngineInput {
  month: string;
  today: string;
  settings: VatSettings;
  settlements: InSettlement[];
  revenueInvoices: InRevenueInvoice[];
  stripePayments: InStripePayment[];
  refunds: InRefund[];
  reservations: Record<string, InReservation>;
  supplierInvoices: InSupplierInvoice[];
  fx: FxLookup;
}

// ─── Small helpers ───────────────────────────────────────────────────────────

const OTA_CHANNELS = new Set(['Booking.com', 'Airbnb']);
const minDate = (a: string, b: string) => (a <= b ? a : b);
const fmt = (h: Hal) => `${formatHal(h)} Kč`;
const emptyTotals = (): VatRateTotals => ({ base21Hal: 0, vat21Hal: 0, base12Hal: 0, vat12Hal: 0 });

function addToTotals(t: VatRateTotals, rate: number, base: Hal, vat: Hal): void {
  if (rate === RATE_STANDARD) { t.base21Hal += base; t.vat21Hal += vat; }
  else if (rate === RATE_REDUCED) { t.base12Hal += base; t.vat12Hal += vat; }
  else throw new Error(`Unsupported VAT rate ${rate}`);
}

/** Collects flags; items with the same code merge under one heading. */
class FlagBag {
  private flags = new Map<string, VatFlag>();
  add(code: string, severity: VatFlag['severity'], title: string, detail?: string, item?: VatFlagItem): void {
    const key = `${code}|${severity}`;
    let f = this.flags.get(key);
    if (!f) {
      f = { code, severity, title, detail, items: [] };
      this.flags.set(key, f);
    }
    if (item) f.items!.push(item);
  }
  list(): VatFlag[] {
    const order = { error: 0, warning: 1, info: 2 } as const;
    return [...this.flags.values()]
      .map((f) => ({ ...f, items: f.items && f.items.length > 0 ? f.items : undefined }))
      .sort((a, b) => order[a.severity] - order[b.severity] || a.code.localeCompare(b.code));
  }
}

function decide(settings: VatSettings, key: string, fallback: VatDecision): { decision: VatDecision; decided: boolean } {
  const d = settings.decisions?.[key];
  return d ? { decision: d, decided: true } : { decision: fallback, decided: false };
}

// ─── Revenue: every sale with its tax point (all dates) ──────────────────────

type RevItem = VatRevenueLine;

interface RevFlag {
  date: string;
  code: string;
  severity: VatFlag['severity'];
  title: string;
  detail?: string;
  item: VatFlagItem;
}

export interface RevenueBuild {
  items: RevItem[];
  flags: RevFlag[];
}

function revenueLine(
  id: string, source: RevenueSource, label: string, ref: string, taxPoint: string, taxPointRule: string,
  rate: 12 | 21, gross: Hal, extra: Partial<VatRevenueLine> = {},
): RevItem {
  const { base, vat } = splitGross(gross, rate);
  return { id, source, label, ref, taxPoint, taxPointRule, ratePct: rate, grossHal: gross, baseHal: base, vatHal: vat, section: 'A.5', ...extra };
}

/** Build every revenue item (all months) with dedup + tax-point logic applied. */
export function buildRevenue(input: Pick<VatEngineInput, 'settlements' | 'revenueInvoices' | 'stripePayments' | 'refunds' | 'reservations' | 'settings'>): RevenueBuild {
  const items: RevItem[] = [];
  const flags: RevFlag[] = [];
  const { settings, reservations } = input;

  // 1) OTA settlements → gross by accrual period
  for (const s of input.settlements) {
    if (!s.periodStart || s.grossHal === null) continue;
    const source: RevenueSource = s.source === 'booking' ? 'booking' : s.source === 'airbnb' ? 'airbnb' : 'ota_other';
    const gross = s.grossHal + (s.adjustmentsHal ?? 0);
    const taxPoint = s.periodEnd ?? monthEnd(s.periodStart.slice(0, 7));
    items.push(revenueLine(`stl:${s.id}`, source, s.name, s.name, taxPoint, 'OTA settlement period', RATE_REDUCED, gross));
    if (s.adjustmentsHal) {
      flags.push({ date: taxPoint, code: 'OTA_ADJUSTMENTS', severity: 'info', title: 'OTA settlement includes adjustments',
        detail: 'Reservation changes / cancellations reported by the OTA are included in the taxable amount.',
        item: { label: s.name, amountHal: s.adjustmentsHal, date: taxPoint } });
    }
    if (s.periodEnd && s.periodStart.slice(0, 7) !== s.periodEnd.slice(0, 7)) {
      flags.push({ date: taxPoint, code: 'SETTLEMENT_SPANS_MONTHS', severity: 'warning', title: 'A settlement covers more than one month',
        detail: 'The whole amount is taxed in the month the period ends. Split the report per month if stays fall into different VAT periods.',
        item: { label: s.name, detail: `${s.periodStart} → ${s.periodEnd}`, amountHal: gross, date: taxPoint } });
    }
  }

  // 2) Revenue invoices (direct sales) — OTA gross records come from the settlements above
  const invoices = input.revenueInvoices.filter((r) => r.category !== 'ota_gross' && r.category !== 'mistake');
  const invoicePaidDate = new Map<string, string>();
  const droppedInvoice = new Set<string>();
  const representedBy = new Map<string, string>(); // invoice id → note

  // 2a) Stripe payments linked by reservation number (payment links / PAY-… records)
  const liveStripe = input.stripePayments.filter((p) => p.live && p.amountHal !== 0);
  const stripeByRes = new Map<string, InStripePayment[]>();
  for (const p of liveStripe) {
    if (!p.reservationNumber) continue;
    const list = stripeByRes.get(p.reservationNumber) ?? [];
    list.push(p);
    stripeByRes.set(p.reservationNumber, list);
  }
  const usedStripe = new Set<string>();
  const invByRes = new Map<string, InRevenueInvoice[]>();
  for (const inv of invoices) {
    if (!inv.reservationNumber) continue;
    const list = invByRes.get(inv.reservationNumber) ?? [];
    list.push(inv);
    invByRes.set(inv.reservationNumber, list);
  }
  for (const [res, payments] of stripeByRes) {
    const invs = invByRes.get(res);
    if (!invs || invs.length === 0) continue;
    const sumPay = payments.reduce((s, p) => s + p.amountHal, 0);
    const sumInv = invs.reduce((s, i) => s + i.amountHal, 0);
    if (Math.abs(sumPay - sumInv) <= 100) {
      // The invoices are paid by these Stripe payments: tax each payment on its date, drop the invoices.
      const stay = reservations[res];
      for (const p of payments) {
        usedStripe.add(p.sessionId);
        const checkOut = stay?.checkOut ?? p.stayTo;
        const taxPoint = checkOut ? minDate(p.paidDate, checkOut) : p.paidDate;
        const rule = checkOut && checkOut < p.paidDate ? 'check-out (DUZP)' : 'payment received (Stripe)';
        items.push(revenueLine(`stripe:${p.sessionId}`, 'stripe', `Stripe payment · ${res}`, invs.map((i) => i.number).join(', '),
          taxPoint, rule, RATE_REDUCED, p.amountHal, { reservationNumber: res }));
      }
      for (const inv of invs) droppedInvoice.add(inv.id);
    } else {
      flags.push({ date: payments[0].paidDate, code: 'STRIPE_INVOICE_MISMATCH', severity: 'error',
        title: 'Stripe payments and invoices for a reservation do not add up',
        detail: 'Counted from the invoices only. Check whether part of the stay was paid another way or an invoice is missing.',
        item: { label: `${res}: Stripe ${fmt(sumPay)} vs invoices ${fmt(sumInv)}`, date: payments[0].paidDate } });
      for (const p of payments) usedStripe.add(p.sessionId);
      for (const inv of invs) {
        const earliest = payments.map((p) => p.paidDate).sort()[0];
        invoicePaidDate.set(inv.id, inv.paidDate ? minDate(inv.paidDate, earliest) : earliest);
      }
    }
  }

  // 2b) Web bookings (no reservation number in Stripe) — match an invoice by exact amount + time window
  const claimedInvoice = new Set<string>();
  for (const p of liveStripe) {
    if (usedStripe.has(p.sessionId) || p.reservationNumber) continue;
    const windowFrom = addDays(p.paidDate, -10);
    const windowTo = addDays(p.stayTo ?? p.paidDate, 90);
    const candidates = invoices.filter((inv) =>
      !droppedInvoice.has(inv.id) && !claimedInvoice.has(inv.id) && !inv.settlementGroupId &&
      inv.category === 'accommodation_direct' && Math.abs(inv.amountHal - p.amountHal) <= 1 &&
      inv.date >= windowFrom && inv.date <= windowTo);
    const stay = candidates[0]?.reservationNumber ? reservations[candidates[0].reservationNumber] : undefined;
    const checkOut = stay?.checkOut ?? p.stayTo;
    const taxPoint = checkOut ? minDate(p.paidDate, checkOut) : p.paidDate;
    const rule = checkOut && checkOut < p.paidDate ? 'check-out (DUZP)' : 'payment received (Stripe)';

    if (candidates.length === 1) {
      const inv = candidates[0];
      claimedInvoice.add(inv.id);
      const key = `dup:${p.sessionId}`;
      const { decision, decided } = decide(settings, key, 'merge');
      flags.push({ date: taxPoint, code: 'DOUBLE_RECORDED', severity: 'warning',
        title: 'Same booking recorded twice (Stripe payment + invoice)',
        detail: 'By default it is counted once — taxed on the Stripe payment date, because a prepayment is taxable when received.',
        item: { label: `${inv.reservationNumber ?? 'no reservation'} · ${inv.number} = Stripe ${p.paidDate}`, amountHal: p.amountHal,
          date: p.paidDate, decisionKey: key, decision, decided, options: ['merge', 'separate'] } });
      items.push(revenueLine(`stripe:${p.sessionId}`, 'stripe', `Web booking (Stripe) · ${inv.reservationNumber ?? inv.number}`,
        inv.number, taxPoint, rule, RATE_REDUCED, p.amountHal, { reservationNumber: inv.reservationNumber ?? undefined }));
      if (decision === 'merge') droppedInvoice.add(inv.id);
      else representedBy.set(inv.id, 'Kept separately on purpose (operator decision)');
    } else {
      if (candidates.length > 1) {
        flags.push({ date: taxPoint, code: 'AMBIGUOUS_MATCH', severity: 'error',
          title: 'A Stripe payment matches several invoices',
          detail: 'Both the payment and the invoices are counted — resolve by hand before filing.',
          item: { label: `Stripe ${p.paidDate} · ${candidates.map((c) => c.number).join(', ')}`, amountHal: p.amountHal, date: p.paidDate } });
      } else {
        flags.push({ date: taxPoint, code: 'STRIPE_NOT_IN_BOOKS', severity: 'info',
          title: 'Web bookings paid by Stripe that are not in the books yet',
          detail: 'Included at the payment date (a prepayment is taxable when received). They will be booked when the Stripe payout arrives — make sure they are not added twice.',
          item: { label: p.description, amountHal: p.amountHal, date: p.paidDate } });
      }
      items.push(revenueLine(`stripe:${p.sessionId}`, 'stripe', p.description || 'Stripe payment', p.sessionId.slice(0, 18),
        taxPoint, rule, RATE_REDUCED, p.amountHal, { reservationNumber: p.reservationNumber ?? undefined }));
    }
    usedStripe.add(p.sessionId);
  }
  // Stripe payments with a reservation number but no invoice
  for (const p of liveStripe) {
    if (usedStripe.has(p.sessionId)) continue;
    const stay = p.reservationNumber ? reservations[p.reservationNumber] : undefined;
    const checkOut = stay?.checkOut ?? p.stayTo;
    const taxPoint = checkOut ? minDate(p.paidDate, checkOut) : p.paidDate;
    const rule = checkOut && checkOut < p.paidDate ? 'check-out (DUZP)' : 'payment received (Stripe)';
    flags.push({ date: taxPoint, code: 'STRIPE_NOT_IN_BOOKS', severity: 'info',
      title: 'Web bookings paid by Stripe that are not in the books yet',
      detail: 'Included at the payment date (a prepayment is taxable when received). They will be booked when the Stripe payout arrives — make sure they are not added twice.',
      item: { label: p.description || p.reservationNumber || p.sessionId, amountHal: p.amountHal, date: p.paidDate } });
    items.push(revenueLine(`stripe:${p.sessionId}`, 'stripe', p.description || 'Stripe payment', p.reservationNumber ?? p.sessionId.slice(0, 18),
      taxPoint, rule, RATE_REDUCED, p.amountHal, { reservationNumber: p.reservationNumber ?? undefined }));
  }

  // 2c) The remaining invoices
  for (const inv of invoices) {
    if (droppedInvoice.has(inv.id)) continue;
    const stay = inv.reservationNumber ? reservations[inv.reservationNumber] : undefined;
    const paid = invoicePaidDate.get(inv.id) ?? inv.paidDate;
    const checkOut = stay?.checkOut ?? null;
    let taxPoint: string;
    let rule: string;
    if (paid && checkOut) {
      taxPoint = minDate(paid, checkOut);
      rule = paid <= checkOut ? 'payment received before the stay' : 'check-out (DUZP)';
    } else if (checkOut) {
      taxPoint = checkOut;
      rule = 'check-out (DUZP)';
    } else if (paid) {
      // No stay data: the invoice date stands in for the DUZP. A payment AFTER the supply
      // doesn't create a new tax point; a payment before it (prepayment) does.
      taxPoint = minDate(paid, inv.date);
      rule = paid < inv.date ? 'payment received (before the invoice)' : 'invoice date (paid later)';
    } else {
      taxPoint = inv.date;
      rule = 'invoice date (no stay or payment data)';
      flags.push({ date: taxPoint, code: 'NO_STAY_DATES', severity: 'info',
        title: 'Invoice without stay or payment data — taxed on the invoice date',
        item: { label: `${inv.number} · ${inv.clientName ?? inv.guestName ?? ''}`.trim(), amountHal: inv.amountHal, date: inv.date } });
    }

    // Invoice for a Booking.com / Airbnb reservation — possibly already inside the OTA payout
    if (stay && OTA_CHANNELS.has(stay.channel)) {
      if (stay.cancelled) {
        flags.push({ date: taxPoint, code: 'OTA_CANCELLED_PAID_DIRECT', severity: 'info',
          title: 'Invoice for an OTA reservation that was cancelled on the OTA (guest paid directly)',
          detail: 'Counted as a direct sale — the OTA payout does not contain it.',
          item: { label: `${inv.reservationNumber} (${stay.channel}) · ${inv.number}`, amountHal: inv.amountHal, date: taxPoint } });
      } else {
        const paidDirect = !!paid;
        const key = `ota-inv:${inv.id}`;
        const { decision, decided } = decide(settings, key, paidDirect ? 'include' : 'exclude');
        flags.push({ date: taxPoint, code: paidDirect ? 'OTA_RESERVATION_PAID_DIRECT' : 'OTA_INVOICE_DUPLICATE', severity: 'warning',
          title: paidDirect
            ? 'Invoice for a live OTA reservation, paid to us directly'
            : 'Invoice for an OTA reservation — probably already in the OTA payout',
          detail: paidDirect
            ? 'Counted, because the money came to our account. Make sure the OTA payout does not include this stay too.'
            : 'Not counted by default: the OTA collected the payment and its payout statement already contains the stay. Include it only if the guest paid you directly.',
          item: { label: `${inv.reservationNumber} (${stay.channel}) · ${inv.number}`, amountHal: inv.amountHal, date: taxPoint,
            decisionKey: key, decision, decided, options: ['exclude', 'include'] } });
        if (decision === 'exclude') continue;
      }
    }

    const rate: 12 | 21 = inv.category === 'other_services' ? RATE_STANDARD : RATE_REDUCED;
    if (rate === RATE_STANDARD) {
      flags.push({ date: taxPoint, code: 'OTHER_SERVICES_RATE', severity: 'warning',
        title: 'Other services taxed at 21 %',
        detail: 'Services sold together with a stay (parking, extra cleaning…) can share the 12 % accommodation rate. Check each one.',
        item: { label: `${inv.number} · ${inv.clientName ?? inv.guestName ?? ''}`.trim(), amountHal: inv.amountHal, date: taxPoint } });
    }
    const customer = inv.clientName ?? '';
    if (Math.abs(inv.amountHal) > KH_DETAIL_LIMIT_HAL && (CZ_LEGAL_FORM_RE.test(customer) || /nemocnice|hospital|univerzit|škola|úřad|ministerstv/i.test(customer))) {
      flags.push({ date: taxPoint, code: 'COMPANY_CUSTOMER', severity: 'warning',
        title: 'Invoice over 10 000 Kč to a company — A.4 needs the customer’s DIČ',
        detail: 'If the customer is VAT-registered, this invoice must be itemised in A.4 with their DIČ. It is currently in the A.5 total.',
        item: { label: `${inv.number} · ${customer}`, amountHal: inv.amountHal, date: taxPoint } });
    }
    items.push(revenueLine(`inv:${inv.id}`, 'invoice', `Invoice ${inv.number}${inv.clientName || inv.guestName ? ` · ${inv.clientName ?? inv.guestName}` : ''}`,
      inv.number, taxPoint, rule, rate, inv.amountHal, { reservationNumber: inv.reservationNumber ?? undefined, note: representedBy.get(inv.id) }));
  }

  // 3) Stripe refunds — negative on the refund date
  for (const r of input.refunds) {
    if (r.amountHal === 0) continue;
    flags.push({ date: r.date, code: 'REFUND', severity: 'warning',
      title: 'Refund to a guest — issue a corrective tax document',
      detail: 'Included as a negative amount on the refund date. The guest needs an opravný daňový doklad.',
      item: { label: `${r.reservationNumber ?? ''} ${r.description}`.trim(), amountHal: -r.amountHal, date: r.date } });
    items.push(revenueLine(`refund:${r.id}`, 'refund', `Refund ${r.reservationNumber ?? ''}`.trim(), r.id, r.date, 'refund date', RATE_REDUCED, -r.amountHal,
      { reservationNumber: r.reservationNumber ?? undefined }));
  }

  return { items, flags };
}

// ─── Purchases ───────────────────────────────────────────────────────────────

function a2KindFor(eu: boolean, category: string): A2Kind | 'non_eu_goods' {
  const goods = GOODS_CATEGORIES.has(category);
  if (eu) return goods ? 'goods_eu' : 'services_eu';
  return goods ? 'non_eu_goods' : 'services_non_eu';
}

const DAP_ROW_FOR_KIND: Record<A2Kind, 3 | 5 | 12> = { goods_eu: 3, services_eu: 5, services_non_eu: 12 };

function excludedDoc(inv: InSupplierInvoice, reason: ExcludedReason, reasonLabel: string, fx?: FxRate | null): VatExcludedDoc {
  const toCzk = (m: number) => (inv.currency === 'CZK' ? m : fx ? fxToHal(m, fx.rateMilli, fx.unit) : m);
  return {
    id: inv.id, supplier: inv.supplierName, documentNumber: inv.invoiceNumber, date: inv.date,
    totalHal: toCzk(inv.amountMinor), vatHal: toCzk(inv.vatMinor), currency: inv.currency, reason, reasonLabel,
  };
}

// ─── The month ───────────────────────────────────────────────────────────────

export function computeVatMonth(input: VatEngineInput, prebuilt?: RevenueBuild): VatMonthResult {
  const { month, settings } = input;
  const cfg = settings.config;
  const mStart = monthStart(month);
  const mEnd = monthEnd(month);
  const live = !!cfg.payerFrom && cfg.payerFrom <= mEnd;
  const periodStart = live && cfg.payerFrom! > mStart ? cfg.payerFrom! : mStart;
  const inPeriod = (d: string) => d >= periodStart && d <= mEnd;
  const bag = new FlagBag();

  if (!live) {
    bag.add('SIMULATION', 'info', 'Simulation — the company is not a VAT payer for this month',
      cfg.payerFrom
        ? `VAT registration is set from ${cfg.payerFrom}. Nothing for this month is filed.`
        : 'Set the VAT registration date in the VAT settings once it is known. Until then every month is a what-if.');
  } else if (periodStart !== mStart) {
    bag.add('PARTIAL_PERIOD', 'warning', `First VAT period: ${periodStart} – ${mEnd}`,
      'Only sales and purchases from the registration date are counted. OTA settlements cover the whole month — split them by stay date.');
  }

  // ── Revenue
  const rev = prebuilt ?? buildRevenue(input);
  const lines = rev.items.filter((i) => inPeriod(i.taxPoint)).sort((a, b) => a.taxPoint.localeCompare(b.taxPoint) || a.id.localeCompare(b.id));
  for (const f of rev.flags) if (inPeriod(f.date)) bag.add(f.code, f.severity, f.title, f.detail, f.item);
  const a5 = emptyTotals();
  for (const l of lines) addToTotals(a5, l.ratePct, l.baseHal, l.vatHal);

  if (live && periodStart !== mStart) {
    for (const l of lines) {
      if (l.source === 'booking' || l.source === 'airbnb' || l.source === 'ota_other') {
        bag.add('SETTLEMENT_PARTIAL_PERIOD', 'error', 'OTA settlement crosses the registration date',
          'The settlement is counted in full. Only stays from the registration date are taxable — enter the split before filing.',
          { label: l.label, amountHal: l.grossHal });
      }
    }
  }

  // Missing settlements (closed months only)
  const todayMonth = input.today.slice(0, 7);
  for (const src of ['booking', 'airbnb'] as const) {
    const hasThis = input.settlements.some((s) => s.source === src && s.periodStart?.slice(0, 7) === month);
    const recent = [prevMonth(month), prevMonth(prevMonth(month)), prevMonth(prevMonth(prevMonth(month)))];
    const hadBefore = input.settlements.some((s) => s.source === src && recent.includes(s.periodStart?.slice(0, 7) ?? ''));
    if (!hasThis && hadBefore) {
      const name = src === 'booking' ? 'Booking.com' : 'Airbnb';
      if (month < todayMonth) {
        bag.add('SETTLEMENT_MISSING', src === 'booking' ? 'error' : 'warning', 'OTA settlement report not imported',
          'Revenue and commission for this channel are missing — import the report in Revenue → OTA settlements.',
          { label: `${name} ${month}` });
      } else {
        bag.add('MONTH_OPEN', 'info', 'Month not closed yet', 'OTA settlement reports arrive after the month ends.', { label: `${name} ${month}` });
      }
    }
  }

  // ── A.2 from OTA settlements (commission = service from an EU supplier)
  const a2: VatA2Row[] = [];
  for (const s of input.settlements) {
    if (!s.periodStart || s.periodStart.slice(0, 7) !== month) continue;
    if (s.source !== 'booking' && s.source !== 'airbnb') {
      if (s.commissionHal) {
        bag.add('OTA_OTHER_COMMISSION', 'warning', 'Settlement from another channel — its commission is not in A.2',
          'Only Booking.com and Airbnb are known. Record this channel’s fee invoice as a supplier invoice with its VAT ID.',
          { label: s.name, amountHal: s.commissionHal });
      }
      continue;
    }
    const id = OTA_IDENTITY[s.source];
    const docs = settings.otaDocuments?.[s.id] ?? [];
    const commission = s.commissionHal ?? 0;
    let expectedNet = commission;
    let chargedVat = 0;
    if (s.source === 'airbnb' && s.grossHal && commission > 0) {
      const ratio = commission / s.grossHal;
      if (AIRBNB_VAT_INCLUDED_RATIOS.some((r) => Math.abs(ratio - r) <= AIRBNB_RATIO_TOLERANCE)) {
        expectedNet = roundDiv(commission * 100, 100 + RATE_STANDARD);
        chargedVat = commission - expectedNet;
        bag.add('FOREIGN_VAT_CHARGED', 'warning', 'Foreign suppliers charge us VAT — not deductible',
          'They treat us as a consumer because they don’t have our VAT number. Add the company VAT number in each account; from then on the reverse charge applies and nets to zero.',
          { label: `Airbnb host fee ${s.name}: ${(ratio * 100).toFixed(2)} % of gross = fee + 21 % VAT`, amountHal: chargedVat });
      }
    }
    if (docs.length > 0) {
      let sum = 0;
      for (const d of docs) {
        sum += d.amountHal;
        a2.push({ id: `otadoc:${s.id}:${d.number}`, supplier: id.name, countryCode: id.countryCode, vatId: id.vatId,
          documentNumber: d.number, dppd: d.date, currency: 'CZK', originalMinor: d.amountHal, fxRate: null, fxUnit: 1, fxFixingDate: null,
          baseHal: d.amountHal, vatHal: vatOnBase(d.amountHal, RATE_STANDARD), kind: 'services_eu', dapRow: 5, source: 'ota_document',
          foreignVatChargedHal: 0, settlementGroupId: s.id, settlementExpectedHal: expectedNet });
        if (d.date.slice(0, 7) !== month) {
          bag.add('OTA_DOC_DATE', 'warning', 'OTA tax document dated outside the month',
            'The KH row uses this date as DPPD. Check that it is the date of supply (usually the last day of the period).',
            { label: `${id.name} ${d.number}`, date: d.date });
        }
      }
      if (sum !== expectedNet) {
        bag.add('OTA_DOC_DIFF', 'info', 'OTA tax documents differ from the settlement report',
          'Normal for Booking.com (invoice by departure vs payout batches). The VAT return uses the documents.',
          { label: `${s.name}: documents ${fmt(sum)} vs report ${fmt(expectedNet)}`, amountHal: sum - expectedNet });
      }
    } else if (commission !== 0) {
      a2.push({ id: `otastl:${s.id}`, supplier: id.name, countryCode: id.countryCode, vatId: id.vatId,
        documentNumber: null, dppd: s.periodEnd ?? mEnd, currency: 'CZK', originalMinor: expectedNet, fxRate: null, fxUnit: 1, fxFixingDate: null,
        baseHal: expectedNet, vatHal: vatOnBase(expectedNet, RATE_STANDARD), kind: 'services_eu', dapRow: 5, source: 'ota_settlement',
        foreignVatChargedHal: chargedVat, settlementGroupId: s.id, settlementExpectedHal: expectedNet,
        note: s.source === 'booking' ? 'Commission + payment-services fee from the payout statement' : 'Host service fee from the earnings report' });
      bag.add('OTA_DOC_MISSING', live ? 'warning' : 'info', 'OTA invoice number not entered — using the settlement report',
        'The KH row needs the OTA’s own document (Booking commission invoice / Airbnb VAT invoices). Enter its number, date and amount in the A.2 table.',
        { label: s.name, amountHal: expectedNet, decisionKey: `otadoc:${s.id}` });
    }
  }

  // ── Supplier documents
  const b2: VatPurchaseDoc[] = [];
  const b3docs: VatPurchaseDoc[] = [];
  const excluded: VatExcludedDoc[] = [];
  let noVatCount = 0;
  let noVatTotal = 0;

  // Duplicates across the whole ledger
  const dupKey = (i: InSupplierInvoice) =>
    `${normalizeTaxId(i.supplierIco) || i.supplierName.trim().toLowerCase()}|${i.invoiceNumber.replace(/[^0-9a-z]/gi, '').toLowerCase()}|${i.creditNote ? 'cn' : 'inv'}`;
  // The canonical record of a duplicate group is the earliest-dated one (then lowest id), across ALL
  // months — so a copy recorded in another month is never deducted a second time.
  const canonical = new Map<string, InSupplierInvoice>();
  const dupCount = new Map<string, number>();
  for (const i of input.supplierInvoices) {
    if (!i.invoiceNumber.trim()) continue;
    const k = dupKey(i);
    dupCount.set(k, (dupCount.get(k) ?? 0) + 1);
    const cur = canonical.get(k);
    if (!cur || i.date < cur.date || (i.date === cur.date && i.id < cur.id)) canonical.set(k, i);
  }

  // Currencies each supplier invoices in — a CZK record from a supplier that otherwise bills in EUR is
  // almost always a missing currency (the amount would be off by ~24×).
  const supplierKey = (i: InSupplierInvoice) => normalizeTaxId(i.supplierIco) || i.supplierName.trim().toLowerCase();
  const foreignCurrencies = new Map<string, Set<string>>();
  for (const i of input.supplierInvoices) {
    if (i.currency === 'CZK') continue;
    const set = foreignCurrencies.get(supplierKey(i)) ?? new Set<string>();
    set.add(i.currency);
    foreignCurrencies.set(supplierKey(i), set);
    const byName = i.supplierName.trim().toLowerCase();
    const setByName = foreignCurrencies.get(byName) ?? new Set<string>();
    setByName.add(i.currency);
    foreignCurrencies.set(byName, setByName);
  }

  for (const inv of input.supplierInvoices) {
    if (!inPeriod(inv.date)) continue;
    const c = classifySupplier({ supplierName: inv.supplierName, supplierIco: inv.supplierIco, currency: inv.currency, settlementGroupId: inv.settlementGroupId });
    const vatBearing = inv.vatMinor !== 0 || (inv.breakdown ?? []).some((r) => r.vatMinor !== 0);

    if (inv.currency === 'CZK') {
      const others = foreignCurrencies.get(supplierKey(inv)) ?? foreignCurrencies.get(inv.supplierName.trim().toLowerCase());
      // A CZK record carrying exactly 21 % / 12 % Czech VAT is a genuine CZK invoice (e.g. an OSS seller)
      const czechVatConsistent = inv.vatMinor !== 0 &&
        [RATE_STANDARD, RATE_REDUCED].some((rate) => Math.abs(vatOnBase(inv.amountMinor - inv.vatMinor, rate) - inv.vatMinor) <= 100);
      if (others && others.size > 0 && !czechVatConsistent) {
        bag.add('CURRENCY_SUSPECT', 'warning', 'Currency probably missing on a supplier invoice',
          'This supplier’s other invoices are in a foreign currency, but this one is stored as CZK — the amount may be off by the exchange rate. Fix the currency in Costs.',
          { label: `${inv.supplierName} · ${inv.invoiceNumber}: ${formatHal(inv.amountMinor)} CZK (usually ${[...others].join('/')})`, date: inv.date });
      }
    }

    const k = dupKey(inv);
    if ((dupCount.get(k) ?? 0) > 1 && c.cls !== 'ota_settlement') {
      const keep = canonical.get(k);
      bag.add('DUPLICATE_INVOICE', 'error', 'Same supplier invoice recorded more than once',
        'Only the earliest record is counted. Delete the duplicate in Costs.',
        { label: `${inv.supplierName} · ${inv.invoiceNumber}${keep && keep.id !== inv.id ? ' (copy — not counted)' : ' (counted)'}`,
          amountHal: inv.currency === 'CZK' ? inv.amountMinor : undefined, date: inv.date });
      if (keep && keep.id !== inv.id) {
        excluded.push(excludedDoc(inv, 'duplicate', 'Duplicate of another record — counted once'));
        continue;
      }
    }
    if (inv.status === 'review_needed') {
      bag.add('REVIEW_NEEDED', 'warning', 'Supplier invoice still marked “review needed”', undefined,
        { label: `${inv.supplierName} · ${inv.invoiceNumber}`, date: inv.date });
    }

    switch (c.cls) {
      case 'ota_settlement':
        continue; // handled from the settlement
      case 'ota_legacy':
        excluded.push(excludedDoc(inv, 'legacy_ota', 'OTA invoice not linked to a settlement'));
        bag.add('LEGACY_OTA_INVOICE', 'error', 'Booking.com / Airbnb invoice stored as a cost',
          'OTA commission comes from the settlement report. This record would count it twice — remove it or link it to the settlement.',
          { label: `${inv.supplierName} · ${inv.invoiceNumber}`, date: inv.date });
        continue;
      case 'marketplace':
        excluded.push(excludedDoc(inv, 'marketplace', 'Marketplace import VAT (IOSS) — not deductible'));
        if (vatBearing) {
          bag.add('MARKETPLACE_VAT', 'info', 'Marketplace purchases — their VAT is not deductible',
            'Temu & co. collect import VAT themselves. Buy business items from suppliers that issue proper invoices.',
            { label: `${inv.supplierName} · ${inv.invoiceNumber}`, amountHal: inv.vatMinor, date: inv.date });
        }
        continue;
      case 'foreign': {
        const net = inv.amountMinor - inv.vatMinor;
        const kind = a2KindFor(c.eu, inv.category);
        let fx: FxRate | null = null;
        if (inv.currency !== 'CZK') {
          fx = input.fx(inv.currency, inv.date);
          if (!fx) {
            excluded.push(excludedDoc(inv, 'fx_missing', `No ČNB rate for ${inv.currency} on ${inv.date}`));
            bag.add('FX_MISSING', 'error', 'Exchange rate missing — foreign invoice left out',
              'The ČNB rate for the date could not be loaded. Retry later; the invoice is not in the totals until then.',
              { label: `${inv.supplierName} · ${inv.invoiceNumber} (${inv.currency})`, date: inv.date });
            continue;
          }
        }
        if (kind === 'non_eu_goods') {
          excluded.push(excludedDoc(inv, 'non_eu_goods', 'Goods from outside the EU — import VAT is paid at customs', fx));
          bag.add('NON_EU_GOODS', 'warning', 'Goods bought from outside the EU',
            'Import VAT is assessed by customs (not reverse charge). Deduct it only from the customs declaration (JSD).',
            { label: `${inv.supplierName} · ${inv.invoiceNumber}`, date: inv.date });
          continue;
        }
        const base = fx ? fxToHal(net, fx.rateMilli, fx.unit) : net;
        const charged = fx ? fxToHal(inv.vatMinor, fx.rateMilli, fx.unit) : inv.vatMinor;
        a2.push({ id: `sup:${inv.id}`, supplier: inv.supplierName, countryCode: c.eu ? c.countryCode : null, vatId: c.eu ? c.vatId : null,
          documentNumber: inv.invoiceNumber || null, dppd: inv.date, currency: inv.currency, originalMinor: net,
          fxRate: fx ? fx.rateMilli / 1000 : null, fxUnit: fx?.unit ?? 1, fxFixingDate: fx?.fixingDate ?? null,
          baseHal: base, vatHal: vatOnBase(base, RATE_STANDARD), kind, dapRow: DAP_ROW_FOR_KIND[kind], source: 'supplier_invoice',
          foreignVatChargedHal: charged, supplierInvoiceId: inv.id });
        if (inv.vatMinor !== 0) {
          bag.add('FOREIGN_VAT_CHARGED', 'warning', 'Foreign suppliers charge us VAT — not deductible',
            'They treat us as a consumer because they don’t have our VAT number. Add the company VAT number in each account; from then on the reverse charge applies and nets to zero.',
            { label: `${inv.supplierName} · ${inv.invoiceNumber}`, amountHal: charged, date: inv.date });
        }
        if (c.eu && !c.vatId) {
          bag.add('MISSING_VAT_ID', 'warning', 'EU supplier without a VAT number',
            'A.2 needs the supplier’s VAT ID. Add it to the invoice record.', { label: `${inv.supplierName} · ${inv.invoiceNumber}`, date: inv.date });
        } else if (!c.eu && c.idSource === 'none') {
          bag.add('FOREIGN_UNIDENTIFIED', 'warning', 'Foreign supplier with no EU VAT ID — reported as non-EU (row 12)',
            'If it is an EU business, add its VAT ID so it moves to row 5 / 3.', { label: `${inv.supplierName} · ${inv.invoiceNumber}`, date: inv.date });
        }
        if (kind === 'goods_eu' && inv.vatMinor !== 0) {
          bag.add('EU_GOODS_WITH_VAT', 'info', 'EU e-shop charged Czech VAT',
            'Order with a business account and the company VAT number — the purchase then becomes an EU acquisition (row 3) and the VAT nets to zero.',
            { label: `${inv.supplierName} · ${inv.invoiceNumber}`, date: inv.date });
        }
        continue;
      }
      case 'domestic':
      case 'unknown': {
        if (!vatBearing) {
          excluded.push(excludedDoc(inv, 'no_vat', 'No VAT on the invoice (supplier is not a VAT payer)'));
          noVatCount++;
          noVatTotal += inv.amountMinor;
          continue;
        }
        if (inv.currency !== 'CZK') {
          excluded.push(excludedDoc(inv, 'unknown_supplier', 'Czech VAT in a foreign currency — check the invoice'));
          bag.add('UNKNOWN_SUPPLIER', 'error', 'Supplier could not be classified', 'Check the supplier’s IČO / VAT ID and currency.',
            { label: `${inv.supplierName} · ${inv.invoiceNumber}`, date: inv.date });
          continue;
        }
        // Rate split
        let base21 = 0, vat21 = 0, base12 = 0, vat12 = 0;
        let derived = false;
        const rows = (inv.breakdown ?? []).filter((r) => r.baseMinor !== 0 || r.vatMinor !== 0);
        if (rows.length > 0) {
          let bad = false;
          for (const r of rows) {
            if (r.rate === RATE_STANDARD) { base21 += r.baseMinor; vat21 += r.vatMinor; }
            else if (r.rate === RATE_REDUCED) { base12 += r.baseMinor; vat12 += r.vatMinor; }
            else if (r.rate === 0) { /* out-of-scope items (deposits, recycling fees) */ }
            else {
              bad = true;
              bag.add('UNSUPPORTED_RATE', 'error', 'VAT rate that is no longer valid', 'Only 21 % and 12 % exist since 2024. Fix the VAT rows on the invoice.',
                { label: `${inv.supplierName} · ${inv.invoiceNumber}: ${r.rate} %`, date: inv.date });
            }
            if ((r.rate === RATE_STANDARD || r.rate === RATE_REDUCED) && Math.abs(vatOnBase(r.baseMinor, r.rate) - r.vatMinor) > 100) {
              bad = true;
              bag.add('BREAKDOWN_MISMATCH', 'error', 'VAT rows don’t add up', 'Fix the VAT rows on the invoice (Costs → invoice → VAT).',
                { label: `${inv.supplierName} · ${inv.invoiceNumber}: ${r.rate} % of ${fmt(r.baseMinor)} ≠ ${fmt(r.vatMinor)}`, date: inv.date });
            }
          }
          const sumVat = rows.reduce((s, r) => s + r.vatMinor, 0);
          const sumAll = rows.reduce((s, r) => s + r.baseMinor + r.vatMinor, 0);
          if (Math.abs(sumVat - inv.vatMinor) > 2 || Math.abs(sumAll - inv.amountMinor) > 100) {
            bad = true;
            bag.add('BREAKDOWN_MISMATCH', 'error', 'VAT rows don’t add up', 'Fix the VAT rows on the invoice (Costs → invoice → VAT).',
              { label: `${inv.supplierName} · ${inv.invoiceNumber}: rows ${fmt(sumAll)} / VAT ${fmt(sumVat)} vs invoice ${fmt(inv.amountMinor)} / VAT ${fmt(inv.vatMinor)}`, date: inv.date });
          }
          if (bad) {
            excluded.push(excludedDoc(inv, 'split_missing', 'VAT rows inconsistent — fix before filing'));
            continue;
          }
        } else {
          const base = inv.amountMinor - inv.vatMinor;
          if (Math.abs(vatOnBase(base, RATE_STANDARD) - inv.vatMinor) <= 100) { base21 = base; vat21 = inv.vatMinor; }
          else if (Math.abs(vatOnBase(base, RATE_REDUCED) - inv.vatMinor) <= 100) { base12 = base; vat12 = inv.vatMinor; }
          else {
            excluded.push(excludedDoc(inv, 'split_missing', 'Mixed VAT rates and no saved split'));
            bag.add('NO_BREAKDOWN', 'error', 'VAT split per rate missing',
              'The invoice mixes rates and has no saved VAT rows. Use “Fill VAT rates” in Costs.',
              { label: `${inv.supplierName} · ${inv.invoiceNumber}`, amountHal: inv.vatMinor, date: inv.date });
            continue;
          }
          derived = true;
          bag.add('SPLIT_DERIVED', 'info', 'VAT rate derived from the invoice totals (no saved VAT rows)', undefined,
            { label: `${inv.supplierName} · ${inv.invoiceNumber}`, date: inv.date });
        }

        const section: 'B.2' | 'B.3' = Math.abs(inv.amountMinor) > KH_DETAIL_LIMIT_HAL ? 'B.2' : 'B.3';
        const ico = c.cls === 'domestic' ? c.ico : null;
        const doc: VatPurchaseDoc = { id: inv.id, supplier: inv.supplierName, ico, documentNumber: inv.invoiceNumber, date: inv.date,
          category: inv.category, totalHal: inv.amountMinor, base21Hal: base21, vat21Hal: vat21, base12Hal: base12, vat12Hal: vat12,
          creditNote: inv.creditNote, section, splitDerived: derived };
        (section === 'B.2' ? b2 : b3docs).push(doc);

        if (c.cls === 'unknown') {
          bag.add(section === 'B.2' ? 'B2_WITHOUT_DIC' : 'SUPPLIER_ID_MISSING', section === 'B.2' ? 'error' : 'info',
            section === 'B.2' ? 'Invoice over 10 000 Kč without the supplier’s IČO / DIČ' : 'Small invoice without the supplier’s IČO',
            section === 'B.2' ? 'B.2 rows are matched by the supplier’s DIČ — add it to the invoice.' : 'Fine for the B.3 total, but add the IČO when you can.',
            { label: `${inv.supplierName} · ${inv.invoiceNumber}`, amountHal: inv.amountMinor, date: inv.date });
        } else if (section === 'B.2' && !CZ_LEGAL_FORM_RE.test(inv.supplierName)) {
          bag.add('NATURAL_PERSON_DIC', 'warning', 'B.2 supplier looks like a natural person — check the DIČ',
            'A self-employed person’s DIČ is usually not CZ + IČO. B.2 rows are paired by DIČ, so use the one printed on the invoice.',
            { label: `${inv.supplierName} · ${inv.invoiceNumber} (IČO ${ico ?? '—'})`, amountHal: inv.amountMinor, date: inv.date });
        }
        if (base12 !== 0 && base21 === 0 && UNUSUAL_REDUCED_RATE_CATEGORIES.has(inv.category)) {
          bag.add('UNUSUAL_RATE', 'warning', '12 % VAT on an invoice where 21 % is usual',
            'Check the invoice. If it is construction or installation work, from registration it is invoiced without VAT (domestic reverse charge, B.1).',
            { label: `${inv.supplierName} · ${inv.invoiceNumber} (${inv.category})`, amountHal: inv.amountMinor, date: inv.date });
        }
        continue;
      }
    }
  }
  if (noVatCount > 0) {
    bag.add('NO_VAT_SUPPLIERS', 'info', 'Invoices without VAT (non-payers) — not part of the VAT return',
      `${noVatCount} document(s), ${fmt(noVatTotal)} in total (cleaners, private landlords…).`);
  }

  // Unpaid supplier invoices → deduction reversal (§ 74b)
  const reversalMonths = unpaidReversalMonths(mEnd);
  for (const inv of input.supplierInvoices) {
    if (inv.paid || inv.creditNote || !inv.dueDate || inv.currency !== 'CZK') continue;
    const vatBearing = inv.vatMinor !== 0 || (inv.breakdown ?? []).some((r) => r.vatMinor !== 0);
    if (!vatBearing) continue;
    const c = classifySupplier({ supplierName: inv.supplierName, supplierIco: inv.supplierIco, currency: inv.currency, settlementGroupId: inv.settlementGroupId });
    if (c.cls !== 'domestic') continue;
    const limit = addMonths(inv.dueDate, reversalMonths);
    if (limit >= mStart && limit <= mEnd) {
      bag.add('UNPAID_74B', live ? 'warning' : 'info', `Supplier invoice unpaid ${reversalMonths} months after due date — deduction must be reversed`,
        'If it is really unpaid, its VAT deduction is reversed in this period (§ 74b). If it was paid (e.g. by card), match the payment in Bank.',
        { label: `${inv.supplierName} · ${inv.invoiceNumber} (due ${inv.dueDate})`, amountHal: inv.vatMinor, date: limit });
    }
  }

  // ── Totals
  const b3 = emptyTotals();
  for (const d of b3docs) { b3.base21Hal += d.base21Hal; b3.vat21Hal += d.vat21Hal; b3.base12Hal += d.base12Hal; b3.vat12Hal += d.vat12Hal; }
  const bAll = { ...b3 };
  for (const d of b2) { bAll.base21Hal += d.base21Hal; bAll.vat21Hal += d.vat21Hal; bAll.base12Hal += d.base12Hal; bAll.vat12Hal += d.vat12Hal; }

  a2.sort((x, y) => x.dppd.localeCompare(y.dppd) || x.supplier.localeCompare(y.supplier));
  b2.sort((x, y) => x.date.localeCompare(y.date));
  b3docs.sort((x, y) => x.date.localeCompare(y.date) || x.supplier.localeCompare(y.supplier));

  const byKind = (k: A2Kind) => a2.filter((r) => r.kind === k).reduce((acc, r) => ({ base: acc.base + r.baseHal, vat: acc.vat + r.vatHal }), { base: 0, vat: 0 });
  const r3 = byKind('goods_eu');
  const r5 = byKind('services_eu');
  const r12 = byKind('services_non_eu');
  const rcBase = r3.base + r5.base + r12.base;
  const rcVat = r3.vat + r5.vat + r12.vat;

  const revenueVat = a5.vat21Hal + a5.vat12Hal;
  const domesticDeduction = bAll.vat21Hal + bAll.vat12Hal;
  const outputVat = revenueVat + rcVat;
  const deduction = domesticDeduction + rcVat;
  const foreignVatCharged = a2.reduce((s, r) => s + r.foreignVatChargedHal, 0);

  // ── VAT return rows (whole Kč; totals from the rounded rows, as the form does)
  const W = toWholeCzk;
  const row = (r: string, label: string, base: number | null, tax: number | null): VatDapRow => ({ row: r, label, baseCzk: base, taxCzk: tax });
  const d1 = { b: W(a5.base21Hal), t: W(a5.vat21Hal) };
  const d2 = { b: W(a5.base12Hal), t: W(a5.vat12Hal) };
  const d3 = { b: W(r3.base), t: W(r3.vat) };
  const d5 = { b: W(r5.base), t: W(r5.vat) };
  const d12 = { b: W(r12.base), t: W(r12.vat) };
  const d40 = { b: W(bAll.base21Hal), t: W(bAll.vat21Hal) };
  const d41 = { b: W(bAll.base12Hal), t: W(bAll.vat12Hal) };
  const d43 = { b: d3.b + d5.b + d12.b, t: d3.t + d5.t + d12.t };
  const r46 = d40.t + d41.t + d43.t;
  const r62 = d1.t + d2.t + d3.t + d5.t + d12.t;
  const r63 = r46;
  const payableCzk = Math.max(0, r62 - r63);
  const refundCzk = Math.max(0, r63 - r62);
  const dapRows: VatDapRow[] = [
    row('1', 'Sales at 21 %', d1.b, d1.t),
    row('2', 'Sales at 12 % (accommodation)', d2.b, d2.t),
    row('3', 'Goods bought from EU sellers (21 %)', d3.b, d3.t),
    row('5', 'Services from EU suppliers (21 %)', d5.b, d5.t),
    row('12', 'Other self-assessed supplies — non-EU suppliers (21 %)', d12.b, d12.t),
    row('40', 'Deduction — Czech purchases at 21 %', d40.b, d40.t),
    row('41', 'Deduction — Czech purchases at 12 %', d41.b, d41.t),
    row('43', 'Deduction — self-assessed VAT from rows 3–13', d43.b, d43.t),
    row('46', 'Total deductions', null, r46),
    row('62', 'Output VAT', null, r62),
    row('63', 'Deductions', null, r63),
    row(payableCzk > 0 || refundCzk === 0 ? '64' : '65', payableCzk > 0 || refundCzk === 0 ? 'VAT payable (vlastní daň)' : 'Excess deduction (nadměrný odpočet)',
      null, payableCzk > 0 || refundCzk === 0 ? payableCzk : refundCzk),
  ];

  const khC: VatKhC = {
    obrat23: a5.base21Hal, obrat5: a5.base12Hal, pln23: bAll.base21Hal, pln5: bAll.base12Hal,
    rezPren23: 0, rezPren5: 0, plnRezPren: 0, celkZdA2: rcBase,
  };
  // Guard: KH section C must agree with the return (±1 Kč here; the office tolerates ±1 000 Kč)
  const checks: Array<[string, Hal, number]> = [
    ['obrat23 ↔ row 1', khC.obrat23, d1.b], ['obrat5 ↔ row 2', khC.obrat5, d2.b],
    ['pln23 ↔ row 40', khC.pln23, d40.b], ['pln5 ↔ row 41', khC.pln5, d41.b],
    ['celk_zd_a2 ↔ rows 3–13', khC.celkZdA2, d3.b + d5.b + d12.b],
  ];
  for (const [label, h, czk] of checks) {
    if (Math.abs(W(h) - czk) > 2) {
      bag.add('KH_C_MISMATCH', 'error', 'Control statement section C doesn’t match the VAT return', 'Internal consistency check failed — do not file; report this.',
        { label: `${label}: ${fmt(h)} vs ${czk} Kč` });
    }
  }

  const result: VatMonthResult = {
    month, mode: live ? 'live' : 'simulation', periodStart, periodEnd: mEnd, payerFrom: cfg.payerFrom,
    deadline: filingDeadline(month), daysToDeadline: daysBetween(input.today, filingDeadline(month)),
    revenue: { lines, totals: { ...a5 } },
    a2, a4: [], a5,
    b2, b3: { totals: b3, docs: b3docs },
    excluded: excluded.sort((x, y) => x.date.localeCompare(y.date)),
    dap: {
      rows: dapRows,
      values: {
        r1b: d1.b, r1t: d1.t, r2b: d2.b, r2t: d2.t, r3b: d3.b, r3t: d3.t, r5b: d5.b, r5t: d5.t, r12b: d12.b, r12t: d12.t,
        r40b: d40.b, r40t: d40.t, r41b: d41.b, r41t: d41.t, r43b: d43.b, r43t: d43.t,
        r46, r62, r63, r64: payableCzk, r65: refundCzk,
      },
      outputTaxCzk: r62, deductionCzk: r63, payableCzk, refundCzk,
    },
    khC,
    totals: {
      revenueVatHal: revenueVat, reverseChargeVatHal: rcVat, outputVatHal: outputVat,
      domesticDeductionHal: domesticDeduction, reverseChargeDeductionHal: rcVat, deductionHal: deduction,
      payableHal: outputVat - deduction, foreignVatChargedHal: foreignVatCharged,
      grossRevenueHal: lines.reduce((s, l) => s + l.grossHal, 0),
    },
    flags: [],
    generatedAt: new Date(0).toISOString(), // set by the caller (engine is clock-free)
  };

  for (const issue of khXmlIssues(result, cfg)) bag.add('XML_FIELD', 'error', 'A value does not fit the official XML format', issue.detail, { label: issue.label });
  result.flags = bag.list();
  return result;
}

function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const total = (m - 1) + months;
  const ny = y + Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

// ─── Year view ───────────────────────────────────────────────────────────────

/** Calendar-year turnover (gross sales, all channels) vs the registration thresholds. */
export function computeThreshold(rev: RevenueBuild, year: number): VatThreshold {
  const points = [];
  let cumulative = 0;
  let crossedStandard: string | null = null;
  let crossedImmediate: string | null = null;
  for (let m = 1; m <= 12; m++) {
    const month = `${year}-${String(m).padStart(2, '0')}`;
    const gross = rev.items.filter((i) => i.taxPoint.slice(0, 7) === month).reduce((s, i) => s + i.grossHal, 0);
    const before = cumulative;
    cumulative += gross;
    if (!crossedStandard && before <= THRESHOLD_STANDARD_HAL && cumulative > THRESHOLD_STANDARD_HAL) crossedStandard = month;
    if (!crossedImmediate && before <= THRESHOLD_IMMEDIATE_HAL && cumulative > THRESHOLD_IMMEDIATE_HAL) crossedImmediate = month;
    points.push({ month, grossHal: gross, cumulativeHal: cumulative });
  }
  return { year, points, crossedStandard, crossedImmediate, standardLimitHal: THRESHOLD_STANDARD_HAL, immediateLimitHal: THRESHOLD_IMMEDIATE_HAL };
}

/** Flags for the registration thresholds, shown on every month of the year. */
export function thresholdFlags(t: VatThreshold, payerFrom: string | null): VatFlag[] {
  const flags: VatFlag[] = [];
  if (t.crossedImmediate && (!payerFrom || payerFrom > monthEnd(t.crossedImmediate))) {
    flags.push({ code: 'THRESHOLD_IMMEDIATE', severity: 'error',
      title: `Turnover passed 2 536 500 Kč in ${t.crossedImmediate} — VAT payer from the next day`,
      detail: 'By law the company became a VAT payer the day after the turnover was exceeded, and had 10 working days to file the registration. Talk to the tax adviser and set the registration date in the VAT settings.' });
  } else if (t.crossedStandard && !payerFrom) {
    flags.push({ code: 'THRESHOLD_STANDARD', severity: 'warning',
      title: `Turnover passed 2 000 000 Kč in ${t.crossedStandard} — VAT payer from 1 January ${t.year + 1}`,
      detail: 'The registration application is due within 10 working days of exceeding the threshold.' });
  }
  return flags;
}

export function overviewMonth(r: VatMonthResult): VatOverviewMonth {
  return {
    month: r.month, mode: r.mode, grossRevenueHal: r.totals.grossRevenueHal, outputVatHal: r.totals.outputVatHal,
    deductionHal: r.totals.deductionHal, payableHal: r.totals.payableHal,
    errors: r.flags.filter((f) => f.severity === 'error').length,
    warnings: r.flags.filter((f) => f.severity === 'warning').length,
    deadline: r.deadline,
  };
}

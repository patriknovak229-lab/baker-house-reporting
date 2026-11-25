/**
 * SERVER ONLY. Corporate invoices: what an invoice bills, issuing (number +
 * frozen snapshot + revenue record) and payment state. Rendering, emailing and
 * the cron step live in utils/corporateInvoiceSend.ts — they pull in headless
 * Chromium, which the preview and the Transactions payment check must not.
 *
 * WHERE THE NUMBERS COME FROM
 * ---------------------------
 * A stay's dates and price are agreed in the agreement, but once the booking
 * exists Beds24 is the truth (price/date edits happen there — same rule as
 * shorten-stay, see docs/corporate.md). So lines are built from our stay rows
 * OVERLAID with the live Beds24 booking: its dates and price when it differs,
 * and a booking cancelled in Beds24 is left off. Every difference is reported
 * as a note so the operator sees it in the preview.
 *
 * When Beds24 can't be read (local dev has no token, or an outage) the manual
 * path still works from our stay rows and says so; the CRON refuses to issue
 * unverified invoices and alerts instead — nobody is watching when it runs.
 *
 * Only CREATED stays are billed. A planned/failed stay inside the range is a
 * night the company expects but that isn't booked: the preview warns, and the
 * cron holds that invoice until the operator creates or skips the stay.
 */
import type { Reservation } from '@/types/reservation';
import type { RevenueInvoice } from '@/types/revenueInvoice';
import { buildReservationSet } from '@/utils/beds24Reservations';
import { getAgreementDetail } from '@/data-access/corporate';
import {
  getInvoice,
  numberAndFreezeInvoice,
  updateInvoice,
  amountToDb,
} from '@/data-access/corporateInvoices';
import { readAllRevenueInvoices, writeAllRevenueInvoices } from '@/utils/revenueInvoicesStore';
import {
  buildInvoiceLines,
  missingBillingDetails,
  monthLabel,
  type CorporateBillTo,
  type CorporateInvoice,
  type InvoicePreview,
  type InvoiceSourceStay,
} from '@/utils/corporateInvoice';
import { addDays, nightsBetween } from '@/utils/corporateSchedule';
import { formatStayDate, type AgreementDetail, type CorporateStay } from '@/utils/corporateShared';
import { offerDate } from '@/utils/corporateOfferHtml';

// ─── Beds24 overlay ──────────────────────────────────────────────────────────

/** All reservations by number, or null when Beds24 can't be read. */
export async function loadReservationsByNumber(): Promise<Map<string, Reservation> | null> {
  try {
    const all = await buildReservationSet();
    const map = new Map<string, Reservation>();
    // Active first, so a cancelled duplicate never shadows the live booking.
    for (const r of all) if (!map.has(r.reservationNumber) || (map.get(r.reservationNumber)?.isCancelled && !r.isCancelled)) map.set(r.reservationNumber, r);
    return map;
  } catch (err) {
    console.error('[corporate-invoice] Beds24 reservations unavailable:', err instanceof Error ? err.message : err);
    return null;
  }
}


function joinGuestNameServer(first: string | null, last: string | null): string {
  return [first, last].map((x) => (x ?? '').trim()).filter(Boolean).join(' ');
}

function stayGuestName(stay: CorporateStay, agreement: AgreementDetail): string {
  return (
    joinGuestNameServer(stay.guestFirstName, stay.guestLastName) ||
    joinGuestNameServer(agreement.guestFirstName, agreement.guestLastName)
  );
}

/** What an invoice over `periodFrom` … `periodTo` (inclusive nights) would bill right now. */
export function previewFromData(
  agreement: AgreementDetail,
  periodFrom: string,
  periodTo: string,
  reservations: Map<string, Reservation> | null,
): InvoicePreview {
  const notes: string[] = [];
  const sources: InvoiceSourceStay[] = [];
  const rangeEnd = addDays(periodTo, 1);
  const inRange = (arrival: string, departure: string) => arrival < rangeEnd && departure > periodFrom;

  const pending = agreement.stays
    .filter((s) => (s.status === 'planned' || s.status === 'failed') && inRange(s.arrival, s.departure))
    .map((s) => ({ seq: s.seq, arrival: s.arrival, departure: s.departure, status: s.status }));

  for (const stay of agreement.stays) {
    if (stay.status !== 'created') continue;
    const label = `Stay ${stay.seq}${stay.reservationNumber ? ` (${stay.reservationNumber})` : ''}`;
    let arrival = stay.arrival;
    let departure = stay.departure;
    let price = stay.priceCzk ?? 0;
    let guestName = stayGuestName(stay, agreement);
    let source: InvoiceSourceStay['source'] = 'agreement';

    const res = reservations && stay.reservationNumber ? reservations.get(stay.reservationNumber) : undefined;
    if (reservations && stay.reservationNumber && !res) {
      if (inRange(arrival, departure)) notes.push(`${label}: not found in Beds24 — billed from the agreement.`);
    } else if (res) {
      if (res.isCancelled) {
        if (inRange(arrival, departure)) notes.push(`${label}: cancelled in Beds24 — left off the invoice.`);
        continue;
      }
      source = 'beds24';
      if (res.checkInDate !== arrival || res.checkOutDate !== departure) {
        if (inRange(res.checkInDate, res.checkOutDate) || inRange(arrival, departure)) {
          notes.push(
            `${label}: Beds24 dates ${formatStayDate(res.checkInDate)} → ${formatStayDate(res.checkOutDate)} differ from the agreement (${formatStayDate(arrival)} → ${formatStayDate(departure)}) — billing Beds24's.`,
          );
        }
        arrival = res.checkInDate;
        departure = res.checkOutDate;
      }
      if (Math.round(res.price) !== Math.round(price)) {
        if (inRange(arrival, departure)) {
          notes.push(`${label}: Beds24 price ${Math.round(res.price).toLocaleString('cs-CZ')} Kč differs from the agreed ${Math.round(price).toLocaleString('cs-CZ')} Kč — billing Beds24's.`);
        }
        price = res.price;
      }
      const resName = `${res.firstName ?? ''} ${res.lastName ?? ''}`.trim();
      // "<Company> TBA" is our own placeholder — never print it as a guest.
      if (resName && !/\bTBA$/i.test(resName)) guestName = resName;
    }
    if (price <= 0 && inRange(arrival, departure)) notes.push(`${label}: no price — billed as 0 Kč.`);
    sources.push({
      stayId: stay.id,
      seq: stay.seq,
      reservationNumber: stay.reservationNumber,
      roomId: stay.roomId,
      guestName,
      arrival,
      departure,
      priceCzk: Math.max(0, price),
      source,
    });
  }

  if (!reservations) notes.unshift('Beds24 could not be read — dates and prices come from the agreement, not the live bookings.');
  const built = buildInvoiceLines(sources, periodFrom, periodTo);
  return { periodFrom, periodTo, ...built, notes, pending, verified: reservations !== null };
}

export type { InvoicePreview };

export async function previewInvoice(
  agreement: AgreementDetail,
  periodFrom: string,
  periodTo: string,
  reservations?: Map<string, Reservation> | null,
): Promise<InvoicePreview> {
  const res = reservations === undefined ? await loadReservationsByNumber() : reservations;
  return previewFromData(agreement, periodFrom, periodTo, res);
}

// ─── Issuing ─────────────────────────────────────────────────────────────────

export function billToFromAgreement(a: AgreementDetail): CorporateBillTo {
  return {
    companyName: a.companyName.trim(),
    companyAddress: (a.companyAddress ?? '').trim(),
    ico: (a.ico ?? '').trim(),
    vatNumber: (a.vatNumber ?? '').trim(),
    billingEmail: (a.billingEmail ?? '').trim(),
  };
}

export class InvoiceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * Number and freeze a scheduled invoice as of `today`. Throws InvoiceError
 * when it can't be issued (nothing to bill, billing details missing, someone
 * else issued it first). The revenue record is written right after; its
 * failure is reported, not thrown — the invoice exists by then.
 */
export async function issueInvoice(
  invoiceId: string,
  opts: { today: string; reservations?: Map<string, Reservation> | null; requireVerified?: boolean; requireBooked?: boolean },
): Promise<{ invoice: CorporateInvoice; preview: InvoicePreview; revenueError: string | null }> {
  const inv = await getInvoice(invoiceId);
  if (!inv) throw new InvoiceError('Invoice not found', 404);
  if (inv.invoiceNumber || inv.status !== 'scheduled') throw new InvoiceError(`Invoice is already ${inv.status}`, 409);

  const agreement = await getAgreementDetail(inv.agreementId);
  if (!agreement) throw new InvoiceError('Agreement not found', 404);
  const missing = missingBillingDetails(agreement);
  if (missing.length > 0) throw new InvoiceError(`Billing details missing: ${missing.join(', ')}`);

  const preview = await previewInvoice(agreement, inv.periodFrom, inv.periodTo, opts.reservations);
  if (opts.requireVerified && !preview.verified) throw new InvoiceError('Beds24 could not be read to verify the stays');
  if (opts.requireBooked && preview.pending.length > 0) {
    throw new InvoiceError(
      `${preview.pending.length} stay(s) in this period are not booked in Beds24 yet (stay ${preview.pending.map((p) => p.seq).join(', ')}) — create or skip them first`,
    );
  }
  if (preview.lines.length === 0 || preview.totalCzk <= 0) throw new InvoiceError('Nothing to invoice in this period — no booked, priced nights');

  const year = Number(opts.today.slice(0, 4));
  const issued = await numberAndFreezeInvoice(inv.id, year, {
    issueDate: opts.today,
    amountCzk: amountToDb(preview.totalCzk),
    lines: preview.lines,
    billTo: billToFromAgreement(agreement),
  });
  if (!issued) throw new InvoiceError('Someone else issued this invoice a moment ago — reload', 409);

  let revenueError: string | null = null;
  try {
    await upsertRevenueRecord(issued);
  } catch (err) {
    revenueError = err instanceof Error ? err.message : String(err);
    console.error(`[corporate-invoice] revenue record for ${issued.invoiceNumber} failed:`, err);
  }
  return { invoice: issued, preview, revenueError };
}

// ─── Revenue record (Accounting → Revenue, bank auto-match) ─────────────────

export const revenueIdFor = (invoiceId: string) => `rev-${invoiceId}`;

export function describePeriod(inv: Pick<CorporateInvoice, 'billedMonth' | 'periodFrom' | 'periodTo'>): string {
  return inv.billedMonth ? monthLabel(inv.billedMonth) : `${offerDate(inv.periodFrom)} – ${offerDate(addDays(inv.periodTo, 1))}`;
}

/**
 * The issued invoice as a revenue record: category accommodation_direct,
 * pending until Accounting's auto-match pairs it with the company's transfer
 * (by the VS = invoice number digits, or the company name + exact amount).
 */
async function upsertRevenueRecord(inv: CorporateInvoice): Promise<void> {
  if (!inv.invoiceNumber || inv.amountCzk === null || !inv.billTo) return;
  const all = await readAllRevenueInvoices();
  const id = revenueIdFor(inv.id);
  const prev = all.find((r) => r.id === id);
  const record: RevenueInvoice = {
    id,
    sourceType: 'issued',
    category: prev?.category ?? 'accommodation_direct',
    status: prev?.status ?? 'pending',
    invoiceNumber: inv.invoiceNumber,
    invoiceDate: inv.issueDate,
    dueDate: inv.dueDate,
    amountCZK: inv.amountCzk,
    clientName: inv.billTo.companyName,
    description: `Corporate ${describePeriod(inv)} · ${inv.agreementId}`,
    bankTransactionId: prev?.bankTransactionId,
    reconciledAt: prev?.reconciledAt,
    driveFileId: prev?.driveFileId,
    driveFileName: prev?.driveFileName,
    driveUrl: prev?.driveUrl,
    createdAt: prev?.createdAt ?? new Date().toISOString(),
  };
  const next = prev ? all.map((r) => (r.id === id ? record : r)) : [...all, record];
  await writeAllRevenueInvoices(next);
}

/** Void → the revenue record becomes a "mistake" (kept, out of the P&L and matching). */
async function markRevenueRecordMistake(inv: CorporateInvoice): Promise<void> {
  const all = await readAllRevenueInvoices();
  const id = revenueIdFor(inv.id);
  if (!all.some((r) => r.id === id)) return;
  await writeAllRevenueInvoices(all.map((r) => (r.id === id ? { ...r, category: 'mistake' as const } : r)));
}

/**
 * Bank matching happens in Accounting, on the revenue record. Carry it over:
 * an issued/sent invoice whose record is reconciled is paid. Returns the
 * invoices with any newly paid ones updated.
 */
export async function syncPaidFromBank(invoices: CorporateInvoice[]): Promise<CorporateInvoice[]> {
  const open = invoices.filter((i) => (i.status === 'issued' || i.status === 'sent') && i.invoiceNumber);
  if (open.length === 0) return invoices;
  let revenue: RevenueInvoice[];
  try {
    revenue = await readAllRevenueInvoices();
  } catch (err) {
    console.error('[corporate-invoice] revenue read for paid sync failed:', err);
    return invoices;
  }
  const byId = new Map(revenue.map((r) => [r.id, r]));
  const updated = new Map<string, CorporateInvoice>();
  for (const inv of open) {
    const rec = byId.get(revenueIdFor(inv.id));
    if (!rec || rec.status !== 'reconciled') continue;
    const paidAt = (rec.reconciledAt ?? new Date().toISOString()).slice(0, 10);
    const next = await updateInvoice(inv.id, { status: 'paid', paidAt, paidSource: 'bank' }).catch(() => null);
    if (next) updated.set(inv.id, next);
  }
  return invoices.map((i) => updated.get(i.id) ?? i);
}

// ─── Payment state ───────────────────────────────────────────────────────────

export async function voidInvoice(invoiceId: string): Promise<CorporateInvoice> {
  const inv = await getInvoice(invoiceId);
  if (!inv) throw new InvoiceError('Invoice not found', 404);
  if (inv.status === 'paid') throw new InvoiceError('A paid invoice cannot be voided — undo "paid" first if that was a mistake');
  if (inv.invoiceNumber) {
    const revenue = (await readAllRevenueInvoices()).find((r) => r.id === revenueIdFor(inv.id));
    if (revenue && (revenue.status === 'reconciled' || revenue.bankTransactionId)) {
      throw new InvoiceError('This invoice is already matched to a bank payment in Accounting — unlink it there first');
    }
    await markRevenueRecordMistake(inv);
  }
  const updated = await updateInvoice(inv.id, { status: 'void' });
  if (!updated) throw new InvoiceError('Invoice not found', 404);
  return updated;
}

/** Nights in the range — for labels. */
export function rangeNights(periodFrom: string, periodTo: string): number {
  return nightsBetween(periodFrom, addDays(periodTo, 1));
}

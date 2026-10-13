/**
 * The invoice step of the New Booking modal — pure rules shared by the modal
 * (to explain what's missing before anything is created) and by
 * POST /api/bookings/initial-invoice (which re-checks the same rules).
 *
 * Three deliveries:
 *   save      → store the billing details on the reservation, issue nothing.
 *               What the drawer's "Save details" does.
 *   now       → store them and email the invoice straight away.
 *   schedule  → store them plus an open "Send invoice" task due on the chosen
 *               date. The 09:00 send-due-invoices cron sends it that morning —
 *               the same pipeline the chat agent's invoice requests use.
 *
 * Scheduling needs an IČO or DIČ because the cron does: it only sends
 * unattended when the customer carries a company identifier (see
 * `invoiceDataComplete` in the cron). Accepting a schedule it would then skip
 * forever is worse than saying so up front.
 */
import type { InvoiceData, Issue } from '@/types/reservation';

export type InvoiceDelivery = 'save' | 'now' | 'schedule';

export const INVOICE_DELIVERIES: InvoiceDelivery[] = ['save', 'now', 'schedule'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RESERVATION_RE = /^BH-(\d+)$/;

export function isValidEmail(s: string | null | undefined): boolean {
  return !!s && EMAIL_RE.test(s.trim());
}

/** Untrusted billing details → every field a trimmed string. */
export function cleanInvoiceData(raw: unknown): InvoiceData {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return {
    companyName: str(r.companyName),
    companyAddress: str(r.companyAddress),
    ico: str(r.ico),
    vatNumber: str(r.vatNumber),
    billingEmail: str(r.billingEmail),
  };
}

export function hasAnyInvoiceData(d: InvoiceData): boolean {
  return Object.values(d).some((v) => v.trim() !== '');
}

/**
 * Why this delivery can't go ahead yet, in the operator's words — or null when
 * it can. `today` is the Prague calendar date (YYYY-MM-DD).
 */
export function invoiceDeliveryProblem(
  d: InvoiceData,
  delivery: InvoiceDelivery,
  sendDate: string | undefined,
  today: string,
): string | null {
  if (delivery === 'save') {
    return hasAnyInvoiceData(d) ? null : 'Fill in at least one invoice field';
  }
  if (!d.companyName.trim()) return 'Invoice: company name is required to send';
  if (!d.billingEmail.trim()) return 'Invoice: billing email is required to send';
  if (!isValidEmail(d.billingEmail)) return 'Invoice: billing email is not a valid address';
  if (delivery === 'schedule') {
    if (!d.ico.trim() && !d.vatNumber.trim()) {
      return 'Invoice: scheduled sending needs an IČO or DIČ (the daily auto-send skips invoices without one) — send it now instead, or add the company ID';
    }
    if (!sendDate || !ISO_DATE_RE.test(sendDate)) return 'Invoice: pick the date to send it';
    if (sendDate <= today) return 'Invoice: the scheduled date must be after today — use "Send now" for today';
  }
  return null;
}

/**
 * The reservation the dashboard files a multi-unit booking under. A package
 * created in one call is merged into one reservation numbered after its LOWEST
 * Beds24 id (mergeGroupedBookings), so the invoice details must live there.
 */
export function canonicalReservationNumber(numbers: unknown): string | null {
  if (!Array.isArray(numbers)) return null;
  let best: { n: string; id: number } | null = null;
  for (const n of numbers) {
    if (typeof n !== 'string') continue;
    const m = n.match(RESERVATION_RE);
    if (!m) continue;
    const id = Number(m[1]);
    if (!best || id < best.id) best = { n, id };
  }
  return best?.n ?? null;
}

/** The open invoice task the cron sends on `sendDate`. */
export function scheduledInvoiceTask(
  d: InvoiceData,
  sendDate: string,
  includeQR: boolean,
  now: Date = new Date(),
): Issue {
  const company = d.companyName.trim();
  const dic = d.vatNumber.trim();
  return {
    id: `scheduled-invoice-${now.getTime()}`,
    category: 'invoice',
    text:
      `Send invoice — ${company}${dic ? ` (DIČ ${dic})` : ''}` +
      ` · scheduled when booked${includeQR ? ', with payment details' : ''}`,
    actionableDate: sendDate,
    resolved: false,
    createdAt: now.toISOString(),
    ...(includeQR ? { includeQR: true } : {}),
  };
}

export interface NewBookingInvoiceRequest {
  /** Where the details are stored — the canonical reservation number. */
  reservationNumber: string;
  /** Every number the booking POST returned (a package has several). */
  reservationNumbers: string[];
  invoiceData: InvoiceData;
  delivery: InvoiceDelivery;
  sendDate?: string;
  includeQR: boolean;
}

/** Validate a request body for POST /api/bookings/initial-invoice. */
export function parseNewBookingInvoice(
  body: unknown,
  today: string,
): { ok: true; value: NewBookingInvoiceRequest } | { ok: false; error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const reservationNumber = canonicalReservationNumber(b.reservationNumbers);
  if (!reservationNumber) {
    return { ok: false, error: 'reservationNumbers must list the BH-… numbers the booking was created as' };
  }
  const delivery = b.delivery as InvoiceDelivery;
  if (!INVOICE_DELIVERIES.includes(delivery)) {
    return { ok: false, error: `delivery must be one of ${INVOICE_DELIVERIES.join(', ')}` };
  }
  const invoiceData = cleanInvoiceData(b.invoiceData);
  const sendDate = typeof b.sendDate === 'string' ? b.sendDate.trim() : undefined;
  const problem = invoiceDeliveryProblem(invoiceData, delivery, sendDate, today);
  if (problem) return { ok: false, error: problem };
  return {
    ok: true,
    value: {
      reservationNumber,
      reservationNumbers: (b.reservationNumbers as unknown[]).filter(
        (n): n is string => typeof n === 'string' && RESERVATION_RE.test(n),
      ),
      invoiceData,
      delivery,
      ...(delivery === 'schedule' ? { sendDate } : {}),
      includeQR: b.includeQR === true,
    },
  };
}

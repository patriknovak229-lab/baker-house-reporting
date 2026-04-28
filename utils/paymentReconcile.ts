/**
 * Payment status reconciliation — runs whenever a Stripe payment changes state
 * (webhook fires, manual "check Stripe" click) and decides whether to overlay
 * a paymentStatusOverride on the reservation.
 *
 * Background: derivePayment() in /api/bookings reads the Beds24 deposit field
 * to decide Paid/Partially Paid/Unpaid. Phone bookings created by the operator
 * with a payment link don't update the Beds24 deposit on payment — only the
 * reporting app's AdditionalPayment record flips to "paid". Without this
 * reconciliation, those reservations stay stuck at "Unpaid" in the drawer.
 *
 * Strategy: sum every paid AdditionalPayment for the reservation, compare to
 * the booking's total price (fetched from Beds24), and write a local override
 * to baker:reservation-overrides only when there's something to overlay.
 *
 * Manual overrides win — if a human already set paymentStatusOverride to
 * something, we leave it alone (they may have refunded, etc.).
 */

import { Redis } from '@upstash/redis';
import type { AdditionalPayment } from '@/types/additionalPayment';
import type { PaymentStatus } from '@/types/reservation';
import { getAccessToken } from '@/utils/beds24Auth';

const BEDS24_API_BASE = 'https://beds24.com/api/v2';
const ADDITIONAL_PAYMENTS_KEY = 'baker:additional-payments';
const OVERRIDES_KEY = 'baker:reservation-overrides';

interface LocalFields {
  paymentStatusOverride?: PaymentStatus | null;
  // other fields exist but we don't read/write them here — we only modify the
  // payment override and pass everything else through unchanged.
  [key: string]: unknown;
}

/**
 * Fetch a single booking's total price from Beds24 by booking ID.
 * Returns null if the booking can't be fetched or has no price.
 */
async function fetchBookingPrice(bookingId: string | number): Promise<number | null> {
  const id = String(bookingId).replace(/^BH-/, '');
  if (!/^\d+$/.test(id)) return null;

  try {
    const token = await getAccessToken();
    const res = await fetch(`${BEDS24_API_BASE}/bookings?id=${id}`, {
      headers: { token },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const json = await res.json();
    const data = json?.data ?? json;
    const booking = Array.isArray(data) ? data[0] : data;
    const price = Number(booking?.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

/**
 * Decide a payment status from total paid vs booking price.
 *  - paid >= price   → "Paid"
 *  - 0 < paid < price → "Partially Paid"
 *  - paid === 0     → null (don't override; deposit-derived value is fine)
 *
 * Allow a 1 Kč rounding tolerance in case Stripe haléř conversion drifts.
 */
function decideStatus(paidSum: number, bookingPrice: number): PaymentStatus | null {
  if (paidSum <= 0) return null;
  if (paidSum + 1 >= bookingPrice) return 'Paid';
  return 'Partially Paid';
}

/**
 * Recompute paymentStatusOverride for a reservation based on Stripe payment
 * state. Idempotent — safe to call multiple times. No-op if there are no paid
 * AdditionalPayments for this reservation.
 *
 * Manual override safety: if the existing override is anything other than
 * undefined / null / "Unpaid", we don't touch it (assumption: human set it
 * deliberately, e.g. "Refunded" after a chargeback).
 */
export async function recomputePaymentOverride(
  redis: Redis,
  reservationNumber: string,
): Promise<{ applied: boolean; status: PaymentStatus | null; paidSum: number; bookingPrice: number | null }> {
  const [allPayments, overridesRaw, bookingPrice] = await Promise.all([
    redis.get<AdditionalPayment[]>(ADDITIONAL_PAYMENTS_KEY).then((v) => v ?? []),
    redis.get(OVERRIDES_KEY),
    fetchBookingPrice(reservationNumber),
  ]);

  const overrides: Record<string, LocalFields> =
    overridesRaw && typeof overridesRaw === 'object'
      ? (overridesRaw as Record<string, LocalFields>)
      : {};

  const paidSum = allPayments
    .filter((p) => p.reservationNumber === reservationNumber && p.status === 'paid')
    .reduce((sum, p) => sum + (p.amountCzk ?? 0), 0);

  if (bookingPrice === null) {
    // Can't fetch price → can't decide. Leave override untouched.
    return { applied: false, status: null, paidSum, bookingPrice: null };
  }

  const newStatus = decideStatus(paidSum, bookingPrice);
  if (newStatus === null) {
    return { applied: false, status: null, paidSum, bookingPrice };
  }

  // Manual override safety
  const current = overrides[reservationNumber] ?? {};
  const currentOverride = current.paymentStatusOverride;
  const isManualOverride =
    currentOverride !== undefined &&
    currentOverride !== null &&
    currentOverride !== 'Unpaid' &&
    currentOverride !== newStatus;
  if (isManualOverride) {
    return { applied: false, status: currentOverride, paidSum, bookingPrice };
  }

  // Already in sync
  if (currentOverride === newStatus) {
    return { applied: false, status: newStatus, paidSum, bookingPrice };
  }

  overrides[reservationNumber] = { ...current, paymentStatusOverride: newStatus };
  await redis.set(OVERRIDES_KEY, overrides);

  return { applied: true, status: newStatus, paidSum, bookingPrice };
}

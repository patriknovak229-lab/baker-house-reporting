import type { Reservation } from "@/types/reservation";

/**
 * Revenue components for a single reservation row (period-agnostic — callers
 * multiply by fraction-of-stay). Net sales for a row is `gbv - commission - fee`.
 *
 * For a NON-ARRIVAL, revenue is the net retained — the original booking price
 * minus whatever refund the operator issued at the channel — with zero OTA
 * commission and zero payment fee (the operator enters the net they actually
 * keep, so nothing is deducted again). The net is applied as a ratio of the
 * row's current `price` rather than as an absolute, so it composes with
 * `expandLinkedReservations` (which splits a package booking's price across its
 * rooms): each expanded row keeps its proportional share of the net.
 *
 * For a PARTIAL PLATFORM REFUND, the booking stands and `gbv` drops by the
 * refunded amount while `commission` and `fee` stay exactly as the channel
 * charged them — Booking.com bills its cut on the price it sold at and never
 * hears about money we hand back afterwards. The same fee on a smaller base
 * simply makes the effective channel rate on that booking higher, which is the
 * real economics. The refund is pro-rated by the same price ratio as the
 * non-arrival net, for the same package-booking reason. A non-arrival never
 * also carries a refund — its net price already nets one off — which is why the
 * two flags are mutually exclusive in the UI.
 *
 * Plain reservations return their Beds24 figures unchanged. Cancellations that
 * are NOT non-arrivals should be filtered out by the caller before this point.
 */
export function reservationRevenue(
  r: Reservation,
): { gbv: number; commission: number; fee: number } {
  if (r.nonArrival) {
    const original = r.nonArrival.originalPriceCzk;
    const net = r.nonArrivalNetPriceCzk ?? original;
    const ratio = original > 0 ? net / original : 1;
    return { gbv: r.price * ratio, commission: 0, fee: 0 };
  }
  return {
    gbv: r.price - platformRefundShare(r),
    commission: r.commissionAmount,
    fee: r.paymentChargeAmount,
  };
}

/**
 * This row's share of the booking's platform refund, in CZK.
 *
 * Exported so the reservation drawer can show the deduction on its own line —
 * `reservationRevenue` folds it into `gbv`, which is what every aggregate
 * consumes, so this is the only way to display it without double-counting.
 *
 * Clamped to the row's own price: a mistyped amount should flatten the row's
 * gross to zero, not turn it negative and quietly eat into another booking's
 * contribution in a monthly total.
 */
export function platformRefundShare(r: Reservation): number {
  const pr = r.platformRefund;
  if (!pr || pr.amountCzk <= 0) return 0;
  const ratio = pr.originalPriceCzk > 0 ? r.price / pr.originalPriceCzk : 1;
  return Math.min(r.price, pr.amountCzk * ratio);
}

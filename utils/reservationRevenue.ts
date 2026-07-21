import type { Reservation } from "@/types/reservation";

/**
 * Revenue components for a single reservation row (period-agnostic — callers
 * multiply by fraction-of-stay).
 *
 * For a NON-ARRIVAL, revenue is the net retained — the original booking price
 * minus whatever refund the operator issued at the channel — with zero OTA
 * commission and zero payment fee (the operator enters the net they actually
 * keep, so nothing is deducted again). The net is applied as a ratio of the
 * row's current `price` rather than as an absolute, so it composes with
 * `expandLinkedReservations` (which splits a package booking's price across its
 * rooms): each expanded row keeps its proportional share of the net.
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
  return { gbv: r.price, commission: r.commissionAmount, fee: r.paymentChargeAmount };
}

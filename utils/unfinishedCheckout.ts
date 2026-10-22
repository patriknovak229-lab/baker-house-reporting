/**
 * A Beds24 booking-page checkout the guest never paid for.
 *
 * The Beds24 booking page (where Google Hotel Ads guests land) takes the full
 * deposit through the Stripe gateway, and the property is set to cancel on
 * non-payment. Beds24 writes such a booking straight away with
 * status "cancelled" and NO cancelTime — nobody ever cancelled a live booking,
 * the guest just didn't finish paying. A real cancellation always carries a
 * cancelTime.
 *
 * Seen on BH-95080626 (2026-10-22, Google Ads): created 13:11:20 already
 * cancelled, modifiedTime = bookingTime, no payment invoice item, deposit =
 * the requested 100 %. Older booking-page tests (BH-83844200, BH-84169792) have
 * the same shape.
 *
 * Only bookings created within `windowMs` qualify — an old booking with a
 * missing cancelTime is a different, unexplained case and keeps the normal
 * cancellation alert.
 */
export function isUnfinishedCheckout(
  b: { status?: string; cancelTime?: string | null; bookingTime?: string | null },
  now: number,
  windowMs: number,
): boolean {
  if (b.status !== "cancelled" && b.status !== "canceled") return false;
  if (b.cancelTime) return false;
  if (!b.bookingTime) return false;
  const age = now - new Date(b.bookingTime).getTime();
  return age >= 0 && age <= windowMs;
}

import type { Reservation, RevenueSpan, StayShortening } from "@/types/reservation";
import { getNightsInPeriod, type DateRange } from "@/utils/periodUtils";

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

// ─── Spreading a reservation's money over time ─────────────────────────────

function nightsBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * How a SHORTENED stay's money is spread over nights.
 *
 * Beds24 holds the shortened dates (so the freed nights could be resold) but
 * the original price — the guest paid for the whole stay, and any refund is
 * agreed later, often only once we know which freed nights were resold. Spread
 * evenly over the shorter stay, that price inflates every stayed night: a
 * 28-night, 48 736 Kč stay cut to 6 nights would book 4/6 of the full price
 * into the first month instead of 4/28 (BH-92586229, September 2026).
 *
 * So a shortened stay is treated as a partial non-arrival:
 *   - every night the guest slept keeps the ORIGINAL nightly rate
 *     (original price ÷ original nights);
 *   - whatever the guest has paid beyond that stays as revenue on the trimmed
 *     nights' original dates, the same way a non-arrival's money stays on its
 *     booked dates while the room is resold;
 *   - refunds come off the trimmed nights first — a recorded refund
 *     (`platformRefund`, already netted out of `gbv`) or a price the operator
 *     lowered in Beds24 — and only an amount larger than the trimmed nights
 *     were worth eats into the stayed nights.
 *
 * Returns shares of `gbv` per span (summing to 1), or null when the record no
 * longer describes the booking — its dates moved again outside the app,
 * nothing was trimmed, or there is no money to spread — so the caller falls
 * back to the plain even spread over the stay.
 */
export function shortenedRevenueSpans(input: {
  shortening: Pick<
    StayShortening,
    "fromArrival" | "fromDeparture" | "toArrival" | "toDeparture" | "originalPriceCzk"
  >;
  checkInDate: string;
  checkOutDate: string;
  /** The booking's gross after any recorded refund — `reservationRevenue().gbv`. */
  gbv: number;
}): RevenueSpan[] | null {
  const { shortening: s, checkInDate, checkOutDate, gbv } = input;
  if (s.toArrival !== checkInDate || s.toDeparture !== checkOutDate) return null;
  const head = nightsBetween(s.fromArrival, s.toArrival);
  const stayed = nightsBetween(s.toArrival, s.toDeparture);
  const tail = nightsBetween(s.toDeparture, s.fromDeparture);
  const trimmed = head + tail;
  if (head < 0 || tail < 0 || stayed <= 0 || trimmed <= 0) return null;
  if (!(gbv > 0) || !(s.originalPriceCzk > 0)) return null;

  const nightlyRate = s.originalPriceCzk / (stayed + trimmed);
  const stayedValue = Math.min(gbv, nightlyRate * stayed);
  const trimmedValue = gbv - stayedValue;

  const spans: RevenueSpan[] = [];
  if (head > 0) {
    spans.push({ from: s.fromArrival, to: s.toArrival, share: (trimmedValue * head) / trimmed / gbv });
  }
  spans.push({ from: s.toArrival, to: s.toDeparture, share: stayedValue / gbv });
  if (tail > 0) {
    spans.push({ from: s.toDeparture, to: s.fromDeparture, share: (trimmedValue * tail) / trimmed / gbv });
  }
  return spans;
}

/**
 * The spans this row's money is spread over, or null for the ordinary case —
 * an even spread over the row's own stay. Pieces already split by
 * `expandLinkedReservations` carry theirs precomputed (`revenueSpans`); a whole
 * reservation derives them from its shortening record on the fly, so a refund
 * the operator just recorded is reflected without a reload.
 */
export function revenueSpansOf(r: Reservation): RevenueSpan[] | null {
  if (r.revenueSpans) return r.revenueSpans;
  const s = r.stayShortened;
  if (!s || r.nonArrival || r.isCancelled) return null;
  return shortenedRevenueSpans({
    shortening: s,
    checkInDate: r.checkInDate,
    checkOutDate: r.checkOutDate,
    gbv: reservationRevenue(r).gbv,
  });
}

/**
 * The fraction of this row's money — gross, commission and payment fee alike —
 * that belongs to `range`. For an ordinary reservation that is its nights in
 * the period over its nights; a shortened stay follows `revenueSpansOf`.
 *
 * Every period aggregate multiplies `reservationRevenue` by this. Don't
 * compute `nights / numberOfNights` by hand for money: it double-books a
 * shortened stay's unused nights into the nights the guest actually slept.
 */
export function revenueShareInPeriod(r: Reservation, range: DateRange): number {
  const spans = revenueSpansOf(r);
  if (!spans) {
    return r.numberOfNights > 0 ? getNightsInPeriod(r, range) / r.numberOfNights : 0;
  }
  let share = 0;
  for (const span of spans) {
    const nights = nightsBetween(span.from, span.to);
    if (nights <= 0) continue;
    const inPeriod = getNightsInPeriod({ checkInDate: span.from, checkOutDate: span.to }, range);
    share += (span.share * inPeriod) / nights;
  }
  return share;
}

/**
 * Period pre-filter for MONEY views: a night in the period, or revenue that
 * belongs to it. The second case is a shortened stay whose trimmed nights fall
 * in a month the guest never slept in (a stay cut to end on the 30th still owes
 * the next month its unused nights). Such a row carries 0 nights, so occupancy
 * and booking counts must keep gating on `getNightsInPeriod(r) > 0`.
 */
export function hasRevenueInPeriod(r: Reservation, range: DateRange): boolean {
  return getNightsInPeriod(r, range) > 0 || revenueShareInPeriod(r, range) > 0;
}

/**
 * A shortened stay's gross split into the nights the guest slept and the unused
 * (trimmed) nights, for the reservation drawer. Null when the booking isn't
 * shortened or its shortening record no longer matches its dates.
 */
export function shortenedRevenueSplit(r: Reservation): {
  stayedNights: number;
  unusedNights: number;
  stayedCzk: number;
  unusedCzk: number;
  /** Original price ÷ original nights — what each stayed night is booked at. */
  nightlyRateCzk: number;
} | null {
  const s = r.stayShortened;
  if (!s || r.revenueSpans) return null;
  const spans = revenueSpansOf(r);
  if (!spans) return null;
  const gbv = reservationRevenue(r).gbv;
  const stayed = spans.find((sp) => sp.from === s.toArrival && sp.to === s.toDeparture);
  const stayedNights = nightsBetween(s.toArrival, s.toDeparture);
  const unusedNights = nightsBetween(s.fromArrival, s.fromDeparture) - stayedNights;
  const stayedCzk = gbv * (stayed?.share ?? 0);
  return {
    stayedNights,
    unusedNights,
    stayedCzk,
    unusedCzk: gbv - stayedCzk,
    nightlyRateCzk: s.originalPriceCzk / (stayedNights + unusedNights),
  };
}

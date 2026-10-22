/**
 * Refunds of a website (Direct-Web) booking's Stripe checkout — the pure half.
 * The Stripe / database I/O lives in utils/webPaymentServer.ts.
 *
 * WHY THE LINK IS INFERRED. The rental site creates the Beds24 booking only
 * AFTER the guest has paid, so the checkout session carries just the stay
 * (roomId / arrival / departure), and the session → booking id it keeps in its
 * own Redis expires after 24 h. Nothing durable names the booking a payment
 * paid for. What does survive is very consistent: the payment and the booking
 * share the guest's email, and agree on at least two of
 *   - the stay dates (the ORIGINAL ones when the stay was shortened since),
 *   - the amount (the booking price is the price the guest paid),
 *   - the time: the website creates the booking within a minute of the payment.
 * All 16 web payments logged May–Oct 2026 tie to exactly one booking that way,
 * and every booking to exactly one payment. Anything less clear-cut is refused
 * (`ambiguous` / `none`) — the operator refunds in the Stripe Dashboard instead.
 *
 * The link is NOT written back to stripe_payment_log.reservation_number: the VAT
 * engine treats a payment with a reservation number as a payment link, which
 * would change past periods. It's recorded on the refund itself instead (Stripe
 * refund metadata + `PlatformRefund.stripeRefunds`).
 */
import type { PlatformRefund, PlatformRefundStripeEntry, StayShortening } from "@/types/reservation";

/** A completed checkout from the app's Stripe log (stripe_payment_log) */
export interface WebCheckout {
  sessionId: string;
  /** "Web booking 2026-09-27 → 2026-10-25" for website sessions */
  description: string;
  amountCzk: number;
  guestEmail: string;
  /** ISO — when the app's webhook logged the payment */
  paidAt: string;
}

/** The slice of a booking (bookings mirror + overlay) the matcher needs */
export interface WebBookingFacts {
  reservationNumber: string;
  channel: string;
  checkInDate: string | null;
  checkOutDate: string | null;
  price: number;
  email: string;
  /** ISO — when the booking was created in Beds24 */
  bookingTimestamp: string | null;
  isCancelled: boolean;
  stayShortened?: Pick<StayShortening, "fromArrival" | "fromDeparture" | "originalPriceCzk"> | null;
}

export interface MatchSignals {
  email: boolean;
  dates: boolean;
  amount: boolean;
  timing: boolean;
}

export type WebPaymentLink =
  | { status: "linked"; checkout: WebCheckout; signals: MatchSignals }
  | { status: "none"; reason: string }
  | { status: "ambiguous"; reason: string };

const WEB_PREFIX = "Web booking ";
/** The website books in Beds24 right after the payment; allow clock skew before it */
const TIMING_BEFORE_MS = 5 * 60_000;
const TIMING_AFTER_MS = 60 * 60_000;

export function isWebCheckout(c: Pick<WebCheckout, "description">): boolean {
  return c.description.startsWith(WEB_PREFIX);
}

/** Stay dates from "Web booking 2026-09-27 → 2026-10-25" */
export function checkoutStay(description: string): { arrival: string; departure: string } | null {
  const m = description.match(/(\d{4}-\d{2}-\d{2})\D+(\d{4}-\d{2}-\d{2})/);
  return m ? { arrival: m[1], departure: m[2] } : null;
}

const normEmail = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export function matchSignals(c: WebCheckout, b: WebBookingFacts): MatchSignals {
  const email = normEmail(c.guestEmail) !== "" && normEmail(c.guestEmail) === normEmail(b.email);

  const stay = checkoutStay(c.description);
  const arrival = b.stayShortened?.fromArrival ?? b.checkInDate;
  const departure = b.stayShortened?.fromDeparture ?? b.checkOutDate;
  const dates = !!stay && stay.arrival === arrival && stay.departure === departure;

  // The price the guest paid — kept on the shorten record if it was lowered since
  const prices = [b.price, b.stayShortened?.originalPriceCzk].filter((p): p is number => typeof p === "number" && p > 0);
  const amount = prices.some((p) => Math.abs(p - c.amountCzk) <= 1);

  const paid = Date.parse(c.paidAt);
  const booked = b.bookingTimestamp ? Date.parse(b.bookingTimestamp) : NaN;
  const timing = Number.isFinite(paid) && Number.isFinite(booked)
    && booked - paid >= -TIMING_BEFORE_MS && booked - paid <= TIMING_AFTER_MS;

  return { email, dates, amount, timing };
}

/** Same guest email and at least two of stay / amount / timing */
export function checkoutMatchesBooking(c: WebCheckout, b: WebBookingFacts): boolean {
  if (b.channel !== "Direct-Web" || !isWebCheckout(c)) return false;
  const s = matchSignals(c, b);
  return s.email && Number(s.dates) + Number(s.amount) + Number(s.timing) >= 2;
}

/**
 * The web checkout that paid for `booking` — only when the tie is unique both
 * ways: one payment fits the booking, and no other booking of the same guest
 * fits that payment (a two-apartment order is two bookings on one payment).
 */
export function resolveWebPayment(
  booking: WebBookingFacts,
  checkouts: WebCheckout[],
  sameGuestBookings: WebBookingFacts[],
): WebPaymentLink {
  if (booking.channel !== "Direct-Web") return { status: "none", reason: "Not a website booking" };
  const hits = checkouts.filter((c) => checkoutMatchesBooking(c, booking));
  if (hits.length === 0) {
    return { status: "none", reason: "No website payment in the Stripe log fits this booking (guest email + stay, amount or booking time)" };
  }
  if (hits.length > 1) {
    return { status: "ambiguous", reason: `${hits.length} website payments fit this booking` };
  }
  const checkout = hits[0];
  const rivals = sameGuestBookings.filter((b) => b.reservationNumber !== booking.reservationNumber && checkoutMatchesBooking(checkout, b));
  if (rivals.length > 0) {
    return {
      status: "ambiguous",
      reason: `The payment also fits ${rivals.map((b) => b.reservationNumber).join(", ")} — one payment for several bookings`,
    };
  }
  return { status: "linked", checkout, signals: matchSignals(checkout, booking) };
}

// ─── Refund maths (haléř — Stripe's minor unit) ──────────────────────────────

export interface StripeRefundLite {
  id: string;
  amountHal: number;
  status: string;            // pending | requires_action | succeeded | failed | canceled
  created: number;           // unix seconds
  metadata?: Record<string, string>;
}

/** Statuses whose money has left (or is leaving) the charge */
const COUNTING = new Set(["pending", "requires_action", "succeeded"]);

export function countsAsRefunded(r: Pick<StripeRefundLite, "status">): boolean {
  return COUNTING.has(r.status);
}

/** What can still be refunded: charge − live refunds (Stripe's own counter as a floor) */
export function refundableHal(chargeAmountHal: number, chargeAmountRefundedHal: number, refunds: StripeRefundLite[]): number {
  const listed = refunds.filter(countsAsRefunded).reduce((s, r) => s + r.amountHal, 0);
  return Math.max(0, chargeAmountHal - Math.max(listed, chargeAmountRefundedHal));
}

/** CZK amount → haléř, or an error for anything that isn't a positive amount with ≤ 2 decimals */
export function parseRefundAmount(input: unknown): { hal: number } | { error: string } {
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n) || n <= 0) return { error: "Enter a positive amount" };
  const hal = Math.round(n * 100);
  if (Math.abs(n * 100 - hal) > 1e-6) return { error: "At most two decimal places (haléř)" };
  return { hal };
}

export const halToCzk = (hal: number) => Math.round(hal) / 100;

// ─── Recording on the booking ───────────────────────────────────────────────

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Add one Stripe refund to the booking's platform refund. Returns null when
 * that refund is already counted — callers treat that as "nothing to write",
 * which is what makes recording idempotent.
 *
 * Mirrors the drawer's manual "Mark partially refunded": flaggedAt/By and the
 * price at first flag are kept from an existing record; the amount accumulates.
 */
export function mergeStripeRefund(
  existing: PlatformRefund | null | undefined,
  entry: PlatformRefundStripeEntry,
  ctx: { priceCzk: number; nowIso: string; reason?: string },
): PlatformRefund | null {
  const prior = existing?.stripeRefunds ?? [];
  if (prior.some((e) => e.id === entry.id)) return null;
  const reasons = [existing?.reason?.trim(), ctx.reason?.trim()].filter((r): r is string => !!r);
  const reason = [...new Set(reasons)].join("; ");
  return {
    amountCzk: round2((existing?.amountCzk ?? 0) + entry.amountCzk),
    refundedAt: existing?.refundedAt && existing.refundedAt > entry.refundedAt ? existing.refundedAt : entry.refundedAt,
    ...(reason ? { reason } : {}),
    flaggedAt: existing?.flaggedAt ?? ctx.nowIso,
    flaggedBy: existing?.flaggedBy ?? entry.by,
    originalPriceCzk: existing?.originalPriceCzk ?? ctx.priceCzk,
    stripeRefunds: [...prior, entry],
  };
}

/** Stripe refunds of this charge that the booking's platform refund doesn't count yet */
export function unrecordedRefunds(refunds: StripeRefundLite[], pr: PlatformRefund | null | undefined): StripeRefundLite[] {
  const recorded = new Set((pr?.stripeRefunds ?? []).map((e) => e.id));
  return refunds.filter((r) => countsAsRefunded(r) && !recorded.has(r.id));
}

/** Refunds counted on the booking that Stripe later reports as failed / canceled */
export function recordedButFailed(refunds: StripeRefundLite[], pr: PlatformRefund | null | undefined): StripeRefundLite[] {
  const recorded = new Set((pr?.stripeRefunds ?? []).map((e) => e.id));
  return refunds.filter((r) => recorded.has(r.id) && !countsAsRefunded(r));
}

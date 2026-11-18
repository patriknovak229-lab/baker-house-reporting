/**
 * Per-booking view of Stripe payment-link money. Pure and client-safe.
 *
 * A payment link normally belongs to one booking (`reservationNumber`). For a
 * stay booked as linked reservations (a prolongation — utils/stayChains.ts) one
 * link can cover several bookings; `allocations` then says how much of it is
 * each booking's. Everything that turns payments into per-booking numbers —
 * paid status, Stripe fee roll-up, refundable amount, the drawer — must go
 * through here so a combined payment is never counted in full on each booking.
 *
 * Fees and refunds are not allocated by Stripe, so they are split pro rata to
 * each booking's share of the amount.
 */
import type { AdditionalPayment, PaymentAllocation } from "@/types/additionalPayment";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The bookings a payment covers, with their amounts. Never empty. */
export function allocationsOf(p: Pick<AdditionalPayment, "reservationNumber" | "amountCzk" | "allocations">): PaymentAllocation[] {
  const list = (p.allocations ?? []).filter((a) => a.reservationNumber && a.amountCzk > 0);
  if (list.length === 0) return [{ reservationNumber: p.reservationNumber, amountCzk: p.amountCzk }];
  return list;
}

/** Booking numbers a payment covers (first = the booking it is filed under). */
export function reservationsOf(p: Pick<AdditionalPayment, "reservationNumber" | "amountCzk" | "allocations">): string[] {
  return allocationsOf(p).map((a) => a.reservationNumber);
}

/** True when the payment covers more than one booking. */
export function isCombined(p: Pick<AdditionalPayment, "allocations">): boolean {
  return (p.allocations?.length ?? 0) > 1;
}

/**
 * Fraction (0–1) of the payment that belongs to `reservationNumber`.
 * 0 when the payment doesn't cover it.
 */
export function shareFor(
  p: Pick<AdditionalPayment, "reservationNumber" | "amountCzk" | "allocations">,
  reservationNumber: string,
): number {
  const list = allocationsOf(p);
  const total = list.reduce((s, a) => s + a.amountCzk, 0);
  if (total <= 0) return list[0]?.reservationNumber === reservationNumber ? 1 : 0;
  const mine = list.filter((a) => a.reservationNumber === reservationNumber).reduce((s, a) => s + a.amountCzk, 0);
  return mine / total;
}

/** Refunds that reduce what we keep (pending included — the money is on its way back). */
export function refundedCzk(p: Pick<AdditionalPayment, "refunds">): number {
  return (p.refunds ?? [])
    .filter((r) => r.status === "succeeded" || r.status === "pending")
    .reduce((s, r) => s + r.amountCzk, 0);
}

/** Settled at some point (a refunded payment was paid once). */
export function wasPaid(p: Pick<AdditionalPayment, "status">): boolean {
  return p.status === "paid" || p.status === "partially-refunded" || p.status === "refunded";
}

/** This booking's part of the payment amount. */
export function amountFor(p: AdditionalPayment, reservationNumber: string): number {
  return round2(p.amountCzk * shareFor(p, reservationNumber));
}

/**
 * This booking's part of what was paid and not refunded. A refund tagged
 * with a booking (cancelling one booking of a linked stay) comes off that
 * booking only; untagged refunds are spread pro rata.
 */
export function netPaidFor(p: AdditionalPayment, reservationNumber: string): number {
  if (!wasPaid(p)) return 0;
  const share = shareFor(p, reservationNumber);
  if (share <= 0) return 0;
  let mine = 0;
  let untagged = 0;
  for (const r of p.refunds ?? []) {
    if (r.status !== "succeeded" && r.status !== "pending") continue;
    if (!r.reservationNumber || !isCombined(p)) untagged += r.amountCzk;
    else if (r.reservationNumber === reservationNumber) mine += r.amountCzk;
  }
  return round2(Math.max(0, p.amountCzk * share - mine - untagged * share));
}

/** This booking's part of the Stripe processing fee. */
export function feeFor(p: AdditionalPayment, reservationNumber: string): number {
  if (typeof p.stripeFeeCzk !== "number") return 0;
  return round2(p.stripeFeeCzk * shareFor(p, reservationNumber));
}

/** Net paid on one booking across every payment that covers it. */
export function netPaidOnBooking(all: readonly AdditionalPayment[], reservationNumber: string): number {
  return round2(all.reduce((s, p) => s + netPaidFor(p, reservationNumber), 0));
}

/** Payments that cover a booking — filed under it or allocated to it. */
export function paymentsCovering<T extends AdditionalPayment>(all: readonly T[], reservationNumber: string): T[] {
  return all.filter((p) => shareFor(p, reservationNumber) > 0);
}

/**
 * Validate allocations sent by a client: 2+ distinct bookings, each ≥ 1 Kč.
 * Returns an error message, or null when fine.
 */
export function allocationsError(list: unknown): string | null {
  if (!Array.isArray(list) || list.length < 2) return "A combined payment needs at least two bookings";
  const seen = new Set<string>();
  for (const a of list) {
    const rn = typeof a?.reservationNumber === "string" ? a.reservationNumber.trim() : "";
    const amt = Number(a?.amountCzk);
    if (!rn) return "Every booking needs a reservation number";
    if (seen.has(rn)) return `${rn} is listed twice`;
    seen.add(rn);
    if (!Number.isFinite(amt) || amt < 1) return `${rn}: amount must be at least 1 Kč`;
  }
  return null;
}

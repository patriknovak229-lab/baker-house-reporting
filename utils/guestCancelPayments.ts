/**
 * Server side of the guest cancellation's money: which Stripe payments a
 * direct booking has, and refunding them. Server-only.
 *
 * Stripe payments on a booking:
 *   - the website checkout (Direct-Web), tied by utils/webPaymentServer
 *   - payment links (AdditionalPayment rows, status paid / partially-refunded)
 * Refundable = paid minus refunds already made (pending ones included), so
 * earlier refunds — from the drawer or the Stripe Dashboard — are respected.
 *
 * The payment-link refund mirrors app/api/stripe/refund (left untouched) but
 * adds a Stripe idempotency key, so a double submit can't refund twice.
 */
import Stripe from "stripe";
import type { AdditionalPayment, AdditionalPaymentStatus, PaymentRefund } from "@/types/additionalPayment";
import { readAllAdditionalPayments, writeAllAdditionalPayments } from "@/utils/additionalPaymentsStore";
import { recomputePaymentOverride } from "@/utils/paymentReconcile";
import { getWebPaymentState, refundWebPayment, type RefundResult } from "@/utils/webPaymentServer";
import { webPaymentDeps } from "@/utils/webPaymentDeps";
import type { PaymentPicture } from "@/utils/guestCancellation";

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface BookingPayments {
  picture: PaymentPicture;
  web: { sessionId: string; refundableCzk: number } | null;
  links: Array<{ id: string; refundableCzk: number; description: string }>;
  /** Why the website checkout isn't refundable from here, when it isn't */
  webNote?: string;
}

function linkRefunded(p: AdditionalPayment): number {
  return (p.refunds ?? [])
    .filter((r) => r.status === "succeeded" || r.status === "pending")
    .reduce((s, r) => s + r.amountCzk, 0);
}

export async function loadBookingPayments(
  reservationNumber: string,
  channel: string,
  depositCzk: number,
): Promise<BookingPayments> {
  let web: BookingPayments["web"] = null;
  let webNote: string | undefined;
  if (channel === "Direct-Web") {
    try {
      const state = await getWebPaymentState(webPaymentDeps(), reservationNumber);
      if (state.stripe && !state.blocked) {
        web = { sessionId: state.stripe.sessionId, refundableCzk: state.stripe.refundableCzk };
      } else {
        webNote = state.blocked ?? state.stripeError;
      }
    } catch (err) {
      webNote = err instanceof Error ? err.message : "Website payment lookup failed";
    }
  }

  const links = (await readAllAdditionalPayments())
    .filter((p) => p.reservationNumber === reservationNumber)
    .filter((p) => p.status === "paid" || p.status === "partially-refunded")
    .sort((a, b) => String(a.paidAt ?? a.createdAt ?? "").localeCompare(String(b.paidAt ?? b.createdAt ?? "")))
    .map((p) => ({ id: p.id, refundableCzk: round2(Math.max(0, p.amountCzk - linkRefunded(p))), description: p.description ?? "" }));

  const hasStripe = web != null || links.length > 0;
  const picture: PaymentPicture = hasStripe
    ? { method: "stripe", refundableCzk: round2((web?.refundableCzk ?? 0) + links.reduce((s, l) => s + l.refundableCzk, 0)) }
    : { method: "invoice", paidCzk: round2(Math.max(0, depositCzk)) };

  return { picture, web, links, webNote };
}

/** Refund the website checkout — the existing engine (records platformRefund too). */
export async function refundWebCheckout(input: {
  reservationNumber: string;
  sessionId: string;
  amountCzk: number;
  reason: string;
  idempotencyKey: string;
  operator: string;
}): Promise<RefundResult> {
  return refundWebPayment(webPaymentDeps(), input);
}

let stripeSingleton: Stripe | null = null;
function stripe(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("Stripe isn't configured on this server");
  return (stripeSingleton ??= new Stripe(process.env.STRIPE_SECRET_KEY));
}

function mapStatus(s: Stripe.Refund["status"] | null | undefined): PaymentRefund["status"] {
  return s === "succeeded" || s === "pending" || s === "failed" || s === "canceled" ? s : "pending";
}

/** Refund (part of) one payment link; writes the local refund like /api/stripe/refund. */
export async function refundPaymentLink(input: {
  sessionId: string;
  amountCzk: number;
  reason: string;
  idempotencyKey: string;
  operator: string;
}): Promise<PaymentRefund> {
  const payments = await readAllAdditionalPayments();
  const idx = payments.findIndex((p) => p.id === input.sessionId);
  if (idx === -1) throw new Error(`Payment ${input.sessionId} not found`);
  const payment = payments[idx];
  const refundable = round2(payment.amountCzk - linkRefunded(payment));
  if (input.amountCzk > refundable + 0.001) {
    throw new Error(`Payment link has only ${refundable} Kč left to refund`);
  }

  const session = await stripe().checkout.sessions.retrieve(input.sessionId, { expand: ["payment_intent.latest_charge"] });
  const pi = session.payment_intent;
  const charge = pi && typeof pi !== "string" ? pi.latest_charge : null;
  if (!charge || typeof charge === "string") throw new Error("Stripe charge not found for the payment link");

  const refund = await stripe().refunds.create(
    {
      charge: charge.id,
      amount: Math.round(input.amountCzk * 100),
      reason: "requested_by_customer",
      metadata: {
        sessionId: input.sessionId,
        operatorEmail: input.operator,
        source: "reporting-guest-cancel",
        operatorNote: input.reason.slice(0, 450),
      },
    },
    { idempotencyKey: `guest-cancel-${input.idempotencyKey}-${input.sessionId}` },
  );

  const local: PaymentRefund = {
    id: refund.id,
    amountCzk: input.amountCzk,
    refundedAt: refund.created ? new Date(refund.created * 1000).toISOString() : new Date().toISOString(),
    reason: input.reason,
    refundedBy: input.operator,
    status: mapStatus(refund.status),
    failureReason: refund.failure_reason ?? undefined,
  };
  const refunds = [...(payment.refunds ?? []).filter((r) => r.id !== refund.id), local];
  const total = refunds.filter((r) => r.status === "succeeded" || r.status === "pending").reduce((s, r) => s + r.amountCzk, 0);
  const status: AdditionalPaymentStatus = total <= 0 ? "paid" : total >= payment.amountCzk ? "refunded" : "partially-refunded";
  payments[idx] = { ...payment, refunds, status };
  await writeAllAdditionalPayments(payments);
  if (payment.reservationNumber) {
    await recomputePaymentOverride(payment.reservationNumber).catch((err) =>
      console.error("[guest-cancel] recomputePaymentOverride failed:", err),
    );
  }
  if (local.status === "failed" || local.status === "canceled") {
    throw new Error(`Stripe did not refund the payment link (status: ${local.status})`);
  }
  return local;
}

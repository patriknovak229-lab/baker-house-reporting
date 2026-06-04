/**
 * POST /api/stripe/refund
 *
 * Refund (full or partial) an AdditionalPayment that's already paid.
 *
 * Body:
 *   {
 *     sessionId: string;    // AdditionalPayment.id == Checkout Session id
 *     amountCzk: number;    // 0 < amountCzk ≤ (paid amount − already-refunded)
 *     reason?: string;      // free-text note for our records (not sent to Stripe)
 *   }
 *
 * Flow:
 *   1. Validate inputs + auth (admin only — refunds move money)
 *   2. Look up AdditionalPayment by sessionId, verify status is paid /
 *      partially-refunded
 *   3. Resolve Checkout Session → PaymentIntent → Charge so we can pass
 *      a charge id to stripe.refunds.create
 *   4. Call stripe.refunds.create({ charge, amount: czkToHaler })
 *   5. Append a pending PaymentRefund locally (will be flipped to
 *      'succeeded' by the charge.refunded webhook once Stripe confirms)
 *   6. Recompute reservation paymentStatusOverride
 *   7. Send Telegram audit
 *
 * The charge.refunded webhook is the source of truth for refund
 * status — this endpoint just initiates and writes a local "pending"
 * record so the operator sees instant feedback in the drawer.
 */

import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import { recomputePaymentOverride } from '@/utils/paymentReconcile';
import type {
  AdditionalPayment,
  AdditionalPaymentStatus,
  PaymentRefund,
} from '@/types/additionalPayment';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const ADDITIONAL_PAYMENTS_KEY = 'baker:additional-payments';

async function sendTelegram(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
  });
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  let body: { sessionId?: string; amountCzk?: number; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const sessionId = body.sessionId?.trim();
  const amountCzk = Number(body.amountCzk);
  const reason = body.reason?.trim() || undefined;

  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
  }
  if (!Number.isFinite(amountCzk) || amountCzk <= 0) {
    return NextResponse.json({ error: 'amountCzk must be a positive number' }, { status: 400 });
  }

  // ── Load + validate AdditionalPayment ───
  const payments = (await redis.get<AdditionalPayment[]>(ADDITIONAL_PAYMENTS_KEY)) ?? [];
  const idx = payments.findIndex((p) => p.id === sessionId);
  if (idx === -1) {
    return NextResponse.json({ error: 'Payment not found' }, { status: 404 });
  }
  const payment = payments[idx];

  if (payment.status === 'unpaid') {
    return NextResponse.json({ error: 'Payment is not yet paid — nothing to refund' }, { status: 400 });
  }
  if (payment.status === 'refunded') {
    return NextResponse.json({ error: 'Payment is already fully refunded' }, { status: 400 });
  }

  const alreadyRefunded = (payment.refunds ?? [])
    .filter((r) => r.status === 'succeeded' || r.status === 'pending')
    .reduce((sum, r) => sum + r.amountCzk, 0);
  const refundable = payment.amountCzk - alreadyRefunded;
  if (amountCzk > refundable) {
    return NextResponse.json(
      {
        error: `Refund amount ${amountCzk} Kč exceeds remaining refundable balance ${refundable} Kč`,
        refundable,
      },
      { status: 400 },
    );
  }

  // ── Resolve Session → PaymentIntent → Charge ───
  let chargeId: string;
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent.latest_charge'],
    });
    const pi = session.payment_intent;
    if (!pi || typeof pi === 'string') {
      throw new Error('payment_intent missing on session');
    }
    const charge = pi.latest_charge;
    if (!charge || typeof charge === 'string') {
      throw new Error('latest_charge missing on payment_intent');
    }
    chargeId = charge.id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Could not resolve Stripe charge';
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // ── Initiate refund on Stripe ───
  let stripeRefund: Stripe.Refund;
  try {
    stripeRefund = await stripe.refunds.create({
      charge: chargeId,
      amount: Math.round(amountCzk * 100), // CZK → haléř (Stripe minor units)
      reason: 'requested_by_customer',
      metadata: {
        sessionId,
        operatorEmail: guard.email,
        ...(reason ? { operatorNote: reason } : {}),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Stripe refund failed';
    console.error('[stripe/refund] stripe.refunds.create failed:', err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // ── Write local PaymentRefund (pending — webhook will finalise) ───
  const localRefund: PaymentRefund = {
    id: stripeRefund.id,
    amountCzk,
    refundedAt: stripeRefund.created
      ? new Date(stripeRefund.created * 1000).toISOString()
      : new Date().toISOString(),
    reason,
    refundedBy: guard.email,
    status: mapStripeRefundStatus(stripeRefund.status),
    failureReason: stripeRefund.failure_reason ?? undefined,
  };

  const existingRefunds = Array.isArray(payment.refunds) ? payment.refunds : [];
  const newRefunds = [...existingRefunds.filter((r) => r.id !== stripeRefund.id), localRefund];

  // Recompute status based on the new total
  const totalRefunded = newRefunds
    .filter((r) => r.status === 'succeeded' || r.status === 'pending')
    .reduce((sum, r) => sum + r.amountCzk, 0);
  let newStatus: AdditionalPaymentStatus = payment.status;
  if (totalRefunded <= 0) newStatus = 'paid';
  else if (totalRefunded >= payment.amountCzk) newStatus = 'refunded';
  else newStatus = 'partially-refunded';

  payments[idx] = { ...payment, refunds: newRefunds, status: newStatus };
  await redis.set(ADDITIONAL_PAYMENTS_KEY, payments);

  // Reconcile reservation payment status badge
  if (payment.reservationNumber) {
    try {
      await recomputePaymentOverride(redis, payment.reservationNumber);
    } catch (err) {
      console.error('[stripe/refund] recomputePaymentOverride failed:', err);
    }
  }

  // Operator-audit Telegram
  const tg = [
    `↩️ <b>Refund initiated</b>`,
    `📝 ${payment.description || '—'}`,
    `💰 ${amountCzk.toLocaleString('cs-CZ')} Kč refunded`,
    `📊 Status: ${newStatus}`,
    payment.reservationNumber ? `🏨 Reservation #${payment.reservationNumber}` : '',
    reason ? `🗒 ${reason}` : '',
    `👤 by ${guard.email}`,
  ].filter(Boolean).join('\n');
  await sendTelegram(tg).catch(() => null);

  return NextResponse.json({
    ok: true,
    refund: localRefund,
    newStatus,
    remainingRefundable: payment.amountCzk - totalRefunded,
  });
}

function mapStripeRefundStatus(
  s: Stripe.Refund['status'] | null | undefined,
): PaymentRefund['status'] {
  switch (s) {
    case 'succeeded': return 'succeeded';
    case 'pending':   return 'pending';
    case 'failed':    return 'failed';
    case 'canceled':  return 'canceled';
    default:          return 'pending';
  }
}

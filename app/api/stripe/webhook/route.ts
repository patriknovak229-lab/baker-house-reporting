import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { Redis } from '@upstash/redis';
import type {
  AdditionalPayment,
  AdditionalPaymentStatus,
  PaymentRefund,
} from '@/types/additionalPayment';
import type { RevenueInvoice } from '@/types/revenueInvoice';
import { recomputePaymentOverride } from '@/utils/paymentReconcile';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const ADDITIONAL_PAYMENTS_KEY = 'baker:additional-payments';
const REVENUE_INVOICES_KEY    = 'baker:revenue-invoices';

async function sendTelegram(message: string): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
  });
}

export interface StripePaymentRecord {
  sessionId: string;
  description: string;
  amountCzk: number;
  guestEmail: string;
  guestPhone: string;
  guestName?: string;
  reservationNumber?: string;
  paidAt: string; // ISO
}

// Raw body is required for Stripe signature verification — must NOT parse with req.json()
export async function POST(req: NextRequest) {
  const sig    = req.headers.get('stripe-signature');
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    console.error('[stripe/webhook] STRIPE_WEBHOOK_SECRET not set');
    return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 });
  }

  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig ?? '', secret);
  } catch (err) {
    console.error('[stripe/webhook] Signature verification failed:', err);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  // ─── New event handlers ───
  //
  // charge.succeeded and charge.updated catch the BalanceTransaction
  // (Stripe processing fee) once it becomes available — the fee is
  // often NOT ready at the moment `checkout.session.completed` fires
  // (especially for SEPA / bank-redirect / Apple Pay flows). These
  // events also fire when the charge gets updated for any reason
  // (e.g. a refund creates a charge.updated), so the handler is
  // idempotent: re-running it on the same charge just sets the same
  // fee on the same payment record.
  //
  // charge.refunded fires when a refund — initiated either from our
  // app via /api/stripe/refund OR directly from the Stripe dashboard
  // — completes. Syncs Stripe's refund.list into our local
  // AdditionalPayment.refunds[] and bumps the payment status.
  if (event.type === 'charge.succeeded' || event.type === 'charge.updated') {
    await handleChargeFeeSync(event.data.object as Stripe.Charge).catch((err) =>
      console.error('[stripe/webhook] charge fee sync failed:', err),
    );
    return NextResponse.json({ ok: true });
  }
  if (event.type === 'charge.refunded') {
    await handleChargeRefundSync(event.data.object as Stripe.Charge).catch((err) =>
      console.error('[stripe/webhook] charge refund sync failed:', err),
    );
    return NextResponse.json({ ok: true });
  }

  if (event.type !== 'checkout.session.completed') {
    return NextResponse.json({ ok: true, skipped: event.type });
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const meta    = session.metadata ?? {};

  // Two metadata schemas hit this webhook:
  //   1. Reporting-app payment links — set { description, amountCzk, guestEmail/Phone/Name, reservationNumber }
  //   2. Rental-site bookings (bakerhouseapartments.cz) — set only { roomId, arrival, departure, voucherCode? }
  // For (2) the metadata-driven Telegram came out empty. Fall back to the Stripe session itself
  // (amount_total + customer_email + customer_details.name) so direct-web payments still produce
  // a useful notification. Metadata wins when present.
  const sessionAmountCzk = typeof session.amount_total === 'number'
    ? session.amount_total / 100
    : 0;
  const sessionEmail = session.customer_email ?? session.customer_details?.email ?? '';
  const sessionName = session.customer_details?.name ?? '';
  const sessionPhone = session.customer_details?.phone ?? '';
  // Synthesize a description for rental-site bookings from arrival/departure metadata
  const fallbackDescription = (meta.arrival && meta.departure)
    ? `Web booking ${meta.arrival} → ${meta.departure}`
    : '';

  const record: StripePaymentRecord = {
    sessionId:         session.id,
    description:       meta.description       || fallbackDescription || '',
    amountCzk:         parseFloat(meta.amountCzk ?? '0') || sessionAmountCzk,
    guestEmail:        meta.guestEmail        || sessionEmail || '',
    guestPhone:        meta.guestPhone        || sessionPhone || '',
    guestName:         meta.guestName         || sessionName  || undefined,
    reservationNumber: meta.reservationNumber || undefined,
    paidAt:            new Date().toISOString(),
  };

  // Persist to legacy Redis list (backwards compat)
  const existingRecords = await redis.get<StripePaymentRecord[]>('baker:stripe-payments') ?? [];
  await redis.set('baker:stripe-payments', [...existingRecords, record]);

  // Pull the Stripe processing fee from the BalanceTransaction linked to this
  // session's PaymentIntent → Charge. Captured per-payment so we can roll it up
  // to reservation.paymentChargeAmount and surface it in the existing
  // PaymentBreakdown alongside OTA fees.
  // BalanceTransaction.fee is in minor units (haléř); convert to CZK.
  let stripeFeeCzk: number | undefined;
  try {
    const expanded = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ['payment_intent.latest_charge.balance_transaction'],
    });
    const pi = expanded.payment_intent;
    if (pi && typeof pi !== 'string') {
      const charge = pi.latest_charge;
      if (charge && typeof charge !== 'string') {
        const bt = charge.balance_transaction;
        if (bt && typeof bt !== 'string' && typeof bt.fee === 'number') {
          stripeFeeCzk = Math.round(bt.fee) / 100;
        }
      }
    }
  } catch (err) {
    // Non-fatal — settlement may not have happened yet; the manual "Check Stripe"
    // button or the next webhook event will fill it in.
    console.warn('[stripe/webhook] Could not fetch fee for session', session.id, err);
  }

  // Update AdditionalPayment to paid + auto-create revenue invoice (when linked to reservation)
  if (record.reservationNumber) {
    const payments = await redis.get<AdditionalPayment[]>(ADDITIONAL_PAYMENTS_KEY) ?? [];
    const idx = payments.findIndex((p) => p.id === session.id);

    if (idx !== -1) {
      const paidAt = record.paidAt;
      payments[idx] = {
        ...payments[idx],
        status: 'paid',
        paidAt,
        ...(stripeFeeCzk !== undefined ? { stripeFeeCzk } : {}),
      };

      // Auto-create revenue invoice
      const invoiceId = `pay-${session.id}`;
      const invoiceNumber = `PAY-${session.id.slice(-8).toUpperCase()}`;
      const invoiceDate = paidAt.slice(0, 10);

      const invoices = await redis.get<RevenueInvoice[]>(REVENUE_INVOICES_KEY) ?? [];
      const alreadyExists = invoices.some((i) => i.id === invoiceId);

      if (!alreadyExists) {
        const newInvoice: RevenueInvoice = {
          id:                invoiceId,
          sourceType:        'issued',
          // Direct-channel guest payment (web/link via Stripe) → accommodation revenue
          category:          'accommodation_direct',
          status:            'pending',
          invoiceNumber:     invoiceNumber,
          invoiceDate:       invoiceDate,
          amountCZK:         record.amountCzk,
          reservationNumber: record.reservationNumber,
          guestName:         record.guestName || record.guestEmail || undefined,
          description:       record.description,
          createdAt:         paidAt,
        };
        await redis.set(REVENUE_INVOICES_KEY, [...invoices, newInvoice]);
        payments[idx] = { ...payments[idx], invoiceId };
      }

      await redis.set(ADDITIONAL_PAYMENTS_KEY, payments);
    }

    // Reconcile reservation paymentStatusOverride based on the new payment state.
    // Best-effort: if Beds24 lookup fails or the override was manually set, this is a no-op.
    try {
      await recomputePaymentOverride(redis, record.reservationNumber);
    } catch (err) {
      console.error('[stripe/webhook] recomputePaymentOverride failed:', err);
    }
  }

  // Telegram notification
  const amount  = record.amountCzk ? `${record.amountCzk.toLocaleString('cs-CZ')} Kč` : '—';
  const message = [
    `💳 <b>Payment received</b>`,
    `📝 ${record.description || '—'}`,
    `💰 ${amount}`,
    record.reservationNumber ? `🏨 Reservation #${record.reservationNumber}` : '',
    record.guestEmail ? `📧 ${record.guestEmail}` : '',
    record.guestPhone ? `📞 ${record.guestPhone}` : '',
  ].filter(Boolean).join('\n');

  await sendTelegram(message);

  return NextResponse.json({ ok: true });
}

// ─── charge.succeeded / charge.updated → import Stripe processing fee ────────

/**
 * Catch the BalanceTransaction fee whenever a charge's state evolves.
 * Stripe creates the BT asynchronously after `checkout.session.completed`
 * (sometimes seconds, sometimes longer for delayed payment methods), so
 * fetching it inside the session-completed handler frequently misses.
 *
 * Idempotent: re-running with the same charge just writes the same fee
 * to the same AdditionalPayment record (or no-ops if it's already set
 * and matches).
 */
async function handleChargeFeeSync(charge: Stripe.Charge): Promise<void> {
  // 1. Extract fee. The BT may already be expanded; otherwise fetch a
  //    fresh charge with expansion so we don't fire blind.
  let fee: number | undefined;
  let chargeForLookup: Stripe.Charge = charge;
  const bt = charge.balance_transaction;
  if (bt && typeof bt !== 'string' && typeof bt.fee === 'number') {
    fee = Math.round(bt.fee) / 100;
  }
  if (fee === undefined) {
    try {
      chargeForLookup = await stripe.charges.retrieve(charge.id, {
        expand: ['balance_transaction'],
      });
      const bt2 = chargeForLookup.balance_transaction;
      if (bt2 && typeof bt2 !== 'string' && typeof bt2.fee === 'number') {
        fee = Math.round(bt2.fee) / 100;
      }
    } catch (err) {
      console.warn('[stripe/webhook] expand charge for fee failed:', err);
    }
  }
  if (fee === undefined) {
    // Fee genuinely not available yet — another charge.updated event
    // will fire when it lands. Nothing to do this round.
    return;
  }

  // 2. Find the AdditionalPayment via the session that owns this PI.
  //    AdditionalPayment.id is the Checkout Session id, not the PI.
  const piId = typeof chargeForLookup.payment_intent === 'string'
    ? chargeForLookup.payment_intent
    : chargeForLookup.payment_intent?.id;
  if (!piId) return;

  const session = await findSessionByPaymentIntent(piId);
  if (!session) {
    // Direct PaymentIntent payment without a Checkout Session — not one
    // of ours; ignore.
    return;
  }

  const payments = (await redis.get<AdditionalPayment[]>(ADDITIONAL_PAYMENTS_KEY)) ?? [];
  const idx = payments.findIndex((p) => p.id === session.id);
  if (idx === -1) return;

  // Skip if fee already set to the same value (idempotent no-op).
  if (payments[idx].stripeFeeCzk === fee) return;

  payments[idx] = { ...payments[idx], stripeFeeCzk: fee };
  await redis.set(ADDITIONAL_PAYMENTS_KEY, payments);

  // Roll the new fee total up to reservation.paymentChargeAmount
  const reservationNumber = payments[idx].reservationNumber;
  if (reservationNumber) {
    try {
      await recomputePaymentOverride(redis, reservationNumber);
    } catch (err) {
      console.error('[stripe/webhook] recomputePaymentOverride after fee sync failed:', err);
    }
  }
  console.log(
    `[stripe/webhook] imported fee ${fee.toFixed(2)} Kč for session ${session.id} via ${charge.id}`,
  );
}

// ─── charge.refunded → sync refund history into AdditionalPayment.refunds ────

/**
 * Pull every refund off the Stripe charge and mirror them into the
 * AdditionalPayment.refunds[] array. Bumps the payment status to
 * partially-refunded / refunded based on remaining balance.
 *
 * Handles BOTH refund origins:
 *   - App-initiated via /api/stripe/refund (we wrote a local PaymentRefund
 *     with status='pending' which this handler upgrades to 'succeeded'
 *     plus fills in the Stripe refund id from charge.refunds).
 *   - Dashboard-initiated directly on Stripe (we discover the refund
 *     here, creating a PaymentRefund from scratch with no operator
 *     attribution).
 *
 * Idempotent: refunds dedupe by Stripe refund id.
 */
async function handleChargeRefundSync(charge: Stripe.Charge): Promise<void> {
  // Stripe's `charge` carries an embedded `refunds` list. If it's not
  // populated, fetch fresh.
  let refundList = charge.refunds?.data ?? [];
  if (refundList.length === 0) {
    try {
      const fresh = await stripe.charges.retrieve(charge.id, { expand: ['refunds'] });
      refundList = fresh.refunds?.data ?? [];
    } catch (err) {
      console.warn('[stripe/webhook] expand charge.refunds failed:', err);
      return;
    }
  }
  if (refundList.length === 0) return;

  // Find the AdditionalPayment via the session that owns this PI.
  const piId = typeof charge.payment_intent === 'string'
    ? charge.payment_intent
    : charge.payment_intent?.id;
  if (!piId) return;

  const session = await findSessionByPaymentIntent(piId);
  if (!session) return;

  const payments = (await redis.get<AdditionalPayment[]>(ADDITIONAL_PAYMENTS_KEY)) ?? [];
  const idx = payments.findIndex((p) => p.id === session.id);
  if (idx === -1) return;

  const payment = payments[idx];
  const existingRefunds: PaymentRefund[] = Array.isArray(payment.refunds) ? payment.refunds : [];
  const existingByStripeId = new Map(existingRefunds.map((r) => [r.id, r]));

  // Build the merged refund list — keep operator metadata (refundedBy,
  // reason) we wrote when initiating via our API; sync status + amount
  // from Stripe.
  const merged: PaymentRefund[] = refundList.map((sr) => {
    const prior = existingByStripeId.get(sr.id);
    const amountCzk = Math.round((sr.amount ?? 0) / 100);
    const refundedAt = sr.created
      ? new Date(sr.created * 1000).toISOString()
      : (prior?.refundedAt ?? new Date().toISOString());
    return {
      id: sr.id,
      amountCzk,
      refundedAt,
      reason: prior?.reason ?? sr.reason ?? undefined,
      refundedBy: prior?.refundedBy,
      status: mapStripeRefundStatus(sr.status),
      failureReason: sr.failure_reason ?? undefined,
    };
  });

  // Preserve any LOCAL pending refunds that Stripe hasn't acknowledged
  // yet (rare race — refund.create returned but charge.refunded webhook
  // arrived before Stripe's own refund.list was updated). Match by
  // Stripe id — if our prior entry isn't in `refundList`, keep it.
  for (const prior of existingRefunds) {
    if (!refundList.some((sr) => sr.id === prior.id)) {
      merged.push(prior);
    }
  }

  // Recompute payment status from refund totals
  const totalRefunded = merged
    .filter((r) => r.status === 'succeeded' || r.status === 'pending')
    .reduce((sum, r) => sum + r.amountCzk, 0);
  let newStatus: AdditionalPaymentStatus = payment.status;
  if (payment.status === 'paid' || payment.status === 'partially-refunded' || payment.status === 'refunded') {
    if (totalRefunded <= 0) newStatus = 'paid';
    else if (totalRefunded >= payment.amountCzk) newStatus = 'refunded';
    else newStatus = 'partially-refunded';
  }

  payments[idx] = { ...payment, refunds: merged, status: newStatus };
  await redis.set(ADDITIONAL_PAYMENTS_KEY, payments);

  // Reconcile reservation paymentStatusOverride
  if (payment.reservationNumber) {
    try {
      await recomputePaymentOverride(redis, payment.reservationNumber);
    } catch (err) {
      console.error('[stripe/webhook] recomputePaymentOverride after refund sync failed:', err);
    }
  }

  // Operator notification — keep it tight
  const newlyAdded = merged.filter((r) => !existingByStripeId.has(r.id));
  if (newlyAdded.length > 0) {
    const sum = newlyAdded.reduce((s, r) => s + r.amountCzk, 0);
    const lines = [
      `↩️ <b>Refund processed</b>`,
      `📝 ${payment.description || '—'}`,
      `💰 ${sum.toLocaleString('cs-CZ')} Kč refunded`,
      `📊 Status: ${newStatus}`,
      payment.reservationNumber ? `🏨 Reservation #${payment.reservationNumber}` : '',
    ].filter(Boolean).join('\n');
    await sendTelegram(lines);
  }
}

// ─── Shared helpers ───

async function findSessionByPaymentIntent(
  paymentIntentId: string,
): Promise<Stripe.Checkout.Session | null> {
  try {
    const list = await stripe.checkout.sessions.list({
      payment_intent: paymentIntentId,
      limit: 1,
    });
    return list.data[0] ?? null;
  } catch (err) {
    console.warn('[stripe/webhook] checkout.sessions.list by PI failed:', err);
    return null;
  }
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

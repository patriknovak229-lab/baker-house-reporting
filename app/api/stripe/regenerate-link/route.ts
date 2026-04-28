/**
 * POST /api/stripe/regenerate-link
 *
 * Mints a fresh Stripe Checkout session for an existing AdditionalPayment that's
 * still unpaid. Use case: the original Checkout session has expired (Stripe limits
 * Checkout sessions to 24h) and the customer needs a working link.
 *
 * In place: replaces the AdditionalPayment.id (= old session id) with the new
 * session id and resets createdAt. Old Stripe session expires naturally; nothing
 * references it. The webhook will fire on the new session id correctly.
 *
 * Body: { paymentId: "<old stripe session id>" }
 *
 * Response: { ok: true, url, sessionId, paymentId, amountCzk }
 */

import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { AdditionalPayment } from '@/types/additionalPayment';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const ADDITIONAL_PAYMENTS_KEY = 'baker:additional-payments';

function getRedis(): Redis {
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const body = await req.json().catch(() => ({}));
  const paymentId = String(body?.paymentId ?? '').trim();
  if (!paymentId) {
    return NextResponse.json({ error: 'paymentId is required' }, { status: 400 });
  }

  const redis = getRedis();
  const payments = (await redis.get<AdditionalPayment[]>(ADDITIONAL_PAYMENTS_KEY)) ?? [];
  const idx = payments.findIndex((p) => p.id === paymentId);
  if (idx === -1) {
    return NextResponse.json({ error: 'AdditionalPayment not found' }, { status: 404 });
  }
  const old = payments[idx];
  if (old.status === 'paid') {
    return NextResponse.json(
      { error: 'Payment is already paid — cannot regenerate' },
      { status: 409 },
    );
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://reporting.bakerhouseapartments.cz';

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'czk',
            unit_amount: Math.round(old.amountCzk * 100),
            product_data: { name: old.description },
          },
          quantity: 1,
        },
      ],
      success_url: `${baseUrl}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/payment-success?cancelled=1`,
      customer_email: old.guestEmail || undefined,
      expires_at: Math.floor(Date.now() / 1000) + 23 * 60 * 60,
      metadata: {
        description: old.description,
        guestEmail: old.guestEmail ?? '',
        amountCzk: String(old.amountCzk),
        reservationNumber: old.reservationNumber,
        guestName: old.guestName ?? '',
        regeneratedFrom: paymentId,
      },
    });
  } catch (err) {
    console.error('[regenerate-link] Stripe error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Stripe error' },
      { status: 502 },
    );
  }

  if (!session.url || !session.id) {
    return NextResponse.json({ error: 'Stripe returned no URL/ID' }, { status: 502 });
  }

  // Replace the AdditionalPayment in place with the new session ID
  payments[idx] = {
    ...old,
    id: session.id,
    createdAt: new Date().toISOString(),
  };
  await redis.set(ADDITIONAL_PAYMENTS_KEY, payments);

  return NextResponse.json({
    ok: true,
    url: session.url,
    sessionId: session.id,
    paymentId: session.id,
    amountCzk: old.amountCzk,
  });
}

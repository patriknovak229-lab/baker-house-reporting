import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { Redis } from '@upstash/redis';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

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

  if (event.type !== 'checkout.session.completed') {
    return NextResponse.json({ ok: true, skipped: event.type });
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const meta    = session.metadata ?? {};

  const record: StripePaymentRecord = {
    sessionId:         session.id,
    description:       meta.description       ?? '',
    amountCzk:         parseFloat(meta.amountCzk ?? '0'),
    guestEmail:        meta.guestEmail         ?? '',
    guestPhone:        meta.guestPhone         ?? '',
    reservationNumber: meta.reservationNumber  || undefined,
    paidAt:            new Date().toISOString(),
  };

  // Persist to Redis list
  const existing = await redis.get<StripePaymentRecord[]>('baker:stripe-payments') ?? [];
  await redis.set('baker:stripe-payments', [...existing, record]);

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

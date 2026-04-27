import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { Redis } from '@upstash/redis';
import type { AdditionalPayment } from '@/types/additionalPayment';
import type { RevenueInvoice } from '@/types/revenueInvoice';

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

  // Update AdditionalPayment to paid + auto-create revenue invoice (when linked to reservation)
  if (record.reservationNumber) {
    const payments = await redis.get<AdditionalPayment[]>(ADDITIONAL_PAYMENTS_KEY) ?? [];
    const idx = payments.findIndex((p) => p.id === session.id);

    if (idx !== -1) {
      const paidAt = record.paidAt;
      payments[idx] = { ...payments[idx], status: 'paid', paidAt };

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
          category:          'other_services',
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

import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { requireRole } from '@/utils/authGuard';
import type { AdditionalPayment } from '@/types/additionalPayment';
import { readAllAdditionalPayments, writeAllAdditionalPayments } from '@/utils/additionalPaymentsStore';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req: NextRequest) {
  const authResult = await requireRole(['admin', 'super']);
  if ('error' in authResult) return authResult.error;

  const { amountCzk, description, guestEmail, guestPhone, reservationNumber, guestName, isMainPayment } = await req.json();

  if (!amountCzk || amountCzk < 1) {
    return NextResponse.json({ error: 'amountCzk must be at least 1' }, { status: 400 });
  }
  if (!description?.trim()) {
    return NextResponse.json({ error: 'description is required' }, { status: 400 });
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://reporting.bakerhouseapartments.cz';

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency: 'czk',
          unit_amount: Math.round(amountCzk * 100), // Stripe uses haléře
          product_data: { name: description.trim() },
        },
        quantity: 1,
      },
    ],
    success_url: `${baseUrl}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${baseUrl}/payment-success?cancelled=1`,
    customer_email: guestEmail || undefined,
    expires_at: Math.floor(Date.now() / 1000) + 23 * 60 * 60, // 23 hours (Stripe max is 24h)
    metadata: {
      description:       description.trim(),
      guestEmail:        guestEmail        ?? '',
      guestPhone:        guestPhone        ?? '',
      amountCzk:         String(amountCzk),
      reservationNumber: reservationNumber ?? '',
      guestName:         guestName         ?? '',
    },
  });

  // When linked to a reservation, create a pending AdditionalPayment record
  if (reservationNumber) {
    try {
      const existing = await readAllAdditionalPayments();
      const record: AdditionalPayment = {
        id:                session.id,
        reservationNumber: reservationNumber,
        description:       description.trim(),
        amountCzk:         amountCzk,
        guestEmail:        guestEmail || undefined,
        guestName:         guestName  || undefined,
        status:            'unpaid',
        createdAt:         new Date().toISOString(),
        ...(isMainPayment ? { isMainPayment: true } : {}),
      };
      await writeAllAdditionalPayments([...existing, record]);
    } catch (err) {
      // Non-fatal — payment link still works even if pending record fails
      console.error('[payment-link] Failed to create AdditionalPayment record:', err);
    }
  }

  return NextResponse.json({ url: session.url, sessionId: session.id });
}

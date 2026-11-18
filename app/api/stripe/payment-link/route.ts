import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import type { PaymentAllocation } from '@/types/additionalPayment';
import { readAllAdditionalPayments, writeAllAdditionalPayments } from '@/utils/additionalPaymentsStore';
import { allocationsError } from '@/utils/paymentAllocations';
import { createPaymentLink } from '@/utils/paymentLinkServer';

/**
 * POST /api/stripe/payment-link — create a Stripe Checkout link now.
 *
 * Body: { amountCzk, description, guestEmail?, guestPhone?, guestName?,
 *         reservationNumber?, isMainPayment?, allocations? }
 * `allocations` (2+ bookings) = one link for a linked stay; `amountCzk` must
 * equal their sum. Without a booking the link is free-standing (no record).
 */
export async function POST(req: NextRequest) {
  const authResult = await requireRole(['admin', 'super']);
  if ('error' in authResult) return authResult.error;

  const { amountCzk, description, guestEmail, guestPhone, reservationNumber, guestName, isMainPayment, allocations } = await req.json();

  if (!amountCzk || amountCzk < 1) {
    return NextResponse.json({ error: 'amountCzk must be at least 1' }, { status: 400 });
  }
  if (!description?.trim()) {
    return NextResponse.json({ error: 'description is required' }, { status: 400 });
  }

  let split: PaymentAllocation[];
  if (allocations != null) {
    const err = allocationsError(allocations);
    if (err) return NextResponse.json({ error: err }, { status: 400 });
    split = (allocations as PaymentAllocation[]).map((a) => ({ reservationNumber: String(a.reservationNumber).trim(), amountCzk: Number(a.amountCzk) }));
    const sum = split.reduce((s, a) => s + a.amountCzk, 0);
    if (Math.abs(sum - Number(amountCzk)) > 0.01) {
      return NextResponse.json({ error: 'amountCzk must equal the sum of the bookings' }, { status: 400 });
    }
  } else {
    split = [{ reservationNumber: reservationNumber ?? '', amountCzk: Number(amountCzk) }];
  }

  const { url, payment } = await createPaymentLink({
    description,
    allocations: split,
    guestEmail,
    guestPhone,
    guestName,
    isMainPayment: !!isMainPayment,
  });

  // Linked to a booking → pending AdditionalPayment the webhook flips to paid.
  if (payment.reservationNumber) {
    try {
      const existing = await readAllAdditionalPayments();
      await writeAllAdditionalPayments([...existing, payment]);
    } catch (err) {
      // Non-fatal — payment link still works even if pending record fails
      console.error('[payment-link] Failed to create AdditionalPayment record:', err);
    }
  }

  return NextResponse.json({ url, sessionId: payment.id });
}

/**
 * POST /api/stripe/web-payment/refund
 *
 * Refund (part of) a website booking's Stripe checkout and record it as the
 * booking's platform refund in the same step. Admin only — this moves money.
 *
 * Body: { reservationNumber, sessionId, amountCzk, reason?, idempotencyKey }
 *   - sessionId: the checkout the drawer showed; refused if the server no
 *     longer ties that payment to this booking.
 *   - idempotencyKey: made by the drawer when the confirm step opens, so a
 *     double submit or a retry returns the same refund instead of a second one.
 *
 * The server re-checks the booking (Direct-Web, not cancelled, no non-arrival),
 * the link and the live refundable balance before calling Stripe. The
 * charge.refunded webhook ignores these charges (no AdditionalPayment), so the
 * refund is recorded exactly once — here. See utils/webPaymentServer.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { refundWebPayment, WebPaymentError } from '@/utils/webPaymentServer';
import { webPaymentDeps } from '@/utils/webPaymentDeps';

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  let body: { reservationNumber?: string; sessionId?: string; amountCzk?: unknown; reason?: string; idempotencyKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const reservationNumber = body.reservationNumber?.trim();
  const sessionId = body.sessionId?.trim();
  if (!reservationNumber || !sessionId) {
    return NextResponse.json({ error: 'reservationNumber and sessionId are required' }, { status: 400 });
  }

  try {
    const result = await refundWebPayment(webPaymentDeps(), {
      reservationNumber,
      sessionId,
      amountCzk: body.amountCzk,
      reason: body.reason,
      idempotencyKey: body.idempotencyKey ?? '',
      operator: guard.email,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof WebPaymentError) {
      return NextResponse.json({ error: err.message, ...err.extra }, { status: err.status });
    }
    console.error('[stripe/web-payment/refund] failed:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Refund failed' }, { status: 500 });
  }
}

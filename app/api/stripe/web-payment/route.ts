/**
 * GET /api/stripe/web-payment?reservationNumber=BH-…
 *
 * The website (Direct-Web) checkout that paid for a booking, with its live
 * Stripe state: paid, refunded, still refundable, and refunds the booking
 * doesn't count yet. Read-only — refunds go through ./refund, recording an
 * existing Stripe refund through ./record. See utils/webPaymentServer.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { getWebPaymentState, WebPaymentError } from '@/utils/webPaymentServer';
import { webPaymentDeps } from '@/utils/webPaymentDeps';

export async function GET(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const reservationNumber = req.nextUrl.searchParams.get('reservationNumber')?.trim();
  if (!reservationNumber) {
    return NextResponse.json({ error: 'reservationNumber is required' }, { status: 400 });
  }
  try {
    return NextResponse.json(await getWebPaymentState(webPaymentDeps(), reservationNumber));
  } catch (err) {
    if (err instanceof WebPaymentError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error('[stripe/web-payment] failed:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Lookup failed' }, { status: 500 });
  }
}

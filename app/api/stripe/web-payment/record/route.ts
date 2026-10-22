/**
 * POST /api/stripe/web-payment/record
 *
 * Count a refund that already exists in Stripe — made in the Stripe Dashboard,
 * or one whose recording step failed — as the booking's platform refund. Moves
 * no money; deduped by Stripe refund id, so recording twice is a no-op.
 *
 * Body: { reservationNumber, refundId }
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { recordExistingRefund, WebPaymentError } from '@/utils/webPaymentServer';
import { webPaymentDeps } from '@/utils/webPaymentDeps';

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const body = await req.json().catch(() => ({}));
  const reservationNumber = String(body?.reservationNumber ?? '').trim();
  const refundId = String(body?.refundId ?? '').trim();
  if (!reservationNumber || !refundId) {
    return NextResponse.json({ error: 'reservationNumber and refundId are required' }, { status: 400 });
  }

  try {
    const result = await recordExistingRefund(webPaymentDeps(), { reservationNumber, refundId, operator: guard.email });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof WebPaymentError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error('[stripe/web-payment/record] failed:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Recording failed' }, { status: 500 });
  }
}

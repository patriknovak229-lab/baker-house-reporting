/**
 * POST /api/web-payments/<id> — the drawer's pay-later buttons. Admin only
 * (Patrik, 7 Nov: payment actions for the highest role).
 *
 * Body: { action: 'charge_now' }
 *     | { action: 'send_link' }
 *     | { action: 'set_amount', amountCzk, reason }
 *     | { action: 'set_no_auto_cancel', value }
 *     | { action: 'mark_paid_other', note }
 *     | { action: 'cancel_now' }
 *     | { action: 'close', reason }
 *
 * "Charge now" runs the same claim → Stripe check → link expiry → idempotent
 * charge as the scheduled job, so a click can never double-charge.
 */
import { NextRequest, NextResponse } from 'next/server';
import type { WebPaymentAction } from '@/types/webPayment';
import { requireRole } from '@/utils/authGuard';
import { webPaymentsIo } from '@/utils/webPayments/deps';
import { applyAdminAction } from '@/utils/webPayments/engine';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

const ACTIONS = new Set(['charge_now', 'send_link', 'set_amount', 'set_no_auto_cancel', 'mark_paid_other', 'cancel_now', 'close']);

export async function POST(req: NextRequest, ctx: Ctx) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;
  const { id } = await ctx.params;

  let body: WebPaymentAction;
  try {
    body = (await req.json()) as WebPaymentAction;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body || !ACTIONS.has(body.action)) return NextResponse.json({ error: 'Unknown action' }, { status: 400 });

  try {
    const r = await applyAdminAction(webPaymentsIo(), id, body, guard.email);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true, detail: r.detail ?? null });
  } catch (err) {
    console.error('[web-payments] action failed:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Action failed' }, { status: 500 });
  }
}

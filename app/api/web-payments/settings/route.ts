/**
 * GET  /api/web-payments/settings → { mode }
 * POST /api/web-payments/settings { mode: 'off' | 'manual' | 'auto' } — admin only.
 *
 * off    nothing is charged or cancelled (registrations are still stored, and
 *        the tech chat is told when a payment falls due)
 * manual due charges wait for "Charge now" in the drawer; nothing is cancelled
 * auto   the full timeline, including the cancellation after two declines
 */
import { NextRequest, NextResponse } from 'next/server';
import type { WebPaymentMode } from '@/types/webPayment';
import { requireRole } from '@/utils/authGuard';
import { escapeHtml, sendTechnicalAlert } from '@/utils/telegram';
import { readWebPaymentMode, writeWebPaymentMode } from '@/utils/webPayments/deps';

export const dynamic = 'force-dynamic';

export async function GET() {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;
  return NextResponse.json({ mode: await readWebPaymentMode() });
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;
  const body = (await req.json().catch(() => null)) as { mode?: string } | null;
  const mode = body?.mode as WebPaymentMode | undefined;
  if (mode !== 'off' && mode !== 'manual' && mode !== 'auto') {
    return NextResponse.json({ error: 'mode must be off, manual or auto' }, { status: 400 });
  }
  const before = await readWebPaymentMode();
  await writeWebPaymentMode(mode, guard.email);
  if (before !== mode) {
    await sendTechnicalAlert(`⚙️ <b>Pay later mode</b>: ${before} → <b>${mode}</b> (${escapeHtml(guard.email)})`).catch(() => {});
  }
  return NextResponse.json({ ok: true, mode });
}

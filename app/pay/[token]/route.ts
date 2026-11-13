/**
 * GET /pay/<token> — the guest's pay-later payment link (in every pay-later
 * email). Never a raw Stripe URL: Stripe pages expire after 24 h, this link
 * works until the booking is paid or cancelled.
 *
 * Each visit checks the booking first (already paid? cancelled? a charge
 * running right now?) and only then opens — or reuses — a Stripe Checkout
 * page for exactly the agreed amount. Back from Stripe (`?done=1&session_id=`)
 * the payment is confirmed straight from Stripe, not from the webhook.
 * Engine: utils/webPayments/engine.ts → openPayLink.
 *
 * Public: exempt from the auth middleware in proxy.ts (`pay/`). The token is
 * 24 random bytes; it can only pay this one booking or see its status.
 */
import { NextRequest, NextResponse } from 'next/server';
import { webPaymentsIo } from '@/utils/webPayments/deps';
import { openPayLink } from '@/utils/webPayments/engine';
import { renderPayPage } from '@/utils/webPayments/payPage';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Ctx = { params: Promise<{ token: string }> };

function page(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  });
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { token } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return page(renderPayPage('not_found'), 404);
  try {
    const result = await openPayLink(webPaymentsIo(), token, {
      sessionId: req.nextUrl.searchParams.get('session_id'),
      done: req.nextUrl.searchParams.get('done') === '1',
    });
    if (result.kind === 'redirect') return NextResponse.redirect(result.url, 303);
    return page(renderPayPage(result.page, result.row), result.page === 'not_found' ? 404 : 200);
  } catch (err) {
    console.error('[pay] link failed:', err);
    return page(renderPayPage('error'), 500);
  }
}

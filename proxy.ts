import { auth } from '@/auth';
import { NextResponse } from 'next/server';

// Local dev auth bypass: when DEV_ADMIN_EMAIL is set in .env.local, skip Google OAuth
const DEV_BYPASS = process.env.NODE_ENV === 'development' && !!process.env.DEV_ADMIN_EMAIL;

export default auth((req) => {
  const { nextUrl } = req;

  if (DEV_BYPASS) {
    // Redirect /login → / so the dev doesn't sit on an unreachable page
    if (nextUrl.pathname === '/login') {
      return NextResponse.redirect(new URL('/', nextUrl));
    }
    return NextResponse.next();
  }

  const isLoggedIn = !!req.auth;

  if (nextUrl.pathname === '/login') {
    if (isLoggedIn) return NextResponse.redirect(new URL('/', nextUrl));
    return NextResponse.next();
  }

  if (!isLoggedIn) {
    // Stakeholders reaching /occupancy get the minimal-scope viewer sign-in
    // (?view=1); everyone else gets the normal operator sign-in.
    const loginUrl = new URL('/login', nextUrl);
    if (nextUrl.pathname === '/occupancy' || nextUrl.pathname.startsWith('/occupancy/')) {
      loginUrl.searchParams.set('view', '1');
    }
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

export const config = {
  // Skip Next.js internals, static files, auth routes, Stripe webhook, public voucher endpoints, and public pages
  // (`share` = public occupancy snapshot pages, `api/public` = their read API).
  // `api/pricing/ingest` is exempt because its caller is the headless parity
  // runner on the operator's Mac — no session cookie, authenticated inside the
  // route by the PRICING_INGEST_SECRET header instead.
  //
  // `api/analytics/market/refresh` is exempt because Vercel cron requests
  // carry no session and were being 307'd to /login before the handler ran —
  // verified 2026-08-30: the 06:30 refresh never executed and the PriceLabs
  // snapshot only moved on manual runs. The route gates itself (x-vercel-cron
  // header, which Vercel reserves, or admin/super session). The OTHER cron
  // routes (scheduled payments, due invoices, review checks) are still behind
  // the middleware and therefore still dormant — unblocking those is a
  // business decision, not a plumbing one.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/auth|api/webhook|api/stripe/webhook|api/vouchers/validate|api/vouchers/redeem|payment-success|share|api/public|api/pricing/ingest|api/analytics/market/refresh).*)'],
};

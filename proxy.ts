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
  // Cron routes are exempt because Vercel cron requests carry no session and
  // were being 307'd to /login before the handler ran. Each re-gates itself via
  // utils/cronAuth.
  //
  // ⚠️ That gate is only as strong as CRON_SECRET. `x-vercel-cron` and the cron
  // user-agent are NOT stripped from external requests — a one-line curl forges
  // either — so with no secret configured these paths are effectively open to
  // anyone who knows the header name. When CRON_SECRET is set, Vercel sends
  // `Authorization: Bearer <secret>` and cronAuth requires it, refusing the
  // forgeable signals. Exempting a path here means removing the ONLY session
  // check in front of it, so weigh what the route does before adding one.
  //   - `api/analytics/market/refresh` — verified 2026-08-30: the 06:30 refresh
  //     never executed and the PriceLabs snapshot only moved on manual runs.
  //   - `api/cron/send-due-invoices` + `api/cron/check-reviews` — same bug,
  //     found 2026-09-28 when three past-stay invoices with complete details
  //     sat unsent: the 09:00 job had never once reached its handler, so the
  //     chat agent's whole collect-then-invoice flow dead-ended at the last
  //     step. Diagnosed by the 307-vs-401 difference against market/refresh.
  //     NOTE: exempting them was necessary but NOT sufficient — they were
  //     POST-only and Vercel invokes cron paths with GET, so they kept
  //     answering 405 to every run. Fixed 2026-09-30. A route added here must
  //     export GET, or it stays just as dead and looks reachable.
  //
  // `api/cron/send-scheduled-payments` is DELIBERATELY still behind the
  // middleware. It charges guests and emails them, it has never run in
  // production, and switching it on is a business decision that wants its own
  // review — list it here only after that happens. This is why the exemptions
  // are per-path rather than a blanket `api/cron`: a prefix would have turned
  // it on silently.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/auth|api/webhook|api/stripe/webhook|api/vouchers/validate|api/vouchers/redeem|payment-success|share|api/public|api/pricing/ingest|api/analytics/market/refresh|api/cron/send-due-invoices|api/cron/check-reviews).*)'],
};

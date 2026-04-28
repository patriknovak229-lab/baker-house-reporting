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
    return NextResponse.redirect(new URL('/login', nextUrl));
  }

  return NextResponse.next();
});

export const config = {
  // Skip Next.js internals, static files, auth routes, Stripe webhook, public voucher endpoints, and public pages
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/auth|api/webhook|api/stripe/webhook|api/vouchers/validate|api/vouchers/redeem|payment-success).*)'],
};

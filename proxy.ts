import { auth } from '@/auth';
import { NextResponse } from 'next/server';

export default auth((req) => {
  const { nextUrl } = req;
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
  // Skip Next.js internals, static files, auth routes, Stripe webhook, and public pages
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/auth|api/webhook|api/stripe/webhook|payment-success).*)'],
};

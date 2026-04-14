export { auth as default } from '@/auth';

export const config = {
  matcher: [
    /*
     * Protect all routes EXCEPT:
     * - /login (sign-in page)
     * - /payment-success (public guest page)
     * - /api/stripe/webhook (Stripe calls this — no session available)
     * - /_next/* (Next.js internals)
     * - /favicon.ico, static files
     */
    '/((?!login|payment-success|api/stripe/webhook|_next/static|_next/image|favicon.ico).*)',
  ],
};

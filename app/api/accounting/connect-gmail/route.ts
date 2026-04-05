import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';

const STATE_KEY = 'baker:gmail-oauth-state';
const STATE_TTL = 600; // 10 minutes

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function getOAuthClient() {
  const clientId = process.env.AUTH_GOOGLE_ID;
  const clientSecret = process.env.AUTH_GOOGLE_SECRET;
  const appUrl = (process.env.NEXTAUTH_URL ?? process.env.AUTH_URL ?? '').replace(/\/$/, '');
  if (!clientId || !clientSecret || !appUrl) return null;
  const redirectUri = `${appUrl}/api/accounting/connect-gmail/callback`;
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/** GET /api/accounting/connect-gmail
 *  Initiates the OAuth flow for the invoice Gmail account.
 *  Admin only — redirects to Google's consent page. */
export async function GET() {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  const oauth2 = getOAuthClient();
  if (!oauth2) {
    return NextResponse.json(
      { error: 'AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET / NEXTAUTH_URL not configured' },
      { status: 503 }
    );
  }

  // Generate and store a CSRF state token (10-minute TTL)
  const state = crypto.randomUUID();
  await redis.set(STATE_KEY, state, { ex: STATE_TTL });

  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',           // force refresh_token to be returned
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    login_hint: 'truthseeker.sro@gmail.com',
    state,
  });

  return NextResponse.redirect(url);
}

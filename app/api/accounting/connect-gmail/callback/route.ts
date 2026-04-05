import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import { Redis } from '@upstash/redis';

const STATE_KEY = 'baker:gmail-oauth-state';
const TOKEN_KEY = 'baker:gmail-invoice-token';

export interface GmailInvoiceToken {
  refreshToken: string;
  email: string;
  connectedAt: string;
}

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

function redirectWithError(appUrl: string, message: string) {
  return NextResponse.redirect(`${appUrl}?gmailError=${encodeURIComponent(message)}`);
}

/** GET /api/accounting/connect-gmail/callback
 *  Google redirects here after the user grants access.
 *  Exchanges the code for tokens and stores the refresh token in Redis. */
export async function GET(request: Request) {
  const appUrl = (process.env.NEXTAUTH_URL ?? process.env.AUTH_URL ?? '').replace(/\/$/, '');
  const { searchParams } = new URL(request.url);

  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  if (error) return redirectWithError(appUrl, `Google OAuth error: ${error}`);
  if (!code) return redirectWithError(appUrl, 'Missing OAuth code');

  const redis = getRedis();
  if (!redis) return redirectWithError(appUrl, 'Redis not configured');

  // Verify CSRF state
  const storedState = await redis.get(STATE_KEY);
  if (!storedState || storedState !== state) {
    return redirectWithError(appUrl, 'Invalid OAuth state — please try again');
  }
  await redis.del(STATE_KEY);

  const oauth2 = getOAuthClient();
  if (!oauth2) return redirectWithError(appUrl, 'OAuth client not configured');

  // Exchange code for tokens
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    return redirectWithError(
      appUrl,
      'No refresh token returned. The account may already be connected — try disconnecting first.'
    );
  }

  // Fetch the email address of the connected account
  oauth2.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const email = profile.data.emailAddress ?? 'unknown';

  // Persist the token
  const tokenData: GmailInvoiceToken = {
    refreshToken: tokens.refresh_token,
    email,
    connectedAt: new Date().toISOString(),
  };
  await redis.set(TOKEN_KEY, tokenData);

  // Redirect back to the app
  return NextResponse.redirect(`${appUrl}?gmailConnected=1`);
}

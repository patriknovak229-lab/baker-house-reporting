import { headers } from 'next/headers';
import { getToken } from 'next-auth/jwt';

/**
 * The signed-in operator's Google refresh token (Drive uploads / scans), read
 * server-side from the encrypted session cookie.
 *
 * It is deliberately NOT on the session object: whatever auth.ts's session
 * callback returns is also served to the browser by /api/auth/session, and this
 * token carries Gmail-read + full Drive access. Route handlers call this
 * instead of reading `session.refreshToken`.
 */
export async function getGoogleRefreshToken(): Promise<string | undefined> {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) return undefined;
  const req = { headers: new Headers(await headers()) };
  // The cookie is `__Secure-authjs.session-token` over https and
  // `authjs.session-token` over http, and its name is also the decryption
  // salt, so try both rather than guess the protocol.
  for (const secureCookie of [true, false]) {
    const token = await getToken({ req, secret, secureCookie });
    if (token) return typeof token.refreshToken === 'string' ? token.refreshToken : undefined;
  }
  return undefined;
}

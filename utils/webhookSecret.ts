/**
 * Shared gate for the Beds24 webhooks (`/api/webhook/beds24-message`,
 * `/api/webhook/new-booking`) and for our own nudges into them.
 *
 * Both paths are exempt from the auth middleware (proxy.ts excludes
 * `api/webhook`), so this secret is the only thing in front of them. Beds24
 * cannot send custom headers, so it rides in the URL: `?secret=<WEBHOOK_SECRET>`.
 * Every caller has to carry it — the Beds24 webhook URL, the external
 * cron-job.org ping, and the in-app nudges (utils/autoReplyNudge) — or it gets
 * a 401 the moment the secret is set.
 *
 * While WEBHOOK_SECRET is unset the routes stay open and say so in the logs,
 * so the secret can be rolled out without a window where Beds24 is locked out:
 * add `?secret=` to every caller first, then set the env var and redeploy.
 */

import { timingSafeEqual } from 'crypto';
import { NextResponse, type NextRequest } from 'next/server';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Returns a 401 response to send back, or null when the request may proceed. */
export function rejectBadWebhookSecret(req: NextRequest, route: string): NextResponse | null {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    console.warn(`[${route}] WEBHOOK_SECRET is not set — this public webhook accepts any caller.`);
    return null;
  }
  const provided = req.nextUrl.searchParams.get('secret') ?? '';
  if (!safeEqual(provided, secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

/** Appends `?secret=` to one of our webhook URLs when WEBHOOK_SECRET is set. */
export function withWebhookSecret(url: string): string {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return url;
  const u = new URL(url);
  u.searchParams.set('secret', secret);
  return u.toString();
}

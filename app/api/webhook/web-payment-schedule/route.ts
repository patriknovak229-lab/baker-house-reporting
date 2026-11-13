/**
 * POST /api/webhook/web-payment-schedule — the rental site registers a
 * pay-later booking right after creating it in Beds24 (card saved, 0 Kč
 * charged). Contract: Projects/PayLater/contract.md §5.
 *
 * Idempotent: the same booking (or the same card-saving session) twice is a
 * no-op that answers `created: false`. Works in every pay-later mode — only
 * charging depends on the mode — so no booking is ever lost while it's off.
 *
 * AUTH: the shared secret in `x-web-booking-secret` (WEB_BOOKING_ALERT_SECRET,
 * same as /api/webhook/web-booking-warning); the card is then checked in
 * Stripe (it must sit on the named customer). Public in proxy.ts through the
 * `api/webhook` exclusion.
 */
import { timingSafeEqual } from 'node:crypto';
import { after, NextRequest, NextResponse } from 'next/server';
import { parseRegistration, registerSchedule } from '@/utils/webPayments/engine';
import { webPaymentsIo } from '@/utils/webPayments/deps';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function secretMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const expected = process.env.WEB_BOOKING_ALERT_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'WEB_BOOKING_ALERT_SECRET is not configured on the server.' }, { status: 503 });
  }
  if (!secretMatches(req.headers.get('x-web-booking-secret'), expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = parseRegistration(body);
  if (!parsed.ok) return NextResponse.json({ error: `Invalid field: ${parsed.error}` }, { status: 400 });

  try {
    // Answer as soon as the schedule is stored; the email + tech-chat line run
    // after the response (awaited inside after(), never fire-and-forget). A
    // failed email is re-sent by the charge job.
    const result = await registerSchedule(webPaymentsIo(), parsed.input, 'website', 'website', { notify: 'defer' });
    if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
    const notify = result.notify;
    if (notify) {
      after(async () => {
        await notify().catch((err) => console.error('[web-payment-schedule] notification failed:', err));
      });
    }
    return NextResponse.json({ ok: true, scheduleId: result.scheduleId, created: result.created });
  } catch (err) {
    console.error('[web-payment-schedule] registration failed:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Registration failed' }, { status: 500 });
  }
}

/**
 * GET /api/bookings/mirror-health
 *
 * On-demand version of the daily archive heartbeat — the same check the 09:00
 * cron runs, so you can answer "is Postgres keeping up with Redis?" without
 * waiting for tomorrow's Telegram message.
 *
 * `persist: false` deliberately: this must not move the row-count baseline the
 * cron compares against, or a manual look could mask a real shrink.
 *
 * Admin-only — it reports storage internals and sample reservation numbers.
 */
import { NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { checkBookingsMirrorHealth } from '@/utils/bookingsMirrorHealth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  try {
    const health = await checkBookingsMirrorHealth({ persist: false });
    return NextResponse.json(health);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Health check failed' },
      { status: 500 },
    );
  }
}

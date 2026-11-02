/**
 * POST /api/webhook/web-booking-warning — the rental site reports a web booking
 * Beds24 saved WITH warnings. The booking stands and the guest has their
 * confirmation; this only puts a "check it in Beds24" task on BH-<id>, which
 * shows under Pending tasks. Not urgent, so no Telegram.
 *
 * Body: { bookingId: number | string, warning: string }
 *
 * AUTH: a shared secret in the `x-web-booking-secret` header — WEB_BOOKING_ALERT_SECRET
 * on both sides (same pattern as /api/pricing/ingest). The path is public in
 * proxy.ts via the `api/webhook` exclusion.
 */
import { NextRequest, NextResponse } from 'next/server';
import type { Issue } from '@/types/reservation';
import { pragueToday } from '@/utils/periodUtils';
import { readAllReservationOverrides, writeAllReservationOverrides } from '@/utils/reservationOverridesStore';
import {
  appendWebBookingWarningIssue,
  buildWebBookingWarningIssue,
  parseWebBookingId,
} from '@/utils/webBookingWarning';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const expected = process.env.WEB_BOOKING_ALERT_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: 'WEB_BOOKING_ALERT_SECRET is not configured on the server.' },
      { status: 503 },
    );
  }
  if (req.headers.get('x-web-booking-secret') !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { bookingId?: unknown; warning?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const bookingId = parseWebBookingId(body.bookingId);
  if (!bookingId) {
    return NextResponse.json({ error: 'bookingId must be a Beds24 booking id' }, { status: 400 });
  }
  const warning = typeof body.warning === 'string' ? body.warning : '';

  const reservationNumber = `BH-${bookingId}`;
  const overrides = await readAllReservationOverrides<{ issues?: Issue[] }>();
  const current = overrides[reservationNumber] ?? {};
  const issues: Issue[] = Array.isArray(current.issues) ? current.issues : [];
  const next = appendWebBookingWarningIssue(
    issues,
    buildWebBookingWarningIssue(bookingId, warning, pragueToday(), new Date().toISOString()),
  );
  if (!next) return NextResponse.json({ ok: true, skipped: 'already reported' });

  overrides[reservationNumber] = { ...current, issues: next };
  await writeAllReservationOverrides(overrides);
  return NextResponse.json({ ok: true, reservationNumber });
}

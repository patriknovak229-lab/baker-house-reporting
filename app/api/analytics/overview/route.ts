/**
 * GET /api/analytics/overview?from&to&rooms&channels
 *
 * Reservation, monetary and room performance on the STAY basis, plus the forward
 * on-the-books position. Reads only `public.bookings_mirror` — no Beds24 call, no
 * Redis, so opening this page cannot slow the operational tabs down or burn API
 * credits.
 */
import { NextResponse } from 'next/server';
import { readOverview } from '@/data-access/analytics/overview';
import { analyticsError, parseAnalyticsRequest } from '../scope';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const parsed = await parseAnalyticsRequest(request);
  if ('error' in parsed) return parsed.error;
  try {
    return NextResponse.json(await readOverview(parsed.scope, parsed.todayIso));
  } catch (err) {
    return analyticsError(err);
  }
}

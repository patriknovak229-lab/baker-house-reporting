/**
 * GET /api/analytics/web-funnel?from&to
 *
 * The rental site's own anonymous funnel counts, real Direct-Web bookings and the GA4
 * traffic-source sample, all on the EVENT-date basis. ADMIN ONLY (new tabs default to
 * admin). Room and channel filters do not apply: the funnel is the website's, and the
 * beacons carry Beds24 room ids rather than physical rooms.
 *
 * Postgres only — see `data-access/analytics/webFunnel.ts`.
 */
import { NextResponse } from 'next/server';
import { readWebFunnel } from '@/data-access/analytics/webFunnel';
import { analyticsError, parseAnalyticsRequest } from '../scope';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const parsed = await parseAnalyticsRequest(request, ['admin']);
  if ('error' in parsed) return parsed.error;
  try {
    return NextResponse.json(await readWebFunnel(parsed.scope.from, parsed.scope.to, parsed.todayIso));
  } catch (err) {
    return analyticsError(err);
  }
}

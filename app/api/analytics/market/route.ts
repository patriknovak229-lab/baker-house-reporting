/**
 * GET /api/analytics/market?from&to&rooms&channels
 *
 * Our position against the Brno comp set: MPI by horizon, market occupancy and
 * ADR by month, market asking-price percentiles per night, and the market booking
 * window against ours.
 *
 * Reads ONLY the local `market_*` snapshot tables plus `bookings_mirror` — never
 * PriceLabs. The snapshot is written by the sibling `refresh` route on a daily
 * cron, so the slowest external dependency in the app can never sit on the
 * critical path of a page load. A missing or stale snapshot degrades the response
 * (market fields go null, `meta` says why) instead of failing it.
 */
import { NextResponse } from 'next/server';
import { readMarket } from '@/data-access/analytics/market';
import { analyticsError, parseAnalyticsRequest } from '../scope';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const parsed = await parseAnalyticsRequest(request);
  if ('error' in parsed) return parsed.error;
  try {
    return NextResponse.json(await readMarket(parsed.scope, parsed.todayIso));
  } catch (err) {
    return analyticsError(err);
  }
}

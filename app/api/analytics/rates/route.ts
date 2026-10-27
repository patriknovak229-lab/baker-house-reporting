/**
 * GET /api/analytics/rates?from&to&rooms&channels
 *
 * Gross profit by rate plan, promotion and channel, per room class (1KK / 2KK):
 * do the plans make sense, are the time-limited deals working, are cancelled
 * nights resold and at what price, is direct priced too cheap. Plus the far-out
 * premium test, Genius penetration and the length-of-stay mix.
 *
 * STAY basis for money, booking grain for per-booking averages, so a seven-night
 * stay does not count seven times in "average length of stay".
 */
import { NextResponse } from 'next/server';
import { readRates } from '@/data-access/analytics/rates';
import { analyticsError, parseAnalyticsRequest } from '../scope';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const parsed = await parseAnalyticsRequest(request);
  if ('error' in parsed) return parsed.error;
  try {
    return NextResponse.json(await readRates(parsed.scope, parsed.todayIso));
  } catch (err) {
    return analyticsError(err);
  }
}

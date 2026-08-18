/**
 * GET /api/analytics/rates?from&to&rooms&channels
 *
 * What the ADR is made of: rate-plan families, OTA promotions, channel mix, Genius
 * penetration, length-of-stay mix, and achieved ADR by lead time — the test of
 * whether the pricing engine's far-out premium is actually being paid.
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
    return NextResponse.json(await readRates(parsed.scope));
  } catch (err) {
    return analyticsError(err);
  }
}

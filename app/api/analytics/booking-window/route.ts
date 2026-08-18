/**
 * GET /api/analytics/booking-window?from&to&rooms&channels
 *
 * Lead-time distribution, the reconstructed booking curve, and cancellation
 * analysis on the BOOKED basis. See `data-access/analytics/bookingWindow.ts` for
 * how the curve is replayed from `reservation_date` + Beds24's `cancelTime`
 * without any snapshot table.
 */
import { NextResponse } from 'next/server';
import { readBookingWindow } from '@/data-access/analytics/bookingWindow';
import { analyticsError, parseAnalyticsRequest } from '../scope';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const parsed = await parseAnalyticsRequest(request);
  if ('error' in parsed) return parsed.error;
  try {
    return NextResponse.json(await readBookingWindow(parsed.scope, parsed.todayIso));
  } catch (err) {
    return analyticsError(err);
  }
}

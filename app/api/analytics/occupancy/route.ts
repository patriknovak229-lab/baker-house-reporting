/**
 * GET /api/analytics/occupancy?from&to&rooms&channels
 *
 * How full the property runs, on the STAY basis: month totals, the month x
 * sellable-unit grid, weekday performance both raw and transient-only, calendar
 * compression, and named-event impact.
 *
 * "Sellable unit" rather than "room" is the headline grain on purpose — Beds24
 * decides which of the interchangeable Urban studios a booking lands in, so
 * per-room occupancy measures the allocator and not demand. Per-room is still in
 * the response, as detail.
 */
import { NextResponse } from 'next/server';
import { readOccupancy } from '@/data-access/analytics/occupancy';
import { readAnalyticsMeta } from '@/data-access/analytics/meta';
import { analyticsError, parseAnalyticsRequest } from '../scope';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const parsed = await parseAnalyticsRequest(request);
  if ('error' in parsed) return parsed.error;
  try {
    // Completeness drives the confidence note the section renders, so it has to
    // come from the same read rather than being guessed from the filter window.
    const meta = await readAnalyticsMeta(parsed.todayIso);
    return NextResponse.json(
      await readOccupancy(parsed.scope, parsed.todayIso, meta.coverage.completeMonths),
    );
  } catch (err) {
    return analyticsError(err);
  }
}

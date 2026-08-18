/**
 * GET /api/analytics/costs?from&to&rooms&channels
 *
 * Variable costs, platform commission, per-stay-length economics and the OTA
 * settlement cross-check.
 *
 * The ONE analytics endpoint that touches Redis: the cleaning app's rate cards
 * (cleaner fees, laundry per-set prices, subscriptions, wear & tear) have not
 * migrated to Postgres, so a cost figure cannot be computed in SQL today. It runs
 * on a single tab, on demand.
 */
import { NextResponse } from 'next/server';
import { readCosts } from '@/data-access/analytics/costs';
import { analyticsError, parseAnalyticsRequest } from '../scope';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
// The cost engine fans out across ~14 Redis reads plus Postgres; the default
// serverless budget is tight for the widest windows.
export const maxDuration = 60;

export async function GET(request: Request) {
  const parsed = await parseAnalyticsRequest(request);
  if ('error' in parsed) return parsed.error;
  try {
    return NextResponse.json(await readCosts(parsed.scope, parsed.todayIso));
  } catch (err) {
    return analyticsError(err);
  }
}

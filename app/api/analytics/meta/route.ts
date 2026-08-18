/**
 * GET /api/analytics/meta
 *
 * Data-coverage envelope: archive freshness, trading window, and the caveats the
 * UI renders as a banner. Loaded first and independently of the sections so the
 * page can warn about stale or thin data before any chart draws.
 */
import { NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { pragueToday } from '@/utils/periodUtils';
import { readAnalyticsMeta } from '@/data-access/analytics/meta';
import { ANALYTICS_ROLES } from '@/utils/roles';
import { analyticsError } from '../scope';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const guard = await requireRole(ANALYTICS_ROLES);
  if ('error' in guard) return guard.error;
  try {
    return NextResponse.json(await readAnalyticsMeta(pragueToday()));
  } catch (err) {
    return analyticsError(err);
  }
}

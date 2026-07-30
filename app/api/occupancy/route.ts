/**
 * Stakeholder occupancy API (PII-free).
 *
 *   GET  ?start&end — read the occupancy cache ONLY (never touches Beds24) and
 *                     return the occupied/free grid + occupancy %s for the range.
 *   POST ?start&end — the "Sync" button: pull fresh bookings, recompute the
 *                     whole-horizon grid, cache it, and return the range.
 *
 * The response never contains guest, reservation, channel, price or payment
 * data — only booleans + percentages (see types/occupancyBoard.ts). Occupancy
 * is derived via the SAME computeSnapshotData the public snapshot uses, over
 * the SAME reservation set the dashboard builds (buildReservationSet), so it
 * can't drift from either. Range math lives in utils/occupancyBoard.ts.
 *
 * Access: every valid role (admin/super/viewer/accountant/occupancy).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { OCCUPANCY_VIEW_ROLES } from '@/utils/roles';
import { getRedis, buildReservationSet } from '@/utils/beds24Reservations';
import { computeSnapshotData } from '@/utils/occupancySnapshot';
import { ALL_ROOMS_BY_CATEGORY } from '@/utils/roomCategory';
import { horizonRange, resolveRange, computeBoard, type OccupancyCache } from '@/utils/occupancyBoard';
import type { OccupancyResponse } from '@/types/occupancyBoard';

export const dynamic = 'force-dynamic';

const OCCUPANCY_CACHE_KEY = 'baker:occupancy-cache';
const ROOMS: string[] = [...ALL_ROOMS_BY_CATEGORY];

export async function GET(req: NextRequest) {
  const guard = await requireRole(OCCUPANCY_VIEW_ROLES);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Storage unavailable' }, { status: 500 });

  const horizon = horizonRange();
  const cache = await redis.get<OccupancyCache>(OCCUPANCY_CACHE_KEY);
  if (!cache) {
    const body: OccupancyResponse = { neverSynced: true, syncedAt: null, horizon, board: null };
    return NextResponse.json(body);
  }

  const range = resolveRange(req.nextUrl.searchParams.get('start'), req.nextUrl.searchParams.get('end'), horizon);
  if ('error' in range) return NextResponse.json({ error: range.error }, { status: 400 });

  const body: OccupancyResponse = {
    neverSynced: false,
    syncedAt: cache.syncedAt,
    horizon,
    board: computeBoard(cache, range.start, range.end),
  };
  return NextResponse.json(body);
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(OCCUPANCY_VIEW_ROLES);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Storage unavailable' }, { status: 500 });

  const horizon = horizonRange();
  const range = resolveRange(req.nextUrl.searchParams.get('start'), req.nextUrl.searchParams.get('end'), horizon);
  if ('error' in range) return NextResponse.json({ error: range.error }, { status: 400 });

  // Pull fresh bookings (delta sync, throttled by fetchAllBookings) and rebuild
  // the whole-horizon PII-free grid via the same math the public snapshot uses.
  let snapshot;
  try {
    const reservations = await buildReservationSet({ fullSync: false });
    snapshot = computeSnapshotData(
      reservations,
      ROOMS,
      { start: horizon.start, end: horizon.end },
      { includeGrossSales: false, label: '' },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sync failed';
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const cache: OccupancyCache = {
    syncedAt: new Date().toISOString(),
    rooms: ROOMS,
    dates: snapshot.calendar.dates,
    perRoom: snapshot.calendar.perRoom,
  };
  await redis.set(OCCUPANCY_CACHE_KEY, cache);

  const body: OccupancyResponse = {
    neverSynced: false,
    syncedAt: cache.syncedAt,
    horizon,
    board: computeBoard(cache, range.start, range.end),
  };
  return NextResponse.json(body);
}

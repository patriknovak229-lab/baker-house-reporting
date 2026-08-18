/**
 * Data-coverage envelope for the analytics section.
 *
 * Deliberately the FIRST thing the page loads and renders. Analytics reads a
 * derived archive rather than live Beds24, and a chart that silently shows
 * yesterday's book is worse than one that admits it — so freshness, coverage and
 * the known gaps are part of the payload, not a footnote.
 */
import { sql } from 'drizzle-orm';
import type { AnalyticsMeta } from '@/utils/analyticsTypes';
import { PHYSICAL_ROOMS, TEST_BOOKING_PREDICATE, n, query } from './shared';

interface MetaRow {
  bookings: number;
  blackouts: number;
  excluded_tests: number;
  unallocated: number;
  last_synced_at: string | null;
  first_check_in: string | null;
  last_check_in: string | null;
}

interface ChannelRow {
  channel: string;
}

/** Whole months of FINISHED stay data between two dates. */
function completeMonthsBetween(firstIso: string, todayIso: string): number {
  const [fy, fm] = firstIso.split('-').map(Number);
  const [ty, tm] = todayIso.split('-').map(Number);
  // The current month is still running, so it is not complete.
  return Math.max(0, (ty - fy) * 12 + (tm - fm));
}

export async function readAnalyticsMeta(todayIso: string): Promise<AnalyticsMeta> {
  const [rows, channels] = await Promise.all([
    query<MetaRow>(sql`
      SELECT
        COUNT(*) FILTER (
          WHERE source = 'beds24-booking' AND is_blackout = false AND ${TEST_BOOKING_PREDICATE}
        )::int                                                                          AS bookings,
        COUNT(*) FILTER (WHERE is_blackout = true OR source = 'inventory-override')::int AS blackouts,
        COUNT(*) FILTER (WHERE NOT (${TEST_BOOKING_PREDICATE}))::int                    AS excluded_tests,
        COUNT(*) FILTER (
          WHERE is_unallocated_vr = true AND is_cancelled = false AND ${TEST_BOOKING_PREDICATE}
        )::int                                                                          AS unallocated,
        to_char(MAX(synced_at), 'YYYY-MM-DD"T"HH24:MI:SSOF')                            AS last_synced_at,
        MIN(check_in_date) FILTER (WHERE ${TEST_BOOKING_PREDICATE})::text                AS first_check_in,
        MAX(check_in_date) FILTER (WHERE ${TEST_BOOKING_PREDICATE})::text                AS last_check_in
      FROM bookings_mirror b
    `),
    query<ChannelRow>(sql`
      SELECT DISTINCT channel
      FROM bookings_mirror
      WHERE source = 'beds24-booking'
      ORDER BY channel
    `),
  ]);

  const row = rows[0];
  const lastSynced = row?.last_synced_at ?? null;
  const stale = lastSynced
    ? Date.now() - new Date(lastSynced).getTime() > 24 * 60 * 60 * 1000
    : true;

  const firstCheckIn = row?.first_check_in ?? null;
  const completeMonths = firstCheckIn ? completeMonthsBetween(firstCheckIn, todayIso) : 0;

  const caveats: string[] = [];
  if (stale) {
    caveats.push(
      lastSynced
        ? `The bookings archive was last written ${lastSynced.slice(0, 10)}. Every figure below is as of then, not live. Set WRITE_BOOKINGS_MIRROR=true so each sync keeps it current.`
        : 'The bookings archive has never been written. Set WRITE_BOOKINGS_MIRROR=true and run a sync.',
    );
  }
  if (completeMonths < 12) {
    caveats.push(
      `Only ${completeMonths} complete month${completeMonths === 1 ? '' : 's'} of trading exist, so seasonality is indicative — there is no prior year to compare against yet.`,
    );
  }
  caveats.push(
    'Occupancy counts each room only from the date it first went on sale, so months before a room opened are not held against it.',
  );
  caveats.push(
    'Non-arrivals (cancelled in Beds24 but still charged) are excluded from revenue here; the Performance tab includes their retained value. Treat the two as answering different questions.',
  );
  const excludedTests = n(row?.excluded_tests);
  if (excludedTests > 0) {
    caveats.push(
      `${excludedTests} development test booking${excludedTests === 1 ? '' : 's'} (guest named "Test…") are excluded from every figure. Left in, they would put the direct-channel cancellation rate above 80%.`,
    );
  }
  const unallocated = n(row?.unallocated);
  if (unallocated > 0) {
    caveats.push(
      `${unallocated} booking${unallocated === 1 ? '' : 's'} sit on a virtual room Beds24 never allocated. They count in portfolio totals but are omitted from per-room tables.`,
    );
  }

  return {
    mirrorLastSyncedAt: lastSynced,
    mirrorStale: stale,
    rows: { bookings: n(row?.bookings), blackouts: n(row?.blackouts) },
    coverage: {
      firstCheckIn,
      lastCheckIn: row?.last_check_in ?? null,
      completeMonths,
      partialYear: completeMonths < 12,
    },
    rooms: PHYSICAL_ROOMS,
    channels: channels.map((c) => c.channel),
    caveats,
  };
}

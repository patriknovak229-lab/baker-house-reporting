/**
 * Web funnel — the reader behind the admin-only tab. Postgres only: the copy cron and
 * the GA sync fill the tables, a page load never calls Redis or Google.
 *
 * Basis is the EVENT date (when the search / step / booking happened), unlike the
 * stay-basis tabs. Real web bookings therefore come from `reservation_date`, so the
 * funnel's last step lines up with the searches that led to it.
 */
import { sql, type SQL } from 'drizzle-orm';
import type {
  WebDemandRow,
  WebFunnelDay,
  WebFunnelResponse,
  WebPartySizeRow,
  WebTrafficRow,
} from '@/utils/analyticsTypes';
import { dayList } from '@/utils/webFunnel';
import { TEST_BOOKING_PREDICATE, n, query } from './shared';
import { funnelKeyPrefix, funnelRedisConfigured, gaConfigured } from './webFunnelSync';

/** The rental site's channel in the bookings archive. */
const WEB_CHANNEL = 'Direct-Web';

const isoOrNull = (v: unknown) => (typeof v === 'string' && v ? v : null);

type Runner = <T>(statement: SQL) => Promise<T[]>;

/** `run` defaults to the app's Postgres; tests and offline checks pass their own. */
export async function readWebFunnel(
  from: string,
  to: string,
  todayIso: string,
  run: Runner = query,
): Promise<WebFunnelResponse> {
  const [metricRows, coverage, bookingRows, demandRows, partyRows, gaMeta, channelRows, sourceRows] =
    await Promise.all([
      run<{ day: string; metric: string; value: string }>(sql`
        SELECT day::text AS day, metric, value
        FROM web_funnel_daily
        WHERE day BETWEEN ${from}::date AND ${to}::date
      `),
      run<{ first_day: string | null; last_copied_at: string | null }>(sql`
        SELECT MIN(day)::text AS first_day,
               to_char(MAX(copied_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_copied_at
        FROM web_funnel_daily
      `),
      /* One row per reservation, not per room: a 2× combo is one booking. Abandoned
         Stripe sessions never reach Beds24 on this channel (the site books only after
         payment), so every cancellation here is a real one. */
      run<{ day: string; bookings: number; revenue: string; cancelled: number }>(sql`
        SELECT b.reservation_date::text                                        AS day,
               COUNT(*) FILTER (WHERE b.is_cancelled = false)::int             AS bookings,
               COALESCE(SUM(b.price::numeric) FILTER (WHERE b.is_cancelled = false), 0) AS revenue,
               COUNT(*) FILTER (WHERE b.is_cancelled = true)::int              AS cancelled
        FROM bookings_mirror b
        WHERE b.source = 'beds24-booking'
          AND b.channel = ${WEB_CHANNEL}
          AND b.is_blackout = false
          AND b.reservation_date BETWEEN ${from}::date AND ${to}::date
          AND ${TEST_BOOKING_PREDICATE}
        GROUP BY b.reservation_date
      `),
      run<{
        arrival: string;
        searches: number;
        none: number;
        avg_nights: string;
        avg_guests: string;
        max_guests: number;
      }>(sql`
        SELECT arrival::text                                   AS arrival,
               COUNT(*)::int                                   AS searches,
               COUNT(*) FILTER (WHERE kind = 'none')::int      AS none,
               AVG(nights)                                     AS avg_nights,
               AVG(adults + children)                          AS avg_guests,
               MAX(adults + children)::int                     AS max_guests
        FROM web_funnel_searches
        WHERE day BETWEEN ${from}::date AND ${to}::date
        GROUP BY arrival
        ORDER BY arrival
      `),
      run<{ guests: number; searches: number; none: number }>(sql`
        SELECT (adults + children)::int                   AS guests,
               COUNT(*)::int                              AS searches,
               COUNT(*) FILTER (WHERE kind = 'none')::int AS none
        FROM web_funnel_searches
        WHERE day BETWEEN ${from}::date AND ${to}::date
        GROUP BY 1
        ORDER BY 1
      `),
      run<{ last_fetched_at: string | null; first_day: string | null }>(sql`
        SELECT to_char(MAX(fetched_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_fetched_at,
               MIN(day)::text AS first_day
        FROM web_traffic_daily
      `),
      run<{ key: string; sessions: number; users: number; purchases: number; revenue: string }>(sql`
        SELECT channel_group AS key, SUM(sessions)::int AS sessions, SUM(total_users)::int AS users,
               SUM(purchases)::int AS purchases, SUM(purchase_revenue) AS revenue
        FROM web_traffic_daily
        WHERE day BETWEEN ${from}::date AND ${to}::date
        GROUP BY channel_group
        ORDER BY 2 DESC
      `),
      run<{ key: string; sessions: number; users: number; purchases: number; revenue: string }>(sql`
        SELECT source_medium AS key, SUM(sessions)::int AS sessions, SUM(total_users)::int AS users,
               SUM(purchases)::int AS purchases, SUM(purchase_revenue) AS revenue
        FROM web_traffic_daily
        WHERE day BETWEEN ${from}::date AND ${to}::date
        GROUP BY source_medium
        ORDER BY 2 DESC
        LIMIT 20
      `),
    ]);

  // Dense day list: a day with no searches is a real zero, and the charts need it.
  // It starts where counting started, so "all time" compares bookings only with
  // days that also have searches — web bookings from before the beacon went live
  // would otherwise read as conversions out of nowhere.
  const firstDay = coverage[0]?.first_day ?? null;
  const start = firstDay && firstDay > from ? firstDay : from;
  const end = to < todayIso ? to : todayIso;
  const byDay = new Map<string, WebFunnelDay>(
    dayList(start, end).map((day) => [day, { day, metrics: {}, bookings: 0, bookingsRevenue: 0, cancelled: 0 }]),
  );
  for (const r of metricRows) {
    const d = byDay.get(r.day);
    if (d) d.metrics[r.metric] = n(r.value);
  }
  for (const r of bookingRows) {
    const d = byDay.get(r.day);
    if (!d) continue;
    d.bookings = n(r.bookings);
    d.bookingsRevenue = n(r.revenue);
    d.cancelled = n(r.cancelled);
  }

  const demand: WebDemandRow[] = demandRows.map((r) => ({
    arrival: r.arrival,
    searches: n(r.searches),
    noAvailability: n(r.none),
    avgNights: n(r.avg_nights),
    avgGuests: n(r.avg_guests),
    maxGuests: n(r.max_guests),
  }));
  const partySize: WebPartySizeRow[] = partyRows.map((r) => ({
    guests: n(r.guests),
    searches: n(r.searches),
    noAvailability: n(r.none),
  }));
  const traffic = (rows: typeof channelRows): WebTrafficRow[] =>
    rows.map((r) => ({
      key: r.key,
      sessions: n(r.sessions),
      users: n(r.users),
      purchases: n(r.purchases),
      revenue: n(r.revenue),
    }));

  return {
    basis: 'event',
    from,
    to,
    todayIso,
    countingSince: firstDay,
    lastCopiedAt: isoOrNull(coverage[0]?.last_copied_at),
    copySource: { configured: funnelRedisConfigured(), prefix: funnelKeyPrefix() },
    days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    demand,
    partySize,
    ga: {
      configured: gaConfigured(),
      lastFetchedAt: isoOrNull(gaMeta[0]?.last_fetched_at),
      firstDay: isoOrNull(gaMeta[0]?.first_day),
      channels: traffic(channelRows),
      sourceMedium: traffic(sourceRows),
    },
  };
}

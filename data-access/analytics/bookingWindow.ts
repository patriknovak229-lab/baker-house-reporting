/**
 * Booking windows — how far ahead demand arrives, and how much of it survives.
 *
 * ATTRIBUTION: booked basis. Everything here is grouped by when the booking was
 * MADE or by how many days before arrival it was made, not by when the stay
 * happened. That is the opposite of the Overview section, and mixing the two is
 * the classic way a revenue dashboard starts contradicting itself, so the
 * `basis` field is on the response and the UI states it.
 *
 * THE BOOKING CURVE
 * -----------------
 * The centrepiece is a real booking curve: for each stay month, the share of its
 * final booked nights that were already on the books N days before the month
 * began. It is normally impossible without daily snapshots — but the archive
 * keeps `reservation_date` and Beds24's `cancelTime`, so the state of the book at
 * any past instant can be replayed (see `ASOF_NIGHTS_CTE`). That makes the curve
 * available retroactively, from day one, with no new write path.
 *
 * Its one blind spot: a booking that was later MODIFIED is replayed in its final
 * shape. Cancellations are exact, modifications are approximated.
 */
import { sql } from 'drizzle-orm';
import type {
  BookingCurvePoint,
  BookingCurveSeries,
  BookingHeatCell,
  BookingWindowResponse,
  CancellationAnalysis,
  LeadTimeBucket,
  LeadTimeTrendPoint,
} from '@/utils/analyticsTypes';
import {
  baseCtes,
  channelFilter,
  isPhysicalRoom,
  LEAD_BUCKETS,
  leadBucketCase,
  n,
  PHYSICAL_ROOMS,
  query,
  ratio,
  roomFilter,
  type AnalyticsScope,
} from './shared';

/**
 * Bookings in scope, on the BOOKED basis.
 *
 * A booking counts once (not once per linked room), attributed to its arrival
 * date falling inside the window. Arrival-date scoping — rather than
 * booking-date scoping — is what makes "how far ahead did people book the stays
 * we sold in this window?" answerable; the trend chart below re-groups the same
 * rows by booking month when the question flips.
 *
 * Cancelled bookings are INCLUDED here, flagged. Excluding them would compute a
 * lead-time distribution over survivors only, which systematically understates
 * how far ahead demand originally arrived.
 */
const BOOKINGS_CTE = (scope: AnalyticsScope) => sql`
  bookings AS (
    SELECT DISTINCT
      alloc.reservation_number,
      alloc.channel,
      alloc.check_in_date,
      alloc.check_out_date,
      alloc.reservation_date,
      alloc.booking_timestamp,
      alloc.is_cancelled,
      alloc.cancel_class,
      alloc.cancelled_at,
      alloc.span_nights,
      (alloc.check_in_date - alloc.reservation_date) AS lead_days,
      FIRST_VALUE(alloc.room) OVER (
        PARTITION BY alloc.reservation_number ORDER BY alloc.room
      ) AS primary_room,
      SUM(alloc.price) OVER (PARTITION BY alloc.reservation_number) AS booking_price
    FROM alloc
    WHERE alloc.is_blackout = false
      AND alloc.check_in_date BETWEEN ${scope.from}::date AND ${scope.to}::date
      AND ${roomFilter(sql`alloc.room`, scope)}
      AND ${channelFilter(sql`alloc.channel`, scope)}
  )
`;

// ── Lead-time distribution ───────────────────────────────────────────────────

interface LeadRow {
  label: string;
  bookings: number;
  cancelled: number;
  nights: number;
  gbv: number;
}

async function readLeadTime(scope: AnalyticsScope): Promise<LeadTimeBucket[]> {
  const rows = await query<LeadRow>(sql`
    ${baseCtes(scope)},
    ${BOOKINGS_CTE(scope)}
    SELECT
      ${leadBucketCase(sql`bookings.lead_days`)}                    AS label,
      COUNT(*)::int                                                 AS bookings,
      COUNT(*) FILTER (WHERE bookings.is_cancelled)::int            AS cancelled,
      COALESCE(SUM(bookings.span_nights) FILTER (WHERE NOT bookings.is_cancelled), 0)::int  AS nights,
      COALESCE(SUM(bookings.booking_price) FILTER (WHERE NOT bookings.is_cancelled), 0)::float8 AS gbv
    FROM bookings
    WHERE bookings.lead_days IS NOT NULL
    GROUP BY 1
  `);

  const byLabel = new Map(rows.map((r) => [r.label, r]));
  const total = rows.reduce((acc, r) => acc + n(r.bookings), 0);

  return LEAD_BUCKETS.map<LeadTimeBucket>((b) => {
    const r = byLabel.get(b.label);
    const bookings = n(r?.bookings);
    const nights = n(r?.nights);
    const gbv = n(r?.gbv);
    return {
      label: b.label,
      minDays: b.min,
      maxDays: b.max,
      bookings,
      nights,
      gbv,
      adr: ratio(gbv, nights),
      share: ratio(bookings, total),
      cancellationRate: ratio(n(r?.cancelled), bookings),
    };
  });
}

// ── Summary ──────────────────────────────────────────────────────────────────

interface SummaryRow {
  bookings: number;
  avg_lead: number | null;
  median_lead: number | null;
  p90_lead: number | null;
  last_minute: number;
  early_bird: number;
}

async function readSummary(scope: AnalyticsScope): Promise<BookingWindowResponse['summary']> {
  const rows = await query<SummaryRow>(sql`
    ${baseCtes(scope)},
    ${BOOKINGS_CTE(scope)}
    SELECT
      COUNT(*)::int                                                             AS bookings,
      AVG(lead_days)::float8                                                    AS avg_lead,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY lead_days)::float8             AS median_lead,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY lead_days)::float8             AS p90_lead,
      COUNT(*) FILTER (WHERE lead_days <= 7)::int                               AS last_minute,
      COUNT(*) FILTER (WHERE lead_days >= 60)::int                              AS early_bird
    FROM bookings
    WHERE lead_days IS NOT NULL
  `);
  const r = rows[0];
  const bookings = n(r?.bookings);
  return {
    bookings,
    avgLeadDays: n(r?.avg_lead),
    medianLeadDays: n(r?.median_lead),
    p90LeadDays: n(r?.p90_lead),
    lastMinuteShare: ratio(n(r?.last_minute), bookings),
    earlyBirdShare: ratio(n(r?.early_bird), bookings),
  };
}

// ── Booking curve ────────────────────────────────────────────────────────────

/** Lead-time checkpoints the curve is sampled at, furthest out first. */
const CURVE_CHECKPOINTS = [120, 90, 75, 60, 45, 30, 21, 14, 10, 7, 5, 3, 2, 1, 0];

interface CurveRow {
  month: string;
  month_start: string;
  days_before: number;
  nights: number;
  final_nights: number;
}

async function readCurves(scope: AnalyticsScope, todayIso: string): Promise<BookingCurveSeries[]> {
  const checkpointValues = sql.join(
    CURVE_CHECKPOINTS.map((d) => sql`(${d}::int)`),
    sql`, `,
  );

  const rows = await query<CurveRow>(sql`
    ${baseCtes(scope)},
    months AS (
      SELECT DISTINCT date_trunc('month', stay_date)::date AS month_start
      FROM asof_nights
      WHERE stay_date BETWEEN ${scope.from}::date AND ${scope.to}::date
    ),
    checkpoints AS (SELECT * FROM (VALUES ${checkpointValues}) AS v(days_before)),
    /* Final (or current) booked nights per month — the curve's 100% line. */
    finals AS (
      SELECT
        date_trunc('month', a.stay_date)::date AS month_start,
        COUNT(*)::int                          AS final_nights
      FROM asof_nights a
      WHERE a.is_cancelled = false
        AND a.stay_date BETWEEN ${scope.from}::date AND ${scope.to}::date
        AND ${roomFilter(sql`a.room`, scope)}
        AND ${channelFilter(sql`a.channel`, scope)}
      GROUP BY 1
    )
    SELECT
      to_char(m.month_start, 'YYYY-MM')   AS month,
      m.month_start::text                 AS month_start,
      c.days_before                       AS days_before,
      (
        /* The book as it stood days_before days ahead of the month starting:
           booked by then, and not yet cancelled at that moment. */
        SELECT COUNT(*)::int
        FROM asof_nights a
        WHERE a.stay_date >= m.month_start
          AND a.stay_date <  (m.month_start + INTERVAL '1 month')
          AND a.booked_on <= (m.month_start - c.days_before)
          AND (a.cancelled_at IS NULL OR a.cancelled_at::date > (m.month_start - c.days_before))
          AND ${roomFilter(sql`a.room`, scope)}
          AND ${channelFilter(sql`a.channel`, scope)}
      )                                   AS nights,
      COALESCE(f.final_nights, 0)         AS final_nights
    FROM months m
    CROSS JOIN checkpoints c
    LEFT JOIN finals f ON f.month_start = m.month_start
    /* A checkpoint in the future tells us nothing, so drop it. */
    WHERE (m.month_start - c.days_before) <= ${todayIso}::date
    ORDER BY m.month_start, c.days_before DESC
  `);

  const byMonth = new Map<string, { monthStart: string; finalNights: number; points: BookingCurvePoint[] }>();
  for (const r of rows) {
    const entry =
      byMonth.get(r.month) ??
      { monthStart: r.month_start, finalNights: n(r.final_nights), points: [] as BookingCurvePoint[] };
    entry.points.push({
      daysBefore: n(r.days_before),
      cumulativeNights: n(r.nights),
      cumulativeShare: ratio(n(r.nights), n(r.final_nights)),
    });
    byMonth.set(r.month, entry);
  }

  const series = [...byMonth.entries()]
    .map<BookingCurveSeries>(([month, e]) => ({
      month,
      finalNights: e.finalNights,
      // A month whose end is still ahead of us keeps selling, so its curve has
      // not finished climbing and its 100% is provisional.
      inProgress: monthEndIso(e.monthStart) >= todayIso,
      points: e.points,
    }))
    .filter((s) => s.finalNights > 0)
    .sort((a, b) => a.month.localeCompare(b.month));

  // Pooled curve across every completed month — the one the operator should
  // actually price against, since a single month of 100-odd nights is noisy.
  const complete = series.filter((s) => !s.inProgress);
  if (complete.length > 1) {
    const totalFinal = complete.reduce((acc, s) => acc + s.finalNights, 0);
    const pooled = new Map<number, number>();
    for (const s of complete) {
      for (const p of s.points) {
        pooled.set(p.daysBefore, (pooled.get(p.daysBefore) ?? 0) + p.cumulativeNights);
      }
    }
    series.unshift({
      month: 'all',
      finalNights: totalFinal,
      inProgress: false,
      points: CURVE_CHECKPOINTS.filter((d) => pooled.has(d))
        .sort((a, b) => b - a)
        .map((daysBefore) => ({
          daysBefore,
          cumulativeNights: pooled.get(daysBefore) ?? 0,
          cumulativeShare: ratio(pooled.get(daysBefore) ?? 0, totalFinal),
        })),
    });
  }

  return series;
}

function monthEndIso(monthStartIso: string): string {
  const d = new Date(`${monthStartIso}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

// ── Lead-time trend, by booking month ────────────────────────────────────────

interface TrendRow {
  month: string;
  bookings: number;
  avg_lead: number | null;
  median_lead: number | null;
  p90_lead: number | null;
}

/**
 * Grouped by BOOKING month, deliberately unfiltered by arrival window: the
 * question "is our booking window shortening?" is about production over time and
 * would be distorted by only looking at bookings for one span of stay dates.
 */
async function readTrend(scope: AnalyticsScope): Promise<LeadTimeTrendPoint[]> {
  const rows = await query<TrendRow>(sql`
    ${baseCtes(scope)}
    SELECT
      to_char(a.reservation_date, 'YYYY-MM')                        AS month,
      COUNT(DISTINCT a.reservation_number)::int                     AS bookings,
      AVG(a.check_in_date - a.reservation_date)::float8              AS avg_lead,
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY (a.check_in_date - a.reservation_date))::float8     AS median_lead,
      percentile_cont(0.9) WITHIN GROUP (
        ORDER BY (a.check_in_date - a.reservation_date))::float8     AS p90_lead
    FROM (
      SELECT DISTINCT reservation_number, reservation_date, check_in_date, room, channel
      FROM alloc
      WHERE is_blackout = false AND is_cancelled = false AND reservation_date IS NOT NULL
    ) a
    WHERE ${roomFilter(sql`a.room`, scope)}
      AND ${channelFilter(sql`a.channel`, scope)}
    GROUP BY 1
    ORDER BY 1
  `);

  return rows.map((r) => ({
    month: r.month,
    bookings: n(r.bookings),
    avgLeadDays: n(r.avg_lead),
    medianLeadDays: n(r.median_lead),
    p90LeadDays: n(r.p90_lead),
  }));
}

// ── Lead time by dimension ───────────────────────────────────────────────────

interface DimRow {
  key: string;
  bookings: number;
  avg_lead: number | null;
  median_lead: number | null;
}

async function readByDimension(
  scope: AnalyticsScope,
  dimension: 'channel' | 'primary_room' | 'stay_month',
): Promise<DimRow[]> {
  const keyExpr =
    dimension === 'stay_month'
      ? sql`to_char(bookings.check_in_date, 'YYYY-MM')`
      : dimension === 'channel'
        ? sql`bookings.channel`
        : sql`bookings.primary_room`;

  return query<DimRow>(sql`
    ${baseCtes(scope)},
    ${BOOKINGS_CTE(scope)}
    SELECT
      ${keyExpr}                                                     AS key,
      COUNT(*)::int                                                  AS bookings,
      AVG(bookings.lead_days)::float8                                AS avg_lead,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY bookings.lead_days)::float8 AS median_lead
    FROM bookings
    WHERE bookings.lead_days IS NOT NULL AND NOT bookings.is_cancelled
    GROUP BY 1
    ORDER BY 1
  `);
}

// ── Cancellations ────────────────────────────────────────────────────────────

interface CancelTotalsRow {
  total: number;
  cancelled: number;
  guest_cancelled: number;
  abandoned: number;
  cancelled_gbv: number;
  cancelled_nights: number;
  avg_days_before: number | null;
}

interface CancelChannelRow {
  channel: string;
  bookings: number;
  cancelled: number;
  cancelled_gbv: number;
  avg_days_before: number | null;
}

interface CancelLeadRow {
  label: string;
  bookings: number;
  cancelled: number;
}

interface SurvivalRow {
  label: string;
  cancelled: number;
}

interface RecoveryRow {
  cancelled_nights: number;
  recovered_nights: number;
}

async function readCancellations(scope: AnalyticsScope): Promise<CancellationAnalysis> {
  const [totals, byChannel, byLead, survival, recovery] = await Promise.all([
    query<CancelTotalsRow>(sql`
      ${baseCtes(scope)},
      ${BOOKINGS_CTE(scope)}
      SELECT
        COUNT(*)::int                                                              AS total,
        COUNT(*) FILTER (WHERE is_cancelled)::int                                  AS cancelled,
        COUNT(*) FILTER (WHERE cancel_class = 'guest')::int                         AS guest_cancelled,
        COUNT(*) FILTER (WHERE cancel_class = 'abandoned')::int                     AS abandoned,
        COALESCE(SUM(booking_price) FILTER (WHERE cancel_class = 'guest'), 0)::float8 AS cancelled_gbv,
        COALESCE(SUM(span_nights)  FILTER (WHERE cancel_class = 'guest'), 0)::int    AS cancelled_nights,
        AVG(check_in_date - cancelled_at::date) FILTER (WHERE cancel_class = 'guest')::float8 AS avg_days_before
      FROM bookings
    `),
    query<CancelChannelRow>(sql`
      ${baseCtes(scope)},
      ${BOOKINGS_CTE(scope)}
      SELECT
        channel,
        COUNT(*)::int                                                                AS bookings,
        COUNT(*) FILTER (WHERE cancel_class = 'guest')::int                           AS cancelled,
        COALESCE(SUM(booking_price) FILTER (WHERE cancel_class = 'guest'), 0)::float8  AS cancelled_gbv,
        AVG(check_in_date - cancelled_at::date) FILTER (WHERE cancel_class = 'guest')::float8 AS avg_days_before
      FROM bookings
      GROUP BY 1
      ORDER BY 2 DESC
    `),
    query<CancelLeadRow>(sql`
      ${baseCtes(scope)},
      ${BOOKINGS_CTE(scope)}
      SELECT
        ${leadBucketCase(sql`bookings.lead_days`)}                 AS label,
        COUNT(*)::int                                              AS bookings,
        COUNT(*) FILTER (WHERE cancel_class = 'guest')::int         AS cancelled
      FROM bookings
      WHERE bookings.lead_days IS NOT NULL
      GROUP BY 1
    `),
    query<SurvivalRow>(sql`
      ${baseCtes(scope)},
      ${BOOKINGS_CTE(scope)}
      SELECT
        CASE
          WHEN (check_in_date - cancelled_at::date) < 0  THEN 'After arrival'
          WHEN (check_in_date - cancelled_at::date) = 0  THEN 'Day of arrival'
          WHEN (check_in_date - cancelled_at::date) <= 3 THEN '1–3 days before'
          WHEN (check_in_date - cancelled_at::date) <= 7 THEN '4–7 days before'
          WHEN (check_in_date - cancelled_at::date) <= 30 THEN '8–30 days before'
          ELSE 'Over 30 days before'
        END                                       AS label,
        COUNT(*)::int                             AS cancelled
      FROM bookings
      WHERE cancel_class = 'guest' AND cancelled_at IS NOT NULL
      GROUP BY 1
    `),
    /* Recovery: how many of the cancelled room-nights were later re-sold. The
       only measure of what a cancellation actually cost — a cancellation that
       was resold at the same rate cost nothing but the operator's attention. */
    query<RecoveryRow>(sql`
      ${baseCtes(scope)},
      cancelled_nights AS (
        SELECT DISTINCT a.room, a.stay_date
        FROM asof_nights a
        JOIN alloc al ON al.reservation_number = a.reservation_number
        WHERE a.is_cancelled = true
          AND al.cancel_class = 'guest'
          AND a.stay_date BETWEEN ${scope.from}::date AND ${scope.to}::date
          AND ${roomFilter(sql`a.room`, scope)}
          AND ${channelFilter(sql`a.channel`, scope)}
      )
      SELECT
        (SELECT COUNT(*)::int FROM cancelled_nights)                              AS cancelled_nights,
        (SELECT COUNT(*)::int FROM cancelled_nights c
          WHERE EXISTS (
            SELECT 1 FROM nights nn
            WHERE nn.room = c.room AND nn.stay_date = c.stay_date
          ))                                                                      AS recovered_nights
    `),
  ]);

  const t = totals[0];
  const total = n(t?.total);
  const guestCancelled = n(t?.guest_cancelled);

  return {
    totalBookings: total,
    cancelledBookings: guestCancelled,
    cancellationRate: ratio(guestCancelled, total),
    cancelledGbv: n(t?.cancelled_gbv),
    avgDaysBeforeArrival: t?.avg_days_before == null ? null : n(t.avg_days_before),
    byChannel: byChannel.map((r) => ({
      channel: r.channel,
      bookings: n(r.bookings),
      cancelled: n(r.cancelled),
      rate: ratio(n(r.cancelled), n(r.bookings)),
      cancelledGbv: n(r.cancelled_gbv),
      avgDaysBeforeArrival: r.avg_days_before == null ? null : n(r.avg_days_before),
    })),
    byLeadBucket: LEAD_BUCKETS.map((b) => {
      const r = byLead.find((x) => x.label === b.label);
      return {
        label: b.label,
        bookings: n(r?.bookings),
        cancelled: n(r?.cancelled),
        rate: ratio(n(r?.cancelled), n(r?.bookings)),
      };
    }),
    survivalBuckets: (() => {
      const order = [
        'Over 30 days before',
        '8–30 days before',
        '4–7 days before',
        '1–3 days before',
        'Day of arrival',
        'After arrival',
      ];
      const totalCancels = survival.reduce((acc, r) => acc + n(r.cancelled), 0);
      return order
        .map((label) => {
          const r = survival.find((x) => x.label === label);
          return { label, cancelled: n(r?.cancelled), share: ratio(n(r?.cancelled), totalCancels) };
        })
        .filter((b) => b.cancelled > 0);
    })(),
    cancelledNights: n(recovery[0]?.cancelled_nights),
    recoveredNights: n(recovery[0]?.recovered_nights),
  };
}

// ── When bookings arrive (day × hour) ────────────────────────────────────────

interface HeatRow {
  iso_dow: number;
  hour: number;
  bookings: number;
}

/**
 * Booking arrivals by local weekday and hour.
 *
 * Timestamps are converted to Europe/Prague, not left in UTC: the point of this
 * chart is when a HUMAN was at their keyboard, and a two-hour summer shift moves
 * the evening peak into the wrong bucket.
 */
async function readBookingHeat(scope: AnalyticsScope): Promise<BookingHeatCell[]> {
  return (
    await query<HeatRow>(sql`
      ${baseCtes(scope)},
      ${BOOKINGS_CTE(scope)}
      SELECT
        EXTRACT(ISODOW FROM booking_timestamp AT TIME ZONE 'Europe/Prague')::int AS iso_dow,
        EXTRACT(HOUR  FROM booking_timestamp AT TIME ZONE 'Europe/Prague')::int  AS hour,
        COUNT(*)::int                                                           AS bookings
      FROM bookings
      WHERE booking_timestamp IS NOT NULL AND NOT is_cancelled
      GROUP BY 1, 2
    `)
  ).map((r) => ({ isoDow: n(r.iso_dow), hour: n(r.hour), bookings: n(r.bookings) }));
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function readBookingWindow(
  scope: AnalyticsScope,
  todayIso: string,
): Promise<BookingWindowResponse> {
  const [leadTime, summary, curves, trend, byChannel, byRoom, byStayMonth, cancellations, bookingHeat] =
    await Promise.all([
      readLeadTime(scope),
      readSummary(scope),
      readCurves(scope, todayIso),
      readTrend(scope),
      readByDimension(scope, 'channel'),
      readByDimension(scope, 'primary_room'),
      readByDimension(scope, 'stay_month'),
      readCancellations(scope),
      readBookingHeat(scope),
    ]);

  const roomOrder = new Map(PHYSICAL_ROOMS.map((room, i) => [room, i]));

  return {
    basis: 'booked',
    query: { from: scope.from, to: scope.to, rooms: scope.rooms, channels: scope.channels },
    leadTime,
    summary,
    curves,
    trend,
    byChannel: byChannel.map((r) => ({
      channel: r.key,
      bookings: n(r.bookings),
      avgLeadDays: n(r.avg_lead),
      medianLeadDays: n(r.median_lead),
    })),
    byRoom: byRoom
      .filter((r) => isPhysicalRoom(r.key))
      .map((r) => ({
        room: r.key,
        bookings: n(r.bookings),
        avgLeadDays: n(r.avg_lead),
        medianLeadDays: n(r.median_lead),
      }))
      .sort((a, b) => (roomOrder.get(a.room) ?? 99) - (roomOrder.get(b.room) ?? 99)),
    byStayMonth: byStayMonth.map((r) => ({
      month: r.key,
      bookings: n(r.bookings),
      avgLeadDays: n(r.avg_lead),
      medianLeadDays: n(r.median_lead),
    })),
    cancellations,
    bookingHeat,
  };
}

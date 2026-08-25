/**
 * Overview — reservation, monetary and room performance for a stay window.
 *
 * ATTRIBUTION: stay basis. Every revenue figure is allocated to the night it was
 * slept, matching the Performance tab, so a stay spanning a month boundary lands
 * in both months in proportion. Booking-basis questions ("how much did we sell in
 * July?") live in the Booking Windows section, which says so explicitly.
 *
 * RevPAR is the spine of this section, not an afterthought: occupancy and ADR are
 * presented as its two factors so a move in RevPAR always decomposes into "we
 * sold more nights" or "we charged more per night".
 */
import { sql } from 'drizzle-orm';
import { PACE_MONTHS_AHEAD } from '@/data/analyticsConfig';
import type {
  ChannelPerformance,
  CoreKpis,
  DistributionBucket,
  MonthlyPoint,
  NationalityRow,
  OverviewResponse,
  PaceRow,
  RoomPerformance,
  UnitPerformance,
} from '@/utils/analyticsTypes';
import {
  baseCtes,
  channelFilter,
  isPhysicalRoom,
  LOS_BUCKETS,
  losBucketCase,
  n,
  nightsInScope,
  PHYSICAL_ROOMS,
  query,
  ratio,
  REVIEW_SCORE_10,
  roomCategoryLabel,
  roomFilter,
  unitIdOf,
  unitsInScope,
  type AnalyticsScope,
} from './shared';

// ── Booking-grain CTE ────────────────────────────────────────────────────────
//
// One row per BOOKING that has at least one night in the window, carrying the
// revenue attributable to those nights. Booking-level facts (length of stay,
// party size, lead time, review) must be averaged over bookings, never over
// nights — averaging over nights silently weights every booking by how long it
// was, which turns "average party size" into "average party size per night".

const BOOKING_AGG = (scope: AnalyticsScope) => sql`
  booking_agg AS (
    SELECT
      nights.reservation_number,
      MIN(nights.channel)            AS channel,
      MIN(nights.span_nights)        AS span_nights,
      MIN(nights.number_of_guests)   AS guests,
      MIN(nights.lead_days)          AS lead_days,
      MIN(nights.nationality)        AS nationality,
      MIN(nights.check_in_date)      AS check_in_date,
      (array_agg(nights.synced_rating))[1] AS synced_rating,
      COUNT(*)::int                  AS nights_in_window,
      SUM(nights.night_price)        AS gbv,
      SUM(nights.night_commission)   AS commission,
      SUM(nights.night_fee)          AS fee
    FROM nights
    WHERE ${nightsInScope(scope)}
    GROUP BY nights.reservation_number
  )
`;

/** Score normalised to /10 — Booking.com is out of 10, Airbnb out of 5. */
const RATING_10 = sql`
  CASE
    WHEN booking_agg.synced_rating IS NULL THEN NULL
    WHEN (booking_agg.synced_rating ->> 'scale') = '5'
      THEN (booking_agg.synced_rating ->> 'score')::numeric * 2
    ELSE (booking_agg.synced_rating ->> 'score')::numeric
  END
`;

// ── KPIs ─────────────────────────────────────────────────────────────────────

interface KpiRow {
  sold_nights: number;
  available_nights: number;
  gbv: number;
  commission: number;
  fees: number;
  bookings: number;
  avg_los: number | null;
  avg_party: number | null;
  avg_lead: number | null;
  median_lead: number | null;
  review_avg: number | null;
  review_count: number;
  arrivals: number;
  cancelled_arrivals: number;
}

async function readKpis(scope: AnalyticsScope): Promise<CoreKpis> {
  const rows = await query<KpiRow>(sql`
    ${baseCtes(scope)},
    ${BOOKING_AGG(scope)}
    SELECT
      (SELECT COUNT(*)::int              FROM nights WHERE ${nightsInScope(scope)}) AS sold_nights,
      (SELECT COALESCE(SUM(night_price),0)::float8      FROM nights WHERE ${nightsInScope(scope)}) AS gbv,
      (SELECT COALESCE(SUM(night_commission),0)::float8 FROM nights WHERE ${nightsInScope(scope)}) AS commission,
      (SELECT COALESCE(SUM(night_fee),0)::float8        FROM nights WHERE ${nightsInScope(scope)}) AS fees,
      (SELECT COUNT(*)::int FROM available)                                          AS available_nights,
      (SELECT COUNT(*)::int FROM booking_agg)                                        AS bookings,
      (SELECT AVG(span_nights)::float8      FROM booking_agg)                        AS avg_los,
      (SELECT AVG(guests)::float8           FROM booking_agg)                        AS avg_party,
      (SELECT AVG(lead_days)::float8        FROM booking_agg WHERE lead_days IS NOT NULL) AS avg_lead,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY lead_days)::float8
         FROM booking_agg WHERE lead_days IS NOT NULL)                               AS median_lead,
      (SELECT AVG(${RATING_10})::float8 FROM booking_agg)                            AS review_avg,
      (SELECT COUNT(${RATING_10})::int  FROM booking_agg)                            AS review_count,
      /* Cancellation rate is measured on ARRIVAL date over ALL bookings that
         were ever due to arrive in the window — cancelled ones have no nights,
         so they are invisible to the nights CTE and must be counted here.

         Only cancel_class = 'guest' counts. An ABANDONED checkout (cancelled
         within minutes of creation — an incomplete Stripe session or a duplicate
         attempt) is not a guest changing their plans, and counting it as one put
         the direct-channel rate at 84% against a real 21%. The Booking windows
         section uses this same definition, so the two agree. */
      (SELECT COUNT(DISTINCT alloc.reservation_number)::int
         FROM alloc
        WHERE alloc.is_blackout = false
          AND (alloc.cancel_class IS NULL OR alloc.cancel_class = 'guest')
          AND alloc.check_in_date BETWEEN ${scope.from}::date AND ${scope.to}::date
          AND ${roomFilter(sql`alloc.room`, scope)}
          AND ${channelFilter(sql`alloc.channel`, scope)})                           AS arrivals,
      (SELECT COUNT(DISTINCT alloc.reservation_number)::int
         FROM alloc
        WHERE alloc.is_blackout = false
          AND alloc.cancel_class = 'guest'
          AND alloc.check_in_date BETWEEN ${scope.from}::date AND ${scope.to}::date
          AND ${roomFilter(sql`alloc.room`, scope)}
          AND ${channelFilter(sql`alloc.channel`, scope)})                           AS cancelled_arrivals
  `);

  const r = rows[0];
  const soldNights = n(r?.sold_nights);
  const availableNights = n(r?.available_nights);
  const gbv = n(r?.gbv);
  const otaCommission = n(r?.commission);
  const paymentFees = n(r?.fees);
  const netSales = gbv - otaCommission - paymentFees;

  return {
    soldNights,
    availableNights,
    occupancy: ratio(soldNights, availableNights),
    gbv,
    adr: ratio(gbv, soldNights),
    revpar: ratio(gbv, availableNights),
    otaCommission,
    paymentFees,
    netSales,
    netRevpar: ratio(netSales, availableNights),
    netAdr: ratio(netSales, soldNights),
    takeRate: ratio(otaCommission + paymentFees, gbv),
    bookings: n(r?.bookings),
    avgLengthOfStay: n(r?.avg_los),
    avgPartySize: n(r?.avg_party),
    avgLeadDays: n(r?.avg_lead),
    medianLeadDays: n(r?.median_lead),
    cancellationRate: ratio(n(r?.cancelled_arrivals), n(r?.arrivals)),
    avgReviewScore: r?.review_avg == null ? null : n(r.review_avg),
    reviewCount: n(r?.review_count),
  };
}

// ── Monthly series ───────────────────────────────────────────────────────────

interface MonthlyRow {
  month: string;
  sold_nights: number;
  available_nights: number;
  gbv: number;
  commission: number;
  fees: number;
  bookings: number;
  month_end: string;
}

async function readMonthly(scope: AnalyticsScope, todayIso: string): Promise<MonthlyPoint[]> {
  const rows = await query<MonthlyRow>(sql`
    ${baseCtes(scope)},
    sold AS (
      SELECT
        to_char(nights.stay_date, 'YYYY-MM')                 AS month,
        COUNT(*)::int                                        AS sold_nights,
        COUNT(DISTINCT nights.reservation_number)::int        AS bookings,
        COALESCE(SUM(nights.night_price), 0)::float8          AS gbv,
        COALESCE(SUM(nights.night_commission), 0)::float8     AS commission,
        COALESCE(SUM(nights.night_fee), 0)::float8            AS fees
      FROM nights
      WHERE ${nightsInScope(scope)}
      GROUP BY 1
    ),
    avail AS (
      SELECT
        to_char(stay_date, 'YYYY-MM')                        AS month,
        COUNT(*)::int                                        AS available_nights,
        MAX((date_trunc('month', stay_date) + INTERVAL '1 month - 1 day')::date)::text AS month_end
      FROM available
      GROUP BY 1
    )
    SELECT
      COALESCE(a.month, s.month)                AS month,
      COALESCE(s.sold_nights, 0)                AS sold_nights,
      COALESCE(a.available_nights, 0)           AS available_nights,
      COALESCE(s.gbv, 0)                        AS gbv,
      COALESCE(s.commission, 0)                 AS commission,
      COALESCE(s.fees, 0)                       AS fees,
      COALESCE(s.bookings, 0)                   AS bookings,
      a.month_end                               AS month_end
    FROM avail a
    FULL OUTER JOIN sold s ON s.month = a.month
    ORDER BY 1
  `);

  return rows.map((r) => {
    const soldNights = n(r.sold_nights);
    const availableNights = n(r.available_nights);
    const gbv = n(r.gbv);
    const commission = n(r.commission);
    const fees = n(r.fees);
    const netSales = gbv - commission - fees;
    return {
      month: r.month,
      soldNights,
      availableNights,
      occupancy: ratio(soldNights, availableNights),
      gbv,
      adr: ratio(gbv, soldNights),
      revpar: ratio(gbv, availableNights),
      netSales,
      netRevpar: ratio(netSales, availableNights),
      otaCommission: commission,
      paymentFees: fees,
      bookings: n(r.bookings),
      // A month is partial when its last day is still ahead of us, OR when the
      // selected window clips it. Either way the bars must not be read as a
      // finished month.
      partial:
        (r.month_end ?? '') > todayIso ||
        r.month === scope.from.slice(0, 7) ||
        r.month === scope.to.slice(0, 7),
    };
  });
}

// ── Per room ─────────────────────────────────────────────────────────────────

interface RoomRow {
  room: string;
  sold_nights: number;
  available_nights: number;
  blackout_nights: number;
  gbv: number;
  commission: number;
  fees: number;
  bookings: number;
  avg_los: number | null;
  review_avg: number | null;
}

async function readRooms(scope: AnalyticsScope, portfolioRevpar: number): Promise<RoomPerformance[]> {
  const rows = await query<RoomRow>(sql`
    ${baseCtes(scope)},
    ${BOOKING_AGG(scope)},
    sold AS (
      SELECT
        nights.room,
        COUNT(*)::int                                     AS sold_nights,
        COUNT(DISTINCT nights.reservation_number)::int     AS bookings,
        COALESCE(SUM(nights.night_price), 0)::float8       AS gbv,
        COALESCE(SUM(nights.night_commission), 0)::float8  AS commission,
        COALESCE(SUM(nights.night_fee), 0)::float8         AS fees
      FROM nights
      WHERE ${nightsInScope(scope)}
      GROUP BY 1
    ),
    los AS (
      SELECT nights.room, AVG(booking_agg.span_nights)::float8 AS avg_los,
             AVG(${RATING_10})::float8 AS review_avg
      FROM booking_agg
      JOIN (SELECT DISTINCT reservation_number, room FROM nights WHERE ${nightsInScope(scope)}) nights
        ON nights.reservation_number = booking_agg.reservation_number
      GROUP BY 1
    ),
    avail AS (
      SELECT room, COUNT(*)::int AS available_nights FROM available GROUP BY 1
    ),
    blk AS (
      SELECT room, COUNT(*)::int AS blackout_nights
      FROM blackout_nights
      WHERE stay_date BETWEEN ${scope.from}::date AND ${scope.to}::date
      GROUP BY 1
    )
    SELECT
      COALESCE(a.room, s.room)          AS room,
      COALESCE(s.sold_nights, 0)        AS sold_nights,
      COALESCE(a.available_nights, 0)   AS available_nights,
      COALESCE(b.blackout_nights, 0)    AS blackout_nights,
      COALESCE(s.gbv, 0)                AS gbv,
      COALESCE(s.commission, 0)         AS commission,
      COALESCE(s.fees, 0)               AS fees,
      COALESCE(s.bookings, 0)           AS bookings,
      l.avg_los                         AS avg_los,
      l.review_avg                      AS review_avg
    FROM avail a
    FULL OUTER JOIN sold s ON s.room = a.room
    LEFT JOIN los l ON l.room = COALESCE(a.room, s.room)
    LEFT JOIN blk b ON b.room = COALESCE(a.room, s.room)
    ORDER BY 1
  `);

  const out = rows
    // Virtual-room labels carry revenue but no inventory; they belong in the
    // portfolio total, not in a per-room league table.
    .filter((r) => isPhysicalRoom(r.room))
    .map<RoomPerformance>((r) => {
      const soldNights = n(r.sold_nights);
      const availableNights = n(r.available_nights);
      const gbv = n(r.gbv);
      const netSales = gbv - n(r.commission) - n(r.fees);
      const revpar = ratio(gbv, availableNights);
      return {
        room: r.room,
        category: roomCategoryLabel(r.room),
        soldNights,
        availableNights,
        blackoutNights: n(r.blackout_nights),
        occupancy: ratio(soldNights, availableNights),
        gbv,
        adr: ratio(gbv, soldNights),
        revpar,
        netSales,
        netRevpar: ratio(netSales, availableNights),
        bookings: n(r.bookings),
        avgLengthOfStay: n(r.avg_los),
        revparIndex: portfolioRevpar > 0 ? revpar / portfolioRevpar : 0,
        avgReviewScore: r.review_avg == null ? null : n(r.review_avg),
      };
    });

  // Keep canonical room order (Urban then Deluxe) rather than alphabetical.
  const order = new Map(PHYSICAL_ROOMS.map((room, i) => [room, i]));
  return out.sort((a, b) => (order.get(a.room) ?? 99) - (order.get(b.room) ?? 99));
}

// ── Per sellable unit ────────────────────────────────────────────────────────

interface UnitRow {
  unit_id: string;
  sold_nights: number;
  available_nights: number;
  gbv: number;
  commission: number;
  fees: number;
  bookings: number;
  avg_los: number | null;
  review_avg: number | null;
  open_dates: number;
  soldout_dates: number;
}

/**
 * Performance per SELLABLE UNIT — the grain the market buys, and the one where
 * "sold out" means something.
 *
 * A unit is sold out on a date when every one of its available rooms sold. For the
 * Urban trio that is a real event with a real implication: there was no 1KK Urban
 * studio left, at any price. Per room the same question is meaningless, because
 * Beds24 decides which sibling takes a booking, so a single room hitting 100% only
 * tells you the allocator filled it first.
 */
async function readUnits(
  scope: AnalyticsScope,
  portfolioRevpar: number,
): Promise<UnitPerformance[]> {
  const rows = await query<UnitRow>(sql`
    ${baseCtes(scope)},
    sold AS (
      SELECT
        ${unitIdOf(sql`nights.room`)}                      AS unit_id,
        COUNT(*)::int                                      AS sold_nights,
        COUNT(DISTINCT nights.reservation_number)::int      AS bookings,
        COALESCE(SUM(nights.night_price), 0)::float8        AS gbv,
        COALESCE(SUM(nights.night_commission), 0)::float8   AS commission,
        COALESCE(SUM(nights.night_fee), 0)::float8          AS fees,
        AVG(${REVIEW_SCORE_10})::float8                     AS review_avg
      FROM nights
      WHERE ${nightsInScope(scope)}
      GROUP BY 1
    ),
    avail AS (
      SELECT ${unitIdOf(sql`available.room`)} AS unit_id, COUNT(*)::int AS available_nights
      FROM available
      GROUP BY 1
    ),
    /* Average stay length per unit, over BOOKINGS not nights. The booking-grain
       CTE is keyed by reservation only and carries no room, so the (booking, unit)
       pairs are re-derived here — a package booking spanning two units counts once
       in each, which is the honest reading. */
    los AS (
      SELECT unit_id, AVG(span_nights)::float8 AS avg_los
      FROM (
        SELECT DISTINCT
          ${unitIdOf(sql`nights.room`)} AS unit_id,
          nights.reservation_number,
          nights.span_nights
        FROM nights
        WHERE ${nightsInScope(scope)}
      ) per_booking
      GROUP BY 1
    ),
    /* Capacity and sales per (unit, date), so sold-out days can be counted. */
    unit_day AS (
      SELECT
        ${unitIdOf(sql`available.room`)} AS unit_id,
        available.stay_date,
        COUNT(*)::int                    AS capacity
      FROM available
      GROUP BY 1, 2
    ),
    unit_day_sold AS (
      SELECT
        ${unitIdOf(sql`nights.room`)} AS unit_id,
        nights.stay_date,
        COUNT(*)::int                 AS sold
      FROM nights
      WHERE ${nightsInScope(scope)}
      GROUP BY 1, 2
    ),
    compression AS (
      SELECT
        d.unit_id,
        COUNT(*)::int AS open_dates,
        COUNT(*) FILTER (WHERE COALESCE(s.sold, 0) >= d.capacity)::int AS soldout_dates
      FROM unit_day d
      LEFT JOIN unit_day_sold s ON s.unit_id = d.unit_id AND s.stay_date = d.stay_date
      GROUP BY 1
    )
    SELECT
      a.unit_id                       AS unit_id,
      COALESCE(s.sold_nights, 0)      AS sold_nights,
      a.available_nights              AS available_nights,
      COALESCE(s.gbv, 0)              AS gbv,
      COALESCE(s.commission, 0)       AS commission,
      COALESCE(s.fees, 0)             AS fees,
      COALESCE(s.bookings, 0)         AS bookings,
      l.avg_los                       AS avg_los,
      s.review_avg                    AS review_avg,
      COALESCE(c.open_dates, 0)       AS open_dates,
      COALESCE(c.soldout_dates, 0)    AS soldout_dates
    FROM avail a
    LEFT JOIN sold s       ON s.unit_id = a.unit_id
    LEFT JOIN los l        ON l.unit_id = a.unit_id
    LEFT JOIN compression c ON c.unit_id = a.unit_id
  `);

  const byId = new Map(rows.map((r) => [r.unit_id, r]));
  return unitsInScope(scope)
    .filter((unit) => byId.has(unit.id))
    .map<UnitPerformance>((unit) => {
      const r = byId.get(unit.id)!;
      const soldNights = n(r.sold_nights);
      const availableNights = n(r.available_nights);
      const gbv = n(r.gbv);
      const netSales = gbv - n(r.commission) - n(r.fees);
      const revpar = ratio(gbv, availableNights);
      const openDates = n(r.open_dates);
      const soldOutDates = n(r.soldout_dates);
      return {
        unitId: unit.id,
        label: unit.label,
        shortLabel: unit.shortLabel,
        rooms: unit.rooms,
        bedrooms: unit.bedrooms,
        soldNights,
        availableNights,
        occupancy: ratio(soldNights, availableNights),
        gbv,
        adr: ratio(gbv, soldNights),
        revpar,
        netSales,
        netRevpar: ratio(netSales, availableNights),
        bookings: n(r.bookings),
        avgLengthOfStay: n(r.avg_los),
        revparIndex: portfolioRevpar > 0 ? revpar / portfolioRevpar : 0,
        soldOutDates,
        openDates,
        soldOutRate: ratio(soldOutDates, openDates),
        avgReviewScore: r.review_avg == null ? null : n(r.review_avg),
      };
    });
}

// ── Per channel ──────────────────────────────────────────────────────────────

interface ChannelRow {
  channel: string;
  sold_nights: number;
  gbv: number;
  commission: number;
  fees: number;
  bookings: number;
  avg_los: number | null;
  avg_lead: number | null;
  arrivals: number;
  cancelled_arrivals: number;
}

async function readChannels(scope: AnalyticsScope): Promise<ChannelPerformance[]> {
  const rows = await query<ChannelRow>(sql`
    ${baseCtes(scope)},
    ${BOOKING_AGG(scope)},
    sold AS (
      SELECT
        nights.channel,
        COUNT(*)::int                                     AS sold_nights,
        COUNT(DISTINCT nights.reservation_number)::int     AS bookings,
        COALESCE(SUM(nights.night_price), 0)::float8       AS gbv,
        COALESCE(SUM(nights.night_commission), 0)::float8  AS commission,
        COALESCE(SUM(nights.night_fee), 0)::float8         AS fees
      FROM nights
      WHERE ${nightsInScope(scope)}
      GROUP BY 1
    ),
    per_booking AS (
      SELECT channel,
             AVG(span_nights)::float8 AS avg_los,
             AVG(lead_days)::float8   AS avg_lead
      FROM booking_agg
      GROUP BY 1
    ),
    /* Guest cancellations only — abandoned checkouts are excluded, matching
       readKpis above and the Booking windows section. */
    cancels AS (
      SELECT
        alloc.channel,
        COUNT(DISTINCT alloc.reservation_number)::int AS arrivals,
        COUNT(DISTINCT alloc.reservation_number)
          FILTER (WHERE alloc.cancel_class = 'guest')::int AS cancelled_arrivals
      FROM alloc
      WHERE alloc.is_blackout = false
        AND (alloc.cancel_class IS NULL OR alloc.cancel_class = 'guest')
        AND alloc.check_in_date BETWEEN ${scope.from}::date AND ${scope.to}::date
        AND ${roomFilter(sql`alloc.room`, scope)}
        AND ${channelFilter(sql`alloc.channel`, scope)}
      GROUP BY 1
    )
    SELECT
      s.channel,
      s.sold_nights, s.gbv, s.commission, s.fees, s.bookings,
      p.avg_los, p.avg_lead,
      COALESCE(c.arrivals, 0)           AS arrivals,
      COALESCE(c.cancelled_arrivals, 0) AS cancelled_arrivals
    FROM sold s
    LEFT JOIN per_booking p ON p.channel = s.channel
    LEFT JOIN cancels c     ON c.channel = s.channel
    ORDER BY s.gbv DESC
  `);

  const totalNights = rows.reduce((acc, r) => acc + n(r.sold_nights), 0);
  const totalNet = rows.reduce(
    (acc, r) => acc + (n(r.gbv) - n(r.commission) - n(r.fees)),
    0,
  );

  return rows.map<ChannelPerformance>((r) => {
    const soldNights = n(r.sold_nights);
    const gbv = n(r.gbv);
    const otaCommission = n(r.commission);
    const paymentFees = n(r.fees);
    const netSales = gbv - otaCommission - paymentFees;
    return {
      channel: r.channel,
      bookings: n(r.bookings),
      soldNights,
      gbv,
      adr: ratio(gbv, soldNights),
      otaCommission,
      paymentFees,
      netSales,
      netAdr: ratio(netSales, soldNights),
      effectiveCommissionRate: ratio(otaCommission + paymentFees, gbv),
      nightShare: ratio(soldNights, totalNights),
      netSalesShare: totalNet > 0 ? netSales / totalNet : 0,
      avgLengthOfStay: n(r.avg_los),
      avgLeadDays: n(r.avg_lead),
      cancellationRate: ratio(n(r.cancelled_arrivals), n(r.arrivals)),
    };
  });
}

// ── Distributions ────────────────────────────────────────────────────────────

interface BucketRow {
  label: string;
  bookings: number;
  nights: number;
  gbv: number;
}

function toBuckets(rows: BucketRow[], order: string[]): DistributionBucket[] {
  const total = rows.reduce((acc, r) => acc + n(r.bookings), 0);
  const byLabel = new Map(rows.map((r) => [r.label, r]));
  return order
    .map((label) => {
      const r = byLabel.get(label);
      return {
        label,
        bookings: n(r?.bookings),
        nights: n(r?.nights),
        gbv: n(r?.gbv),
        share: ratio(n(r?.bookings), total),
      };
    })
    .filter((b) => b.bookings > 0 || order.length <= 8);
}

async function readDistributions(scope: AnalyticsScope): Promise<{
  lengthOfStay: DistributionBucket[];
  partySize: DistributionBucket[];
}> {
  const [losRows, partyRows] = await Promise.all([
    query<BucketRow>(sql`
      ${baseCtes(scope)},
      ${BOOKING_AGG(scope)}
      SELECT
        ${losBucketCase(sql`booking_agg.span_nights`)} AS label,
        COUNT(*)::int                                  AS bookings,
        SUM(booking_agg.span_nights)::int              AS nights,
        COALESCE(SUM(booking_agg.gbv), 0)::float8      AS gbv
      FROM booking_agg
      GROUP BY 1
    `),
    query<BucketRow>(sql`
      ${baseCtes(scope)},
      ${BOOKING_AGG(scope)}
      SELECT
        CASE
          WHEN booking_agg.guests <= 0 THEN 'Unknown'
          WHEN booking_agg.guests >= 5 THEN '5+ guests'
          WHEN booking_agg.guests = 1 THEN '1 guest'
          ELSE booking_agg.guests || ' guests'
        END                                       AS label,
        COUNT(*)::int                             AS bookings,
        SUM(booking_agg.nights_in_window)::int    AS nights,
        COALESCE(SUM(booking_agg.gbv), 0)::float8 AS gbv
      FROM booking_agg
      GROUP BY 1
    `),
  ]);

  return {
    lengthOfStay: toBuckets(
      losRows,
      LOS_BUCKETS.map((b) => b.label),
    ),
    partySize: toBuckets(partyRows, ['1 guest', '2 guests', '3 guests', '4 guests', '5+ guests', 'Unknown']),
  };
}

// ── Nationalities ────────────────────────────────────────────────────────────

interface NationalityQueryRow {
  code: string;
  bookings: number;
  nights: number;
  gbv: number;
  avg_los: number | null;
}

async function readNationalities(scope: AnalyticsScope): Promise<NationalityRow[]> {
  const rows = await query<NationalityQueryRow>(sql`
    ${baseCtes(scope)},
    ${BOOKING_AGG(scope)}
    SELECT
      CASE WHEN COALESCE(NULLIF(TRIM(booking_agg.nationality), ''), '') = ''
           THEN '—' ELSE UPPER(TRIM(booking_agg.nationality)) END AS code,
      COUNT(*)::int                              AS bookings,
      SUM(booking_agg.nights_in_window)::int     AS nights,
      COALESCE(SUM(booking_agg.gbv), 0)::float8  AS gbv,
      AVG(booking_agg.span_nights)::float8       AS avg_los
    FROM booking_agg
    GROUP BY 1
    ORDER BY 4 DESC
  `);

  return rows.map((r) => ({
    code: r.code,
    bookings: n(r.bookings),
    nights: n(r.nights),
    gbv: n(r.gbv),
    adr: ratio(n(r.gbv), n(r.nights)),
    avgLengthOfStay: n(r.avg_los),
  }));
}

// ── On-the-books / pace ──────────────────────────────────────────────────────

interface PaceQueryRow {
  month: string;
  month_start: string;
  nights_on_books: number;
  available_nights: number;
  gbv_on_books: number;
  nights_prev_at_same_lead: number | null;
  days_out: number;
}

/**
 * Forward book position for the next few stay months, with a same-lead-time
 * comparison against the PREVIOUS month.
 *
 * A real revenue manager would compare against the same point last year (STLY).
 * With under a year of trading there is no last year, so the honest substitute is
 * the previous month measured at the same number of days before it started —
 * the shape the `asof_nights` CTE exists to reconstruct. It is a weaker signal
 * (it confounds pace with seasonality) and the UI labels it as such, but it does
 * answer the only question that matters in-period: are we filling faster or
 * slower than we were a month ago?
 */
async function readPace(scope: AnalyticsScope, todayIso: string): Promise<PaceRow[]> {
  // Pace looks forward regardless of the selected window, so it gets its own
  // scope: this month through PACE_MONTHS_AHEAD, room/channel filters retained.
  const paceScope: AnalyticsScope = {
    ...scope,
    from: `${todayIso.slice(0, 7)}-01`,
    to: monthEndIso(addMonthsIso(`${todayIso.slice(0, 7)}-01`, PACE_MONTHS_AHEAD - 1)),
  };

  const rows = await query<PaceQueryRow>(sql`
    ${baseCtes(paceScope)},
    months AS (
      SELECT (date_trunc('month', ${paceScope.from}::date) + (i || ' month')::interval)::date AS month_start
      FROM generate_series(0, ${PACE_MONTHS_AHEAD - 1}) AS i
    ),
    otb AS (
      SELECT
        date_trunc('month', nights.stay_date)::date        AS month_start,
        COUNT(*)::int                                      AS nights_on_books,
        COALESCE(SUM(nights.night_price), 0)::float8       AS gbv_on_books
      FROM nights
      WHERE ${nightsInScope(paceScope)}
      GROUP BY 1
    ),
    avail AS (
      SELECT date_trunc('month', stay_date)::date AS month_start, COUNT(*)::int AS available_nights
      FROM available
      GROUP BY 1
    ),
    /* The previous month's book, frozen at the same lead time: as many days
       before ITS first day as we currently are before the target month's. */
    prev AS (
      SELECT
        m.month_start,
        COUNT(*)::int AS nights_prev_at_same_lead
      FROM months m
      CROSS JOIN LATERAL (
        SELECT
          (m.month_start - INTERVAL '1 month')::date                       AS prev_start,
          (m.month_start - ${todayIso}::date)                              AS days_out
      ) c
      JOIN asof_nights a
        ON a.stay_date >= c.prev_start
       AND a.stay_date <  m.month_start
       AND a.booked_on <= (c.prev_start - c.days_out)
       AND (a.cancelled_at IS NULL OR a.cancelled_at::date > (c.prev_start - c.days_out))
       AND ${roomFilter(sql`a.room`, paceScope)}
       AND ${channelFilter(sql`a.channel`, paceScope)}
      WHERE c.days_out > 0
      GROUP BY 1
    )
    SELECT
      to_char(m.month_start, 'YYYY-MM')             AS month,
      m.month_start::text                           AS month_start,
      COALESCE(o.nights_on_books, 0)                AS nights_on_books,
      COALESCE(v.available_nights, 0)               AS available_nights,
      COALESCE(o.gbv_on_books, 0)                   AS gbv_on_books,
      p.nights_prev_at_same_lead                    AS nights_prev_at_same_lead,
      (m.month_start - ${todayIso}::date)           AS days_out
    FROM months m
    LEFT JOIN otb   o ON o.month_start = m.month_start
    LEFT JOIN avail v ON v.month_start = m.month_start
    LEFT JOIN prev  p ON p.month_start = m.month_start
    ORDER BY m.month_start
  `);

  return rows.map<PaceRow>((r) => {
    const nightsOnBooks = n(r.nights_on_books);
    const availableNights = n(r.available_nights);
    const base = r.nights_prev_at_same_lead == null ? null : n(r.nights_prev_at_same_lead);
    return {
      month: r.month,
      nightsOnBooks,
      availableNights,
      occupancyOnBooks: ratio(nightsOnBooks, availableNights),
      gbvOnBooks: n(r.gbv_on_books),
      adrOnBooks: ratio(n(r.gbv_on_books), nightsOnBooks),
      nightsAtSameLeadPrevMonth: base,
      paceVsPrevMonth: base && base > 0 ? nightsOnBooks / base - 1 : null,
      daysOut: n(r.days_out),
    };
  });
}

// ── Date helpers (UTC-safe, same convention as utils/periodUtils) ─────────────

function addMonthsIso(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  return target.toISOString().slice(0, 10);
}

function monthEndIso(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

/** The window of equal length immediately before `scope`, for period-on-period. */
export function previousScope(scope: AnalyticsScope): AnalyticsScope {
  const msPerDay = 86_400_000;
  const start = new Date(`${scope.from}T00:00:00Z`).getTime();
  const end = new Date(`${scope.to}T00:00:00Z`).getTime();
  const lengthDays = Math.round((end - start) / msPerDay) + 1;
  return {
    ...scope,
    from: new Date(start - lengthDays * msPerDay).toISOString().slice(0, 10),
    to: new Date(start - msPerDay).toISOString().slice(0, 10),
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function readOverview(
  scope: AnalyticsScope,
  todayIso: string,
): Promise<OverviewResponse> {
  const kpis = await readKpis(scope);

  const [previous, monthly, rooms, units, channels, distributions, nationalities, pace] =
    await Promise.all([
      readKpis(previousScope(scope)).catch(() => null),
      readMonthly(scope, todayIso),
      readRooms(scope, kpis.revpar),
      readUnits(scope, kpis.revpar),
      readChannels(scope),
      readDistributions(scope),
      readNationalities(scope),
      readPace(scope, todayIso),
    ]);

  const bridge: OverviewResponse['bridge'] = [
    { label: 'Gross booking value', amount: kpis.gbv, kind: 'total' },
    { label: 'OTA commission', amount: kpis.otaCommission, kind: 'deduction' },
    { label: 'Payment fees', amount: kpis.paymentFees, kind: 'deduction' },
    { label: 'Net sales', amount: kpis.netSales, kind: 'result' },
  ];

  return {
    basis: 'stay',
    query: { from: scope.from, to: scope.to, rooms: scope.rooms, channels: scope.channels },
    kpis,
    previous,
    monthly,
    rooms,
    units,
    channels,
    lengthOfStay: distributions.lengthOfStay,
    partySize: distributions.partySize,
    nationalities,
    pace,
    bridge,
  };
}

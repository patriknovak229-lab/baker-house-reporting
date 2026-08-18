/**
 * Occupancy — how full the property runs, and where it runs out.
 *
 * THREE PROBLEMS THIS SECTION HAS TO SOLVE
 * ----------------------------------------
 * 1. INVENTORY GREW. Rooms came online in stages, so a flat rooms x days
 *    denominator compares February against inventory that did not exist. Every
 *    figure here uses the room-aware `available` CTE instead.
 *
 * 2. A ROOM IS NOT A PRODUCT. K.102, K.103 and K.106 are one listing sold
 *    interchangeably, and Beds24 picks which one a booking lands in. Per-room
 *    occupancy therefore measures the allocator, not demand — one room can sit at
 *    100% while its siblings have space. The headline grid is by SELLABLE UNIT;
 *    per-room is kept as detail.
 *
 * 3. LONG STAYS LIE ABOUT WEEKDAYS. A Monday inside a 25-night booking was bought
 *    once, months earlier, at a negotiated rate, and then blocked the room against
 *    every later Monday enquiry. It pushes Monday occupancy up and Monday ADR down
 *    at the same time. The transient view removes those nights from BOTH sides.
 *
 * With that cleaned up, the most decision-relevant number in the section is
 * COMPRESSION: how often a unit had nothing left to sell. A sold-out night could
 * not have sold more at any price, so its rate never had to ration demand — which
 * is the only evidence of underpricing that needs no market data and carries no
 * channel-fee bias.
 *
 * Seasonality proper stays deliberately hedged: six months cannot establish a
 * season, so months are indexed against the period average and named local events
 * are measured against their own shoulder dates.
 */
import { sql } from 'drizzle-orm';
import { DEMAND_EVENTS, TRANSIENT_LOS_MAX } from '@/data/analyticsConfig';
import type {
  CompressionDay,
  EventImpactRow,
  HeatmapCell,
  MonthlyPoint,
  OccupancyResponse,
  TransientWeekdayPoint,
  UnitHeatCell,
  WeekdayPoint,
} from '@/utils/analyticsTypes';
import {
  baseCtes,
  channelFilter,
  isPhysicalRoom,
  ISO_DOW_LABELS,
  n,
  nightsInScope,
  PHYSICAL_ROOMS,
  query,
  ratio,
  roomFilter,
  transientCtes,
  unitIdOf,
  unitsInScope,
  type AnalyticsScope,
} from './shared';

// ── Month × room grid ────────────────────────────────────────────────────────

interface HeatRow {
  month: string;
  room: string;
  sold_nights: number;
  available_nights: number;
  gbv: number;
}

async function readRoomHeatmap(scope: AnalyticsScope): Promise<HeatmapCell[]> {
  const rows = await query<HeatRow>(sql`
    ${baseCtes(scope)},
    sold AS (
      SELECT
        to_char(nights.stay_date, 'YYYY-MM')          AS month,
        nights.room                                   AS room,
        COUNT(*)::int                                 AS sold_nights,
        COALESCE(SUM(nights.night_price), 0)::float8  AS gbv
      FROM nights
      WHERE ${nightsInScope(scope)}
      GROUP BY 1, 2
    ),
    avail AS (
      SELECT to_char(stay_date, 'YYYY-MM') AS month, room, COUNT(*)::int AS available_nights
      FROM available
      GROUP BY 1, 2
    )
    SELECT
      COALESCE(a.month, s.month)      AS month,
      COALESCE(a.room, s.room)        AS room,
      COALESCE(s.sold_nights, 0)      AS sold_nights,
      COALESCE(a.available_nights, 0) AS available_nights,
      COALESCE(s.gbv, 0)              AS gbv
    FROM avail a
    FULL OUTER JOIN sold s ON s.month = a.month AND s.room = a.room
    ORDER BY 1, 2
  `);

  const order = new Map(PHYSICAL_ROOMS.map((room, i) => [room, i]));
  return rows
    .filter((r) => isPhysicalRoom(r.room))
    .map<HeatmapCell>((r) => {
      const soldNights = n(r.sold_nights);
      const availableNights = n(r.available_nights);
      const gbv = n(r.gbv);
      return {
        month: r.month,
        room: r.room,
        soldNights,
        availableNights,
        occupancy: ratio(soldNights, availableNights),
        adr: ratio(gbv, soldNights),
        revpar: ratio(gbv, availableNights),
      };
    })
    .sort((a, b) => a.month.localeCompare(b.month) || (order.get(a.room) ?? 99) - (order.get(b.room) ?? 99));
}

// ── Monthly portfolio totals (marginal row of the heatmap) ───────────────────

interface MonthTotalRow {
  month: string;
  sold_nights: number;
  available_nights: number;
  gbv: number;
  commission: number;
  fees: number;
  bookings: number;
  month_end: string | null;
}

async function readMonthly(scope: AnalyticsScope, todayIso: string): Promise<MonthlyPoint[]> {
  const rows = await query<MonthTotalRow>(sql`
    ${baseCtes(scope)},
    sold AS (
      SELECT
        to_char(nights.stay_date, 'YYYY-MM')              AS month,
        COUNT(*)::int                                     AS sold_nights,
        COUNT(DISTINCT nights.reservation_number)::int     AS bookings,
        COALESCE(SUM(nights.night_price), 0)::float8       AS gbv,
        COALESCE(SUM(nights.night_commission), 0)::float8  AS commission,
        COALESCE(SUM(nights.night_fee), 0)::float8         AS fees
      FROM nights
      WHERE ${nightsInScope(scope)}
      GROUP BY 1
    ),
    avail AS (
      SELECT
        to_char(stay_date, 'YYYY-MM') AS month,
        COUNT(*)::int                 AS available_nights,
        MAX((date_trunc('month', stay_date) + INTERVAL '1 month - 1 day')::date)::text AS month_end
      FROM available
      GROUP BY 1
    )
    SELECT
      COALESCE(a.month, s.month)      AS month,
      COALESCE(s.sold_nights, 0)      AS sold_nights,
      COALESCE(a.available_nights, 0) AS available_nights,
      COALESCE(s.gbv, 0)              AS gbv,
      COALESCE(s.commission, 0)       AS commission,
      COALESCE(s.fees, 0)             AS fees,
      COALESCE(s.bookings, 0)         AS bookings,
      a.month_end
    FROM avail a
    FULL OUTER JOIN sold s ON s.month = a.month
    ORDER BY 1
  `);

  return rows.map<MonthlyPoint>((r) => {
    const soldNights = n(r.sold_nights);
    const availableNights = n(r.available_nights);
    const gbv = n(r.gbv);
    const netSales = gbv - n(r.commission) - n(r.fees);
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
      otaCommission: n(r.commission),
      paymentFees: n(r.fees),
      bookings: n(r.bookings),
      partial:
        (r.month_end ?? '') > todayIso ||
        r.month === scope.from.slice(0, 7) ||
        r.month === scope.to.slice(0, 7),
    };
  });
}

// ── Day of week ──────────────────────────────────────────────────────────────

interface WeekdayRow {
  iso_dow: number;
  sold_nights: number;
  available_nights: number;
  gbv: number;
  arrivals: number;
  departures: number;
}

/**
 * Weekday view.
 *
 * `sold_nights` counts the NIGHT (Friday night is Friday), while `arrivals` and
 * `departures` count the check-in/check-out day. Keeping all three lets the
 * operator see the pattern that actually drives operations: which weekday the
 * turnovers land on is a cleaning-rota question, not a revenue one.
 */
async function readWeekday(scope: AnalyticsScope): Promise<WeekdayPoint[]> {
  const rows = await query<WeekdayRow>(sql`
    ${baseCtes(scope)},
    sold AS (
      SELECT
        EXTRACT(ISODOW FROM nights.stay_date)::int    AS iso_dow,
        COUNT(*)::int                                 AS sold_nights,
        COALESCE(SUM(nights.night_price), 0)::float8  AS gbv
      FROM nights
      WHERE ${nightsInScope(scope)}
      GROUP BY 1
    ),
    avail AS (
      SELECT EXTRACT(ISODOW FROM stay_date)::int AS iso_dow, COUNT(*)::int AS available_nights
      FROM available
      GROUP BY 1
    ),
    arr AS (
      SELECT
        EXTRACT(ISODOW FROM alloc.check_in_date)::int AS iso_dow,
        COUNT(DISTINCT alloc.reservation_number)::int AS arrivals
      FROM alloc
      WHERE alloc.is_cancelled = false AND alloc.is_blackout = false
        AND alloc.check_in_date BETWEEN ${scope.from}::date AND ${scope.to}::date
        AND ${roomFilter(sql`alloc.room`, scope)}
        AND ${channelFilter(sql`alloc.channel`, scope)}
      GROUP BY 1
    ),
    dep AS (
      SELECT
        EXTRACT(ISODOW FROM alloc.check_out_date)::int AS iso_dow,
        COUNT(DISTINCT alloc.reservation_number)::int  AS departures
      FROM alloc
      WHERE alloc.is_cancelled = false AND alloc.is_blackout = false
        AND alloc.check_out_date BETWEEN ${scope.from}::date AND ${scope.to}::date
        AND ${roomFilter(sql`alloc.room`, scope)}
        AND ${channelFilter(sql`alloc.channel`, scope)}
      GROUP BY 1
    ),
    dows AS (SELECT generate_series(1, 7)::int AS iso_dow)
    SELECT
      d.iso_dow,
      COALESCE(s.sold_nights, 0)      AS sold_nights,
      COALESCE(v.available_nights, 0) AS available_nights,
      COALESCE(s.gbv, 0)              AS gbv,
      COALESCE(a.arrivals, 0)         AS arrivals,
      COALESCE(p.departures, 0)       AS departures
    FROM dows d
    LEFT JOIN sold  s ON s.iso_dow = d.iso_dow
    LEFT JOIN avail v ON v.iso_dow = d.iso_dow
    LEFT JOIN arr   a ON a.iso_dow = d.iso_dow
    LEFT JOIN dep   p ON p.iso_dow = d.iso_dow
    ORDER BY d.iso_dow
  `);

  return rows.map<WeekdayPoint>((r) => {
    const isoDow = n(r.iso_dow);
    const soldNights = n(r.sold_nights);
    const availableNights = n(r.available_nights);
    const gbv = n(r.gbv);
    return {
      isoDow,
      label: ISO_DOW_LABELS[isoDow - 1] ?? String(isoDow),
      soldNights,
      availableNights,
      occupancy: ratio(soldNights, availableNights),
      gbv,
      adr: ratio(gbv, soldNights),
      revpar: ratio(gbv, availableNights),
      arrivals: n(r.arrivals),
      departures: n(r.departures),
    };
  });
}

// ── Named event impact ───────────────────────────────────────────────────────

interface EventRow {
  id: string;
  sold_nights: number;
  available_nights: number;
  gbv: number;
  base_sold_nights: number;
  base_available_nights: number;
  base_gbv: number;
}

/**
 * Per-event performance, in two modes.
 *
 * PAST events are measured against their own shoulder period — the fortnight
 * either side, excluding the event itself. Comparing MotoGP weekend to the annual
 * average would mostly measure "June versus February"; comparing it to the
 * fortnight around it isolates the event, and stays valid with one year of data.
 *
 * UPCOMING events have no shoulder to compare against (those dates are unsold
 * too), so they are reported as a forward position instead: nights already on the
 * books and the ADR they went at. This is the half that can still be acted on —
 * knowing the biggest trade fair of the year is 4% sold is worth more than knowing
 * last quarter's race weekend went well.
 *
 * The availability denominator differs accordingly. Past events use the shared
 * `available` CTE (real inventory net of blackouts). Upcoming events fall outside
 * the selected window, so `available` holds nothing for them and the denominator
 * is computed from the rooms in scope × event nights — exact today, since every
 * room is now online, and it is stated as such.
 */
async function readEventImpact(
  scope: AnalyticsScope,
  todayIso: string,
): Promise<EventImpactRow[]> {
  const past = DEMAND_EVENTS.filter((e) => e.end >= scope.from && e.start <= scope.to);
  // Look a year ahead — beyond that the operator cannot price anyway.
  const horizon = new Date(`${todayIso}T00:00:00Z`);
  horizon.setUTCFullYear(horizon.getUTCFullYear() + 1);
  const horizonIso = horizon.toISOString().slice(0, 10);
  const upcoming = DEMAND_EVENTS.filter(
    (e) => e.start > scope.to && e.start <= horizonIso && !past.some((p) => p.id === e.id),
  );

  const roomsInScope = scope.rooms.length > 0 ? scope.rooms.length : PHYSICAL_ROOMS.length;

  const pastRows = await Promise.all(
    past.map(async (e) => {
      const r = await query<EventRow>(sql`
        ${baseCtes(scope)}
        SELECT
          ${e.id}::text AS id,
          (SELECT COUNT(*)::int FROM nights
            WHERE stay_date BETWEEN ${e.start}::date AND ${e.end}::date
              AND ${roomFilter(sql`nights.room`, scope)}
              AND ${channelFilter(sql`nights.channel`, scope)})                AS sold_nights,
          (SELECT COUNT(*)::int FROM available
            WHERE stay_date BETWEEN ${e.start}::date AND ${e.end}::date)       AS available_nights,
          (SELECT COALESCE(SUM(night_price), 0)::float8 FROM nights
            WHERE stay_date BETWEEN ${e.start}::date AND ${e.end}::date
              AND ${roomFilter(sql`nights.room`, scope)}
              AND ${channelFilter(sql`nights.channel`, scope)})                AS gbv,
          (SELECT COUNT(*)::int FROM nights
            WHERE stay_date BETWEEN ${e.start}::date - 14 AND ${e.end}::date + 14
              AND stay_date NOT BETWEEN ${e.start}::date AND ${e.end}::date
              AND ${roomFilter(sql`nights.room`, scope)}
              AND ${channelFilter(sql`nights.channel`, scope)})                AS base_sold_nights,
          (SELECT COUNT(*)::int FROM available
            WHERE stay_date BETWEEN ${e.start}::date - 14 AND ${e.end}::date + 14
              AND stay_date NOT BETWEEN ${e.start}::date AND ${e.end}::date)   AS base_available_nights,
          (SELECT COALESCE(SUM(night_price), 0)::float8 FROM nights
            WHERE stay_date BETWEEN ${e.start}::date - 14 AND ${e.end}::date + 14
              AND stay_date NOT BETWEEN ${e.start}::date AND ${e.end}::date
              AND ${roomFilter(sql`nights.room`, scope)}
              AND ${channelFilter(sql`nights.channel`, scope)})                AS base_gbv
      `);
      return { event: e, row: r[0], upcoming: false };
    }),
  );

  const upcomingRows = await Promise.all(
    upcoming.map(async (e) => {
      // Widen the CTE window to the event so `nights` reaches it; `available`
      // is not used for these rows (see the note above).
      const eventScope: AnalyticsScope = { ...scope, from: e.start, to: e.end };
      const r = await query<EventRow>(sql`
        ${baseCtes(eventScope)}
        SELECT
          ${e.id}::text AS id,
          (SELECT COUNT(*)::int FROM nights WHERE ${nightsInScope(eventScope)})           AS sold_nights,
          0::int                                                                          AS available_nights,
          (SELECT COALESCE(SUM(night_price), 0)::float8 FROM nights
            WHERE ${nightsInScope(eventScope)})                                           AS gbv,
          0::int                                                                          AS base_sold_nights,
          0::int                                                                          AS base_available_nights,
          0::float8                                                                       AS base_gbv
      `);
      return { event: e, row: r[0], upcoming: true };
    }),
  );

  const nightsBetween = (from: string, to: string) =>
    Math.round(
      (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000,
    ) + 1;

  return [...pastRows, ...upcomingRows]
    .sort((a, b) => a.event.start.localeCompare(b.event.start))
    .map<EventImpactRow>(({ event, row, upcoming: isUpcoming }) => {
      const soldNights = n(row?.sold_nights);
      const gbv = n(row?.gbv);
      const availableNights = isUpcoming
        ? roomsInScope * nightsBetween(event.start, event.end)
        : n(row?.available_nights);
      const baseSold = n(row?.base_sold_nights);
      const baseAvail = n(row?.base_available_nights);
      const baseGbv = n(row?.base_gbv);

      const occupancy = ratio(soldNights, availableNights);
      const adr = ratio(gbv, soldNights);
      const baselineOccupancy = !isUpcoming && baseAvail > 0 ? ratio(baseSold, baseAvail) : null;
      const baselineAdr = !isUpcoming && baseSold > 0 ? ratio(baseGbv, baseSold) : null;

      return {
        event,
        isUpcoming,
        soldNights,
        availableNights,
        occupancy,
        adr,
        revpar: ratio(gbv, availableNights),
        baselineOccupancy,
        baselineAdr,
        adrUplift: baselineAdr && baselineAdr > 0 ? adr / baselineAdr - 1 : null,
        occupancyUplift: baselineOccupancy == null ? null : occupancy - baselineOccupancy,
      };
    });
}


// ── Month x sellable unit grid ───────────────────────────────────────────────

interface UnitHeatRow {
  month: string;
  unit_id: string;
  sold_nights: number;
  available_nights: number;
  gbv: number;
}

/**
 * The headline grid: occupancy by month and by SELLABLE UNIT.
 *
 * Capacity comes from the same room-aware `available` CTE and is then summed over
 * the unit's rooms, so the Urban unit shows three room-nights per calendar day and
 * K.201 shows one. That is what makes the numbers comparable: a 92% Urban month
 * means all three studios averaged 92%, not that one of them was busy.
 */
async function readUnitHeatmap(scope: AnalyticsScope): Promise<UnitHeatCell[]> {
  const rows = await query<UnitHeatRow>(sql`
    ${baseCtes(scope)},
    sold AS (
      SELECT
        to_char(nights.stay_date, 'YYYY-MM')          AS month,
        ${unitIdOf(sql`nights.room`)}                 AS unit_id,
        COUNT(*)::int                                 AS sold_nights,
        COALESCE(SUM(nights.night_price), 0)::float8  AS gbv
      FROM nights
      WHERE ${nightsInScope(scope)}
      GROUP BY 1, 2
    ),
    avail AS (
      SELECT
        to_char(available.stay_date, 'YYYY-MM')  AS month,
        ${unitIdOf(sql`available.room`)}         AS unit_id,
        COUNT(*)::int                            AS available_nights
      FROM available
      GROUP BY 1, 2
    )
    SELECT
      COALESCE(a.month, s.month)      AS month,
      COALESCE(a.unit_id, s.unit_id)  AS unit_id,
      COALESCE(s.sold_nights, 0)      AS sold_nights,
      COALESCE(a.available_nights, 0) AS available_nights,
      COALESCE(s.gbv, 0)              AS gbv
    FROM avail a
    FULL OUTER JOIN sold s ON s.month = a.month AND s.unit_id = a.unit_id
    ORDER BY 1, 2
  `);

  const order = new Map(unitsInScope(scope).map((u, i) => [u.id, i]));
  return rows
    .filter((r) => order.has(r.unit_id))
    .map<UnitHeatCell>((r) => {
      const soldNights = n(r.sold_nights);
      const availableNights = n(r.available_nights);
      const gbv = n(r.gbv);
      return {
        month: r.month,
        unitId: r.unit_id,
        soldNights,
        availableNights,
        occupancy: ratio(soldNights, availableNights),
        adr: ratio(gbv, soldNights),
        revpar: ratio(gbv, availableNights),
      };
    })
    .sort(
      (a, b) =>
        a.month.localeCompare(b.month) ||
        (order.get(a.unitId) ?? 99) - (order.get(b.unitId) ?? 99),
    );
}

// ── Transient weekday view ───────────────────────────────────────────────────

interface TransientWeekdayRow {
  iso_dow: number;
  sold_nights: number;
  available_nights: number;
  gbv: number;
  long_stay_nights: number;
  total_dates: number;
  soldout_dates: number;
  spare_dates: number;
  adr_full: number | null;
  adr_spare: number | null;
}

/**
 * Weekday performance with long stays stripped out of both sides, plus the
 * sold-out/spare ADR split that turns it into a pricing signal.
 *
 * Read `adr_full` against `adr_spare`. If the nights that sold out earned LESS
 * than the nights with rooms to spare, price was not doing the rationing on the
 * days that mattered — demand was. That inversion is the cleanest underpricing
 * evidence available from our own data, with no comp set and no channel-fee bias
 * anywhere in it.
 *
 * Sample-size honesty: a weekday that almost always sells out leaves very few
 * spare nights, so `spare_dates` is returned alongside and the UI refuses to draw
 * a conclusion from a handful of observations.
 */
async function readTransientWeekday(scope: AnalyticsScope): Promise<TransientWeekdayPoint[]> {
  const rows = await query<TransientWeekdayRow>(sql`
    ${transientCtes(scope)},
    day_capacity AS (
      SELECT ta.stay_date, COUNT(*)::int AS capacity
      FROM transient_available ta
      GROUP BY 1
    ),
    day_sold AS (
      SELECT
        nights.stay_date,
        COUNT(*)::int                                AS sold,
        COALESCE(SUM(nights.night_price), 0)::float8 AS gbv
      FROM nights
      WHERE ${nightsInScope(scope)}
        AND nights.span_nights <= ${TRANSIENT_LOS_MAX}
      GROUP BY 1
    ),
    day_long AS (
      SELECT l.stay_date, COUNT(*)::int AS long_nights
      FROM long_nights l
      WHERE l.stay_date BETWEEN ${scope.from}::date AND ${scope.to}::date
      GROUP BY 1
    ),
    joined AS (
      SELECT
        c.stay_date,
        EXTRACT(ISODOW FROM c.stay_date)::int AS iso_dow,
        c.capacity,
        COALESCE(s.sold, 0)      AS sold,
        COALESCE(s.gbv, 0)       AS gbv,
        COALESCE(g.long_nights, 0) AS long_nights,
        (COALESCE(s.sold, 0) >= c.capacity) AS is_full
      FROM day_capacity c
      LEFT JOIN day_sold s ON s.stay_date = c.stay_date
      LEFT JOIN day_long g ON g.stay_date = c.stay_date
    ),
    dows AS (SELECT generate_series(1, 7)::int AS iso_dow)
    SELECT
      d.iso_dow,
      COALESCE(SUM(j.sold), 0)::int            AS sold_nights,
      COALESCE(SUM(j.capacity), 0)::int        AS available_nights,
      COALESCE(SUM(j.gbv), 0)::float8          AS gbv,
      COALESCE(SUM(j.long_nights), 0)::int     AS long_stay_nights,
      COUNT(j.stay_date)::int                  AS total_dates,
      COUNT(j.stay_date) FILTER (WHERE j.is_full)::int     AS soldout_dates,
      COUNT(j.stay_date) FILTER (WHERE NOT j.is_full)::int AS spare_dates,
      (SUM(j.gbv) FILTER (WHERE j.is_full)
        / NULLIF(SUM(j.sold) FILTER (WHERE j.is_full), 0))::float8     AS adr_full,
      (SUM(j.gbv) FILTER (WHERE NOT j.is_full)
        / NULLIF(SUM(j.sold) FILTER (WHERE NOT j.is_full), 0))::float8 AS adr_spare
    FROM dows d
    LEFT JOIN joined j ON j.iso_dow = d.iso_dow
    GROUP BY d.iso_dow
    ORDER BY d.iso_dow
  `);

  return rows.map<TransientWeekdayPoint>((r) => {
    const isoDow = n(r.iso_dow);
    const soldNights = n(r.sold_nights);
    const availableNights = n(r.available_nights);
    const gbv = n(r.gbv);
    const totalDates = n(r.total_dates);
    const soldOutDates = n(r.soldout_dates);
    return {
      isoDow,
      label: ISO_DOW_LABELS[isoDow - 1] ?? String(isoDow),
      soldNights,
      availableNights,
      occupancy: ratio(soldNights, availableNights),
      adr: ratio(gbv, soldNights),
      revpar: ratio(gbv, availableNights),
      longStayNights: n(r.long_stay_nights),
      soldOutDates,
      totalDates,
      soldOutRate: ratio(soldOutDates, totalDates),
      adrWhenSoldOut: r.adr_full === null ? null : n(r.adr_full),
      adrWhenSpare: r.adr_spare === null ? null : n(r.adr_spare),
      spareDates: n(r.spare_dates),
    };
  });
}

// ── Compression ──────────────────────────────────────────────────────────────

interface CompressionRow {
  stay_date: string;
  iso_dow: number;
  capacity: number;
  sold: number;
  gbv: number;
  is_full: boolean;
}

interface LongStayTotals {
  long_nights: number;
  long_bookings: number;
}

/**
 * Every date in the window, with whether transient capacity ran out.
 *
 * Returned per date rather than pre-aggregated so the UI can draw the calendar
 * strip: a run of consecutive sold-out nights is a different story from the same
 * count scattered across the period, and only the sequence shows it.
 */
async function readCompression(
  scope: AnalyticsScope,
): Promise<OccupancyResponse['compression']> {
  const [days, totals] = await Promise.all([
    query<CompressionRow>(sql`
      ${transientCtes(scope)},
      day_capacity AS (
        SELECT ta.stay_date, COUNT(*)::int AS capacity
        FROM transient_available ta
        GROUP BY 1
      ),
      day_sold AS (
        SELECT
          nights.stay_date,
          COUNT(*)::int                                AS sold,
          COALESCE(SUM(nights.night_price), 0)::float8 AS gbv
        FROM nights
        WHERE ${nightsInScope(scope)}
          AND nights.span_nights <= ${TRANSIENT_LOS_MAX}
        GROUP BY 1
      )
      SELECT
        c.stay_date::text                     AS stay_date,
        EXTRACT(ISODOW FROM c.stay_date)::int AS iso_dow,
        c.capacity,
        COALESCE(s.sold, 0)::int              AS sold,
        COALESCE(s.gbv, 0)::float8            AS gbv,
        (COALESCE(s.sold, 0) >= c.capacity)   AS is_full
      FROM day_capacity c
      LEFT JOIN day_sold s ON s.stay_date = c.stay_date
      ORDER BY c.stay_date
    `),
    query<LongStayTotals>(sql`
      ${transientCtes(scope)}
      SELECT
        (SELECT COUNT(*)::int FROM long_nights l
          WHERE l.stay_date BETWEEN ${scope.from}::date AND ${scope.to}::date) AS long_nights,
        (SELECT COUNT(DISTINCT nights.reservation_number)::int FROM nights
          WHERE ${nightsInScope(scope)}
            AND nights.span_nights > ${TRANSIENT_LOS_MAX})       AS long_bookings
    `),
  ]);

  const soldOutDates = days.filter((d) => d.is_full).length;
  return {
    soldOutDates,
    totalDates: days.length,
    soldOutRate: ratio(soldOutDates, days.length),
    longStayNights: n(totals[0]?.long_nights),
    longStayBookings: n(totals[0]?.long_bookings),
    days: days.map<CompressionDay>((d) => {
      const capacity = n(d.capacity);
      const sold = n(d.sold);
      return {
        stayDate: d.stay_date,
        isoDow: n(d.iso_dow),
        capacity,
        sold,
        occupancy: ratio(sold, capacity),
        soldOut: !!d.is_full,
        adr: ratio(n(d.gbv), sold),
      };
    }),
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────


export async function readOccupancy(
  scope: AnalyticsScope,
  todayIso: string,
  completeMonths: number,
): Promise<OccupancyResponse> {
  const [roomHeatmap, unitHeatmap, monthly, weekday, transient, compression, events] =
    await Promise.all([
      readRoomHeatmap(scope),
      readUnitHeatmap(scope),
      readMonthly(scope, todayIso),
      readWeekday(scope),
      readTransientWeekday(scope),
      readCompression(scope),
      readEventImpact(scope, todayIso),
    ]);

  // Index each month against the period average. Raw month-over-month growth is
  // dominated by rooms coming online, which is not seasonality.
  const totalGbv = monthly.reduce((acc, m) => acc + m.gbv, 0);
  const totalSold = monthly.reduce((acc, m) => acc + m.soldNights, 0);
  const totalAvail = monthly.reduce((acc, m) => acc + m.availableNights, 0);
  const avgRevpar = ratio(totalGbv, totalAvail);
  const avgOccupancy = ratio(totalSold, totalAvail);
  const avgAdr = ratio(totalGbv, totalSold);

  const seasonIndex = monthly.map((m) => ({
    month: m.month,
    revparIndex: avgRevpar > 0 ? m.revpar / avgRevpar : 0,
    occupancyIndex: avgOccupancy > 0 ? m.occupancy / avgOccupancy : 0,
    adrIndex: avgAdr > 0 ? m.adr / avgAdr : 0,
    partial: m.partial,
  }));

  const partialYear = completeMonths < 12;
  const message = partialYear
    ? `Based on ${completeMonths} complete month${completeMonths === 1 ? '' : 's'} of trading. There is no prior year to compare against, and rooms came online in stages, so treat month-to-month shape as indicative. Day-of-week and named-event patterns are the sturdiest signals here.`
    : 'A full year of trading is available, so month-to-month shape can be read as seasonality.';

  return {
    basis: 'stay',
    query: { from: scope.from, to: scope.to, rooms: scope.rooms, channels: scope.channels },
    monthly,
    unitHeatmap,
    roomHeatmap,
    weekday,
    weekdayTransient: transient,
    transientLosMax: TRANSIENT_LOS_MAX,
    compression,
    seasonIndex,
    events,
    confidence: { completeMonths, partialYear, message },
  };
}

/**
 * Booking windows — when demand arrives, what it is worth, and how much of it
 * survives. Every figure is split by room class (1KK studios / 2KK apartments,
 * `ROOM_CLASSES`), because the two classes fill on different clocks and earn
 * different margins; a blended number hides both.
 *
 * THE YARDSTICK IS GROSS PROFIT PER NIGHT
 * ---------------------------------------
 * "Should we sell further ahead?" is a profit question, not a volume one. A night
 * booked 60 days out can carry a different rate (PriceLabs' far-out ramp, Booking's
 * Early Booker deal), a different stay length (fewer turnovers per night) and a
 * much higher chance of cancelling. So each booking window is scored on
 *
 *     gross profit = gross − OTA commission − payment fees − turnover cost
 *
 * where turnover cost is the cleaning + laundry + consumables billed for that
 * stay's checkout — the same per-booking contribution the Costs tab computes
 * (`channelProfit`). Monthly fixed costs (parking, subscriptions) do not depend
 * on when a night was booked, so they are left out on purpose.
 *
 * ATTRIBUTION: two bases, both stated in the response.
 *   - Money and nights are on the STAY basis: nights inside the window, each
 *     tagged with how far ahead its booking was made.
 *   - Cancellation rates and lead-time statistics are on the BOOKED basis:
 *     bookings ARRIVING inside the window, cancelled or not. Measuring them on
 *     survivors only would understate how far ahead demand first arrived.
 *
 * THE BOOKING CURVE IS RECONSTRUCTED
 * ----------------------------------
 * The archive keeps `reservation_date` and Beds24's `cancelTime`, so the state of
 * the book at any past instant can be replayed (`ASOF_NIGHTS_CTE`). That gives an
 * on-the-books curve — "how full was each night N days before it" — over the whole
 * trading history with no snapshot table. Its one blind spot: a booking that was
 * later MODIFIED is replayed in its final shape.
 */
import { sql, type SQL } from 'drizzle-orm';
import { ROOM_CLASSES, SELLABLE_UNITS, TURNOVER_COST_KEYS } from '@/data/analyticsConfig';
import { computeVariableCosts } from '@/utils/variableCostsEngine';
import { ROOM_TO_BEDS24_ID } from '@/utils/variableCostsShared';
import type {
  BookingWindowBandRow,
  BookingWindowCancellations,
  BookingWindowChannelRow,
  BookingWindowClassBlock,
  BookingWindowForwardBand,
  BookingWindowMonthRow,
  BookingWindowPromoRow,
  BookingWindowResponse,
} from '@/utils/analyticsTypes';
import {
  baseCtes,
  channelFilter,
  classIdOf,
  n,
  query,
  ratio,
  roomFilter,
  unitIdOf,
  unitsInScope,
  type AnalyticsScope,
} from './shared';

// ── Booking-window bands ─────────────────────────────────────────────────────

/**
 * Bands aligned with the pricing levers that actually change at each boundary,
 * so a gap in one band maps to one setting:
 *   ≤14 d  Booking.com Last-minute Deal (15 %)
 *   15+ d  Booking.com Early Booker Deal (20 %)
 *   30+ d  PriceLabs far-out ramp starts for Urban
 *   60+ d  PriceLabs far-out ramp starts for Deluxe / O.308
 */
export const WINDOW_BANDS: { id: string; label: string; min: number; max: number | null }[] = [
  { id: '0-3', label: '0–3 days', min: 0, max: 3 },
  { id: '4-7', label: '4–7 days', min: 4, max: 7 },
  { id: '8-14', label: '8–14 days', min: 8, max: 14 },
  { id: '15-29', label: '15–29 days', min: 15, max: 29 },
  { id: '30-59', label: '30–59 days', min: 30, max: 59 },
  { id: '60-89', label: '60–89 days', min: 60, max: 89 },
  { id: '90+', label: '90+ days', min: 90, max: null },
];

function bandOf(leadDays: number) {
  const d = Math.max(0, leadDays);
  return WINDOW_BANDS.find((b) => d >= b.min && (b.max === null || d <= b.max)) ?? WINDOW_BANDS[0];
}

/** Forward horizon bands — the same boundaries, capped at 180 days. */
const FORWARD_BANDS: { label: string; min: number; max: number }[] = [
  { label: '0–7 days', min: 0, max: 7 },
  { label: '8–14 days', min: 8, max: 14 },
  { label: '15–29 days', min: 15, max: 29 },
  { label: '30–59 days', min: 30, max: 59 },
  { label: '60–89 days', min: 60, max: 89 },
  { label: '90–179 days', min: 90, max: 179 },
];
const FORWARD_DAYS = 180;

/** Days-before-the-night checkpoints for the on-the-books curve. */
const CURVE_CHECKPOINTS = [180, 150, 120, 90, 75, 60, 45, 30, 21, 14, 10, 7, 5, 3, 2, 1, 0];

/** Months shown in the promo calendar, starting with the current one. */
const PROMO_MONTHS = 6;

/** Pace bands for the promo calendar — inside ±15 % of history is "on pace". */
const PACE_BEHIND = 0.85;
const PACE_AHEAD = 1.15;
/** Below this, history says almost nothing is sold yet — pace would be noise. */
const TOO_EARLY_OCCUPANCY = 0.03;

type ClassKey = '1kk' | '2kk' | 'all';
const CLASS_KEYS: ClassKey[] = ['1kk', '2kk', 'all'];

/** Before the first sellable night of any room — `room_online` trims the rest. */
const HISTORY_FROM = '2025-01-01';

// ── Small helpers ────────────────────────────────────────────────────────────

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (new Date(`${toIso}T00:00:00Z`).getTime() - new Date(`${fromIso}T00:00:00Z`).getTime()) / 86_400_000,
  );
}

function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function addMonths(month: string, k: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + k, 1));
  return d.toISOString().slice(0, 7);
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, v) => a + v, 0) / values.length;
}

/**
 * Unit of a room label, including the virtual-room labels legacy and unallocated
 * bookings carry. A "1KK Deluxe Studios" night took one of K.202/K.203, so for
 * capacity and resale it belongs to the Deluxe unit even though no physical room
 * is named.
 */
function unitOfLabel(room: SQL): SQL {
  return sql`CASE ${room}
    WHEN '1KK Deluxe Studios' THEN 'deluxe-1kk'
    WHEN '1KK Urban Studios'  THEN 'urban-1kk'
    ELSE ${unitIdOf(room)} END`;
}

const RATE_LINE_REGEX = '(\\d{4}-\\d{2}-\\d{2}) \\([^)]*\\) CZK ([0-9.]+)';

/**
 * Booking-room rows with the class, the effective cancellation date and — for a
 * cancelled booking — the value it would have had.
 *
 * Beds24 zeroes `price` on most cancellations, which is why the old "value
 * cancelled" figure read close to nothing. The per-night rates survive in
 * `rateDescription` ("2026-08-10 (… Flexible Urban 1KK) CZK 2149.16"); summed,
 * they reproduce the booked price to within 1 % on 340 of 350 live bookings, so
 * they are a sound stand-in. Bookings with neither are left unvalued and counted.
 */
const BW_ROWS_CTE = sql`
  bw_rate_lines AS (
    SELECT a.reservation_number, a.room, SUM((m.parts)[2]::numeric) * MAX(a.share) AS parsed_value
    FROM alloc a
    CROSS JOIN LATERAL regexp_matches(COALESCE(a.rate_description, ''), ${RATE_LINE_REGEX}, 'g') AS m(parts)
    WHERE a.is_cancelled
    GROUP BY 1, 2
  ),
  bw_rows AS (
    SELECT
      a.reservation_number,
      a.room,
      ${classIdOf(sql`a.room`)}                         AS class_id,
      ${unitOfLabel(sql`a.room`)}                      AS unit_id,
      a.channel,
      a.source,
      a.check_in_date,
      a.check_out_date,
      a.reservation_date,
      a.booking_timestamp,
      a.span_nights,
      a.is_cancelled,
      a.cancel_class,
      /* Same effective instant as ASOF_NIGHTS_CTE: an abandoned checkout was
         never live; any other cancellation without a cancelTime happened no
         later than its last modification. */
      CASE
        WHEN a.is_cancelled = false OR a.cancelled_at IS NOT NULL THEN a.cancelled_at
        WHEN a.cancel_class = 'abandoned' THEN a.booking_timestamp
        ELSE COALESCE(a.modified_at, a.booking_timestamp)
      END                                              AS cancelled_at,
      a.price,
      a.commission,
      a.fee,
      CASE WHEN a.is_cancelled THEN COALESCE(NULLIF(a.price, 0), rl.parsed_value) END AS cancelled_value
    FROM alloc a
    LEFT JOIN bw_rate_lines rl
      ON rl.reservation_number = a.reservation_number AND rl.room = a.room
    WHERE a.is_blackout = false
      AND a.span_nights > 0
      AND a.reservation_date IS NOT NULL
  )
`;

// ── Query 1: booking-room rows overlapping the window ────────────────────────

interface RowDb {
  reservation_number: string;
  room: string;
  class_id: string;
  unit_id: string;
  channel: string | null;
  source: string;
  check_in: string;
  check_out: string;
  booked_on: string;
  lead_days: number;
  span: number;
  nights_in_scope: number;
  is_cancelled: boolean;
  cancel_class: string | null;
  cancelled_on: string | null;
  price: number;
  commission: number;
  fee: number;
  cancelled_value: number | null;
  book_dow: number | null;
  book_hour: number | null;
}

interface Row {
  reservation: string;
  room: string;
  classId: '1kk' | '2kk';
  channel: string;
  checkIn: string;
  checkOut: string;
  bookedOn: string;
  leadDays: number;
  span: number;
  nightsInScope: number;
  isCancelled: boolean;
  cancelClass: string | null;
  cancelledOn: string | null;
  price: number;
  commission: number;
  fee: number;
  cancelledValue: number | null;
  bookDow: number | null;
  bookHour: number | null;
  /** Turnover cost billed for this room's checkout (imputed when not logged). */
  turnover: number;
  turnoverImputed: boolean;
}

/**
 * Every booking × room that touches the window — either a night inside it (stay
 * basis) or an arrival inside it (booked basis). Aggregation happens in TypeScript
 * because each row needs its turnover cost from the cost engine, which lives
 * outside Postgres.
 *
 * In-window money is the booking's price spread evenly across its nights — the
 * identical rule the `nights` CTE applies — so stay-basis totals here tie to the
 * Overview and Costs tabs.
 */
async function readRows(scope: AnalyticsScope): Promise<RowDb[]> {
  return query<RowDb>(sql`
    ${baseCtes(scope)},
    ${BW_ROWS_CTE}
    SELECT
      r.reservation_number,
      r.room,
      r.class_id,
      r.unit_id,
      r.channel,
      r.source,
      r.check_in_date::text                              AS check_in,
      r.check_out_date::text                             AS check_out,
      r.reservation_date::text                           AS booked_on,
      (r.check_in_date - r.reservation_date)::int        AS lead_days,
      r.span_nights::int                                 AS span,
      GREATEST(0,
        LEAST(r.check_out_date, ${scope.to}::date + 1) - GREATEST(r.check_in_date, ${scope.from}::date)
      )::int                                             AS nights_in_scope,
      r.is_cancelled,
      r.cancel_class,
      r.cancelled_at::date::text                         AS cancelled_on,
      r.price::float8                                    AS price,
      r.commission::float8                               AS commission,
      r.fee::float8                                      AS fee,
      r.cancelled_value::float8                          AS cancelled_value,
      EXTRACT(ISODOW FROM r.booking_timestamp AT TIME ZONE 'Europe/Prague')::int AS book_dow,
      EXTRACT(HOUR   FROM r.booking_timestamp AT TIME ZONE 'Europe/Prague')::int AS book_hour
    FROM bw_rows r
    WHERE r.class_id <> 'other'
      AND r.check_in_date <= ${scope.to}::date
      AND r.check_out_date > ${scope.from}::date
      AND ${roomFilter(sql`r.room`, scope)}
      AND ${channelFilter(sql`r.channel`, scope)}
  `);
}

// ── Query 2: on-the-books curve, by class × stay month × checkpoint ──────────

interface CurveDb {
  class_id: string;
  month: string;
  days_before: number;
  on_books: number;
}

interface CapacityDb {
  class_id: string;
  month: string;
  available: number;
  /** Sellable nights before today — the denominator for the reconstructed curve. */
  available_completed: number;
  sold: number;
}

/**
 * How many of each COMPLETED night's room-nights were on the books N days before
 * that night — booked by then and not yet cancelled at that moment.
 *
 * Measured per night, not per month start: a month's last night is thirty days
 * further out than its first on any given day, so a month-start curve blends
 * thirty different lead times into one point.
 */
async function readCurve(scope: AnalyticsScope, todayIso: string): Promise<CurveDb[]> {
  const lastNight = addDays(todayIso, -1) < scope.to ? addDays(todayIso, -1) : scope.to;
  if (lastNight < scope.from) return [];
  return query<CurveDb>(sql`
    ${baseCtes(scope)},
    checkpoints AS (
      SELECT * FROM (VALUES ${sql.join(
        CURVE_CHECKPOINTS.map((d) => sql`(${d}::int)`),
        sql`, `,
      )}) AS v(days_before)
    )
    SELECT
      ${classIdOf(sql`a.room`)}                  AS class_id,
      to_char(a.stay_date, 'YYYY-MM')            AS month,
      c.days_before                              AS days_before,
      COUNT(*) FILTER (
        WHERE a.booked_on <= a.stay_date - c.days_before
          AND (a.cancelled_at IS NULL OR a.cancelled_at::date > a.stay_date - c.days_before)
      )::int                                     AS on_books
    FROM asof_nights a
    CROSS JOIN checkpoints c
    WHERE a.stay_date BETWEEN ${scope.from}::date AND ${lastNight}::date
      AND ${roomFilter(sql`a.room`, scope)}
      AND ${channelFilter(sql`a.channel`, scope)}
      AND ${classIdOf(sql`a.room`)} <> 'other'
    GROUP BY 1, 2, 3
  `);
}

/** Sellable nights and sold nights per class × month — the capacity check. */
async function readCapacity(scope: AnalyticsScope, todayIso: string): Promise<CapacityDb[]> {
  return query<CapacityDb>(sql`
    ${baseCtes(scope)},
    cap AS (
      SELECT ${classIdOf(sql`available.room`)} AS class_id,
             to_char(available.stay_date, 'YYYY-MM') AS month,
             COUNT(*)::int AS available,
             COUNT(*) FILTER (WHERE available.stay_date < ${todayIso}::date)::int AS available_completed
      FROM available
      GROUP BY 1, 2
    ),
    sold AS (
      SELECT ${classIdOf(sql`nights.room`)} AS class_id,
             to_char(nights.stay_date, 'YYYY-MM') AS month,
             COUNT(*)::int AS sold
      FROM nights
      WHERE nights.stay_date BETWEEN ${scope.from}::date AND ${scope.to}::date
        AND ${roomFilter(sql`nights.room`, scope)}
        AND ${channelFilter(sql`nights.channel`, scope)}
      GROUP BY 1, 2
    )
    SELECT COALESCE(c.class_id, s.class_id)   AS class_id,
           COALESCE(c.month, s.month)         AS month,
           COALESCE(c.available, 0)           AS available,
           COALESCE(c.available_completed, 0) AS available_completed,
           COALESCE(s.sold, 0)                AS sold
    FROM cap c
    FULL OUTER JOIN sold s ON s.class_id = c.class_id AND s.month = c.month
    WHERE COALESCE(c.class_id, s.class_id) <> 'other'
  `);
}

// ── Query 3: the forward book against the market ─────────────────────────────

interface ForwardDb {
  class_id: string;
  stay_date: string;
  available: number;
  on_books: number;
}

/**
 * Nights on the books today for every night of the next 180 days.
 *
 * Ignores the selected period (a forward question) and the channel filter (the
 * market comparison is total demand — filtering to one channel would report a gap
 * that is really channel mix). The room filter still applies.
 */
async function readForward(scope: AnalyticsScope, todayIso: string): Promise<ForwardDb[]> {
  const forwardScope: AnalyticsScope = {
    ...scope,
    channels: [],
    from: todayIso,
    to: addDays(todayIso, FORWARD_DAYS - 1),
  };
  return query<ForwardDb>(sql`
    ${baseCtes(forwardScope)},
    cap AS (
      SELECT ${classIdOf(sql`available.room`)} AS class_id, available.stay_date, COUNT(*)::int AS available
      FROM available
      GROUP BY 1, 2
    ),
    sold AS (
      SELECT ${classIdOf(sql`nights.room`)} AS class_id, nights.stay_date, COUNT(*)::int AS on_books
      FROM nights
      WHERE nights.stay_date BETWEEN ${forwardScope.from}::date AND ${forwardScope.to}::date
        AND ${roomFilter(sql`nights.room`, forwardScope)}
      GROUP BY 1, 2
    )
    SELECT c.class_id, c.stay_date::text AS stay_date, c.available, COALESCE(s.on_books, 0) AS on_books
    FROM cap c
    LEFT JOIN sold s ON s.class_id = c.class_id AND s.stay_date = c.stay_date
    WHERE c.class_id <> 'other'
    ORDER BY 2
  `);
}

interface MarketDailyDb {
  listing_id: string;
  stay_date: string;
  market_occupancy: number | null;
  captured_at: string | null;
}

interface MarketMonthlyDb {
  listing_id: string;
  month: string;
  market_booking_window: number | null;
}

async function readMarketSnapshots(todayIso: string): Promise<{
  daily: MarketDailyDb[];
  monthly: MarketMonthlyDb[];
}> {
  const [daily, monthly] = await Promise.all([
    query<MarketDailyDb>(sql`
      SELECT listing_id, stay_date::text AS stay_date, market_occupancy::float8 AS market_occupancy,
             captured_at::text AS captured_at
      FROM market_daily
      WHERE stay_date BETWEEN ${todayIso}::date AND ${addDays(todayIso, FORWARD_DAYS - 1)}::date
    `),
    query<MarketMonthlyDb>(sql`
      SELECT listing_id, month, market_booking_window::float8 AS market_booking_window
      FROM market_monthly
    `),
  ]);
  return { daily, monthly };
}

// ── Query 4: resale of cancelled nights ──────────────────────────────────────

interface ResaleDb {
  class_id: string;
  unit_id: string;
  stay_date: string;
  cancelled: number;
  cancelled_value: number | null;
  valued: number;
  capacity: number;
  final_sold: number;
  later_nights: number;
  later_value: number | null;
  later_lead: number | null;
}

/**
 * Guest-cancelled room-nights per sellable unit × night, with what happened next.
 *
 * Resale is judged at UNIT level (the Urban trio and the Deluxe pair are
 * interchangeable) and capacity-aware: a cancelled night counts as re-sold only to
 * the extent the unit ended up full that night. A later booking that merely took
 * a room that was free anyway did not replace anything — the cancellation still
 * cost a night. The re-sale PRICE is the average rate of the nights booked after
 * the cancellation, compared with the cancelled nights' own rate.
 */
async function readResale(scope: AnalyticsScope): Promise<ResaleDb[]> {
  return query<ResaleDb>(sql`
    ${baseCtes(scope)},
    ${BW_ROWS_CTE},
    cancelled AS (
      SELECT
        r.class_id,
        r.unit_id,
        d::date                                         AS stay_date,
        r.cancelled_at::date                            AS cancelled_on,
        r.cancelled_value / NULLIF(r.span_nights, 0)    AS night_value
      FROM bw_rows r
      CROSS JOIN generate_series(r.check_in_date, r.check_out_date - INTERVAL '1 day', INTERVAL '1 day') AS d
      WHERE r.is_cancelled
        AND r.cancel_class = 'guest'
        AND r.class_id <> 'other'
        AND d::date BETWEEN ${scope.from}::date AND ${scope.to}::date
        AND ${roomFilter(sql`r.room`, scope)}
        AND ${channelFilter(sql`r.channel`, scope)}
    ),
    per_night AS (
      SELECT class_id, unit_id, stay_date,
             COUNT(*)::int AS cancelled,
             SUM(night_value) AS cancelled_value,
             COUNT(night_value)::int AS valued,
             MIN(cancelled_on) AS first_cancel
      FROM cancelled
      GROUP BY 1, 2, 3
    ),
    cap AS (
      SELECT ${unitIdOf(sql`available.room`)} AS unit_id, available.stay_date, COUNT(*)::int AS capacity
      FROM available
      GROUP BY 1, 2
    ),
    sold AS (
      SELECT ${unitOfLabel(sql`nights.room`)} AS unit_id, nights.stay_date,
             nights.night_price, nights.reservation_date
      FROM nights
      WHERE nights.stay_date BETWEEN ${scope.from}::date AND ${scope.to}::date
    )
    SELECT
      p.class_id,
      p.unit_id,
      p.stay_date::text                                       AS stay_date,
      p.cancelled,
      p.cancelled_value::float8                               AS cancelled_value,
      p.valued,
      COALESCE(c.capacity, 0)                                 AS capacity,
      (SELECT COUNT(*)::int FROM sold s
        WHERE s.unit_id = p.unit_id AND s.stay_date = p.stay_date) AS final_sold,
      (SELECT COUNT(*)::int FROM sold s
        WHERE s.unit_id = p.unit_id AND s.stay_date = p.stay_date
          AND s.reservation_date >= p.first_cancel)           AS later_nights,
      (SELECT AVG(s.night_price)::float8 FROM sold s
        WHERE s.unit_id = p.unit_id AND s.stay_date = p.stay_date
          AND s.reservation_date >= p.first_cancel)           AS later_value,
      (SELECT AVG(s.stay_date - s.reservation_date)::float8 FROM sold s
        WHERE s.unit_id = p.unit_id AND s.stay_date = p.stay_date
          AND s.reservation_date >= p.first_cancel)           AS later_lead
    FROM per_night p
    LEFT JOIN cap c ON c.unit_id = p.unit_id AND c.stay_date = p.stay_date
  `);
}

// ── Query 5: when the nights were booked ─────────────────────────────────────

interface ProductionDb {
  class_id: string;
  booked_month: string;
  stay_month: string;
  nights: number;
}

interface NightLeadDb {
  class_id: string;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  nights: number;
}

interface TrendDb {
  class_id: string;
  month: string;
  bookings: number;
  median_lead: number | null;
  avg_lead: number | null;
}

/** Sold nights in the window by the month they were BOOKED × the month they are STAYED. */
async function readProduction(scope: AnalyticsScope): Promise<ProductionDb[]> {
  return query<ProductionDb>(sql`
    ${baseCtes(scope)}
    SELECT ${classIdOf(sql`nights.room`)}            AS class_id,
           to_char(nights.reservation_date, 'YYYY-MM') AS booked_month,
           to_char(nights.stay_date, 'YYYY-MM')        AS stay_month,
           COUNT(*)::int                               AS nights
    FROM nights
    WHERE ${classIdOf(sql`nights.room`)} <> 'other'
      AND nights.stay_date BETWEEN ${scope.from}::date AND ${scope.to}::date
      AND nights.reservation_date IS NOT NULL
      AND ${roomFilter(sql`nights.room`, scope)}
      AND ${channelFilter(sql`nights.channel`, scope)}
    GROUP BY 1, 2, 3
  `);
}

/**
 * Night-level lead percentiles: "x % of the nights we sell are booked at least
 * L days before that night". Completed nights only — a future night's lead is
 * still growing. These drive the promo calendar's "booked by" dates.
 */
async function readNightLeads(scope: AnalyticsScope, todayIso: string): Promise<NightLeadDb[]> {
  return query<NightLeadDb>(sql`
    ${baseCtes(scope)},
    leads AS (
      SELECT ${classIdOf(sql`nights.room`)} AS class_id,
             (nights.stay_date - nights.reservation_date) AS lead
      FROM nights
      WHERE nights.stay_date BETWEEN ${scope.from}::date AND LEAST(${scope.to}::date, ${todayIso}::date - 1)
        AND nights.reservation_date IS NOT NULL
        AND ${roomFilter(sql`nights.room`, scope)}
        AND ${channelFilter(sql`nights.channel`, scope)}
    )
    SELECT class_id,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY lead)::float8 AS p25,
           percentile_cont(0.50) WITHIN GROUP (ORDER BY lead)::float8 AS p50,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY lead)::float8 AS p75,
           percentile_cont(0.90) WITHIN GROUP (ORDER BY lead)::float8 AS p90,
           COUNT(*)::int AS nights
    FROM leads
    WHERE class_id <> 'other'
    GROUP BY ROLLUP (class_id)
  `);
}

/**
 * Booking window by the month the booking was MADE, across the whole history —
 * "is our booking window moving?" is a production-over-time question the stay
 * window would distort.
 */
async function readTrend(scope: AnalyticsScope): Promise<TrendDb[]> {
  return query<TrendDb>(sql`
    ${baseCtes(scope)},
    b AS (
      SELECT DISTINCT ${classIdOf(sql`alloc.room`)} AS class_id, alloc.reservation_number,
             alloc.reservation_date, (alloc.check_in_date - alloc.reservation_date) AS lead
      FROM alloc
      WHERE alloc.is_blackout = false AND alloc.is_cancelled = false
        AND alloc.reservation_date IS NOT NULL
        AND ${roomFilter(sql`alloc.room`, scope)}
        AND ${channelFilter(sql`alloc.channel`, scope)}
    )
    SELECT COALESCE(class_id, 'all')                                  AS class_id,
           to_char(reservation_date, 'YYYY-MM')                       AS month,
           COUNT(DISTINCT reservation_number)::int                    AS bookings,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY lead)::float8  AS median_lead,
           AVG(lead)::float8                                          AS avg_lead
    FROM b
    WHERE class_id <> 'other'
    GROUP BY GROUPING SETS ((class_id, to_char(reservation_date, 'YYYY-MM')), (to_char(reservation_date, 'YYYY-MM')))
    ORDER BY 2
  `);
}

// ── Turnover cost per booking-room ───────────────────────────────────────────

const BEDS24_TO_ROOM: Record<string, string> = Object.fromEntries(
  Object.entries(ROOM_TO_BEDS24_ID).map(([room, id]) => [id, room]),
);

/**
 * Attach the turnover cost of each booking-room's checkout.
 *
 * Same rule as the Costs tab: the cleaning + laundry + consumables cell logged
 * against (checkout date, room). A stay with no cell — a pre-Beds24 legacy stay,
 * a checkout still in the future, or a gap in the cleaning log — is charged its
 * class's average turnover per checkout instead of zero. Zero would make exactly
 * the stays nobody has costed yet look the most profitable, and the far-out bands
 * are full of future checkouts.
 */
function attachTurnover(
  rows: RowDb[],
  cells: Map<string, number> | null,
): { rows: Row[]; imputed: number; costed: number } {
  const base = rows.map<Row>((r) => {
    const key = `${r.check_out}|${r.room}`;
    const cell = cells?.get(key);
    return {
      reservation: r.reservation_number,
      room: r.room,
      classId: r.class_id === '2kk' ? '2kk' : '1kk',
      channel: r.channel ?? 'Unknown',
      checkIn: r.check_in,
      checkOut: r.check_out,
      bookedOn: r.booked_on,
      leadDays: Math.max(0, n(r.lead_days)),
      span: n(r.span),
      nightsInScope: n(r.nights_in_scope),
      isCancelled: !!r.is_cancelled,
      cancelClass: r.cancel_class,
      cancelledOn: r.cancelled_on,
      price: n(r.price),
      commission: n(r.commission),
      fee: n(r.fee),
      cancelledValue: r.cancelled_value == null ? null : n(r.cancelled_value),
      bookDow: r.book_dow == null ? null : n(r.book_dow),
      bookHour: r.book_hour == null ? null : n(r.book_hour),
      turnover: cell ?? 0,
      turnoverImputed: cell == null,
    };
  });

  if (!cells) return { rows: base, imputed: 0, costed: 0 };

  const avg = new Map<string, number>();
  for (const cls of ['1kk', '2kk'] as const) {
    const costed = base.filter((r) => !r.isCancelled && r.classId === cls && !r.turnoverImputed && r.turnover > 0);
    avg.set(cls, mean(costed.map((r) => r.turnover)));
  }
  let imputed = 0;
  let costed = 0;
  for (const r of base) {
    if (r.isCancelled) continue;
    if (r.turnoverImputed || r.turnover <= 0) {
      r.turnover = avg.get(r.classId) ?? 0;
      r.turnoverImputed = true;
      imputed += 1;
    } else {
      costed += 1;
    }
  }
  return { rows: base, imputed, costed };
}

async function readTurnoverCells(scope: AnalyticsScope): Promise<Map<string, number> | null> {
  const costs = await computeVariableCosts();
  if (!costs) return null;
  const cells = new Map<string, number>();
  for (const [key, entry] of Object.entries(costs.byDateRoom)) {
    const [date, roomId] = key.split('|');
    const room = BEDS24_TO_ROOM[roomId ?? ''];
    if (!date || !room) continue;
    // Checkouts can fall a stay-length after the window ends.
    if (date < scope.from) continue;
    const total = TURNOVER_COST_KEYS.reduce((acc, k) => acc + (entry[k] ?? 0), 0);
    cells.set(`${date}|${room}`, total);
  }
  return cells;
}

// ── Assembly ─────────────────────────────────────────────────────────────────

function inClass(cls: ClassKey) {
  return (r: { classId: string }) => cls === 'all' || r.classId === cls;
}

/** Iterate the in-window nights of a row, yielding each night's month. */
function* monthsOfNights(r: Row, scope: AnalyticsScope): Generator<string> {
  const start = r.checkIn > scope.from ? r.checkIn : scope.from;
  for (let i = 0; i < r.span; i++) {
    const d = addDays(r.checkIn, i);
    if (d < start) continue;
    if (d > scope.to) break;
    yield d.slice(0, 7);
  }
}

interface Money {
  nights: number;
  gbv: number;
  net: number;
  turnover: number;
}

function moneyOf(r: Row): Money {
  const f = ratio(r.nightsInScope, r.span);
  return {
    nights: r.nightsInScope,
    gbv: r.price * f,
    net: (r.price - r.commission - r.fee) * f,
    turnover: r.turnover * f,
  };
}

function addMoney(acc: Money, m: Money): void {
  acc.nights += m.nights;
  acc.gbv += m.gbv;
  acc.net += m.net;
  acc.turnover += m.turnover;
}

const zeroMoney = (): Money => ({ nights: 0, gbv: 0, net: 0, turnover: 0 });

function buildClassBlock(
  cls: ClassKey,
  rows: Row[],
  scope: AnalyticsScope,
  todayIso: string,
  ctx: {
    curve: CurveDb[];
    capacity: CapacityDb[];
    /** Whole trading history, for judging today's forward book. */
    historyCurve: CurveDb[];
    historyCapacity: CapacityDb[];
    forward: ForwardDb[];
    marketDaily: MarketDailyDb[];
    marketMonthly: MarketMonthlyDb[];
    resale: ResaleDb[];
    production: ProductionDb[];
    nightLeads: NightLeadDb[];
    trend: TrendDb[];
  },
): BookingWindowClassBlock {
  const meta = ROOM_CLASSES.find((c) => c.id === cls);
  const label = meta?.label ?? 'All units';
  const classRows = rows.filter(inClass(cls));
  const classMatch = (id: string) => cls === 'all' || id === cls;

  const roomsInScope = (meta ? meta.rooms : ROOM_CLASSES.flatMap((c) => c.rooms)).filter(
    (room) => scope.rooms.length === 0 || scope.rooms.includes(room),
  );

  // ── Stay basis: surviving nights inside the window ────────────────────────
  const live = classRows.filter((r) => !r.isCancelled && r.nightsInScope > 0);

  // Class × month average GP per night — the seasonality control for the index.
  const monthMoney = new Map<string, Money>();
  for (const r of live) {
    const perNight = { gbv: r.price / r.span, net: (r.price - r.commission - r.fee) / r.span, turnover: r.turnover / r.span };
    for (const month of monthsOfNights(r, scope)) {
      const key = `${r.classId}|${month}`;
      const acc = monthMoney.get(key) ?? zeroMoney();
      acc.nights += 1;
      acc.gbv += perNight.gbv;
      acc.net += perNight.net;
      acc.turnover += perNight.turnover;
      monthMoney.set(key, acc);
    }
  }
  const monthGpPerNight = (key: string) => {
    const m = monthMoney.get(key);
    return m ? ratio(m.net - m.turnover, m.nights) : 0;
  };
  const monthNetAdr = (key: string) => {
    const m = monthMoney.get(key);
    return m ? ratio(m.net, m.nights) : 0;
  };

  // ── Booked basis: arrivals inside the window, guest cancellations only ────
  const arrivals = classRows.filter(
    (r) => r.checkIn >= scope.from && r.checkIn <= scope.to && r.cancelClass !== 'abandoned',
  );
  // A booking counts once per class block, however many rooms it holds.
  const bookingsOf = (list: Row[]) => new Set(list.map((r) => r.reservation)).size;

  const bands: BookingWindowBandRow[] = WINDOW_BANDS.map((b) => {
    const inBand = (r: Row) => bandOf(r.leadDays).id === b.id;
    const money = zeroMoney();
    let expectedGp = 0;
    let expectedNet = 0;
    const bandLive = live.filter(inBand);
    for (const r of bandLive) {
      addMoney(money, moneyOf(r));
      for (const month of monthsOfNights(r, scope)) {
        expectedGp += monthGpPerNight(`${r.classId}|${month}`);
        expectedNet += monthNetAdr(`${r.classId}|${month}`);
      }
    }
    const bandArrivals = arrivals.filter(inBand);
    const cancelled = bandArrivals.filter((r) => r.isCancelled);
    const gp = money.net - money.turnover;
    const bookedNights = bandArrivals.reduce((a, r) => a + r.span, 0);
    const cancelledNights = cancelled.reduce((a, r) => a + r.span, 0);
    const survivingArrivals = bandArrivals.filter((r) => !r.isCancelled);
    return {
      id: b.id,
      label: b.label,
      minDays: b.min,
      maxDays: b.max,
      bookings: bookingsOf(survivingArrivals),
      nights: money.nights,
      nightShare: 0, // filled below
      gbv: money.gbv,
      netSales: money.net,
      turnoverCost: money.turnover,
      grossProfit: gp,
      adr: ratio(money.gbv, money.nights),
      netAdr: ratio(money.net, money.nights),
      turnoverPerNight: ratio(money.turnover, money.nights),
      gpPerNight: ratio(gp, money.nights),
      gpIndex: expectedGp > 0 && money.nights > 0 ? gp / expectedGp : null,
      netAdrIndex: expectedNet > 0 && money.nights > 0 ? money.net / expectedNet : null,
      avgLos: mean(survivingArrivals.map((r) => r.span)),
      bookedBookings: bookingsOf(bandArrivals),
      cancelledBookings: bookingsOf(cancelled),
      cancellationRate: ratio(bookingsOf(cancelled), bookingsOf(bandArrivals)),
      cancelledNightShare: ratio(cancelledNights, bookedNights),
    };
  });
  const totalNights = bands.reduce((a, b) => a + b.nights, 0);
  for (const b of bands) b.nightShare = ratio(b.nights, totalNights);

  // ── On-the-books curve ────────────────────────────────────────────────────
  const capRows = ctx.capacity.filter((c) => classMatch(c.class_id));
  const currentMonth = todayIso.slice(0, 7);
  const { curve, onBooksBy, availCompleted } = pooledCurve(ctx.curve, ctx.capacity, classMatch);
  const curveAt = (d: number) => curve.find((p) => p.daysBefore === d)?.occupancy ?? 0;

  // The benchmark for TODAY's forward book is the whole trading history, not the
  // selected period — "Next 90 days" has no completed nights of its own, and a
  // short period is too thin a history to judge pace against.
  const history = pooledCurve(ctx.historyCurve, ctx.historyCapacity, classMatch).curve;
  const hasHistory = curvePointsAvailable(history);
  /** History-implied occupancy on the books at an arbitrary lead, interpolated. */
  const historyAt = (lead: number): number => {
    const pts = [...history].sort((a, b) => a.daysBefore - b.daysBefore);
    if (pts.length === 0) return 0;
    if (lead <= pts[0].daysBefore) return pts[0].occupancy;
    for (let i = 1; i < pts.length; i++) {
      if (lead <= pts[i].daysBefore) {
        const a = pts[i - 1];
        const b = pts[i];
        const t = (lead - a.daysBefore) / (b.daysBefore - a.daysBefore);
        return a.occupancy + (b.occupancy - a.occupancy) * t;
      }
    }
    return pts[pts.length - 1].occupancy;
  };

  // ── Market: capacity-weighted across the class's listings ─────────────────
  const listingWeights = new Map<string, number>();
  for (const unit of unitsInScope(scope)) {
    const unitClass = ROOM_CLASSES.find((c) => unit.rooms.some((r) => c.rooms.includes(r)));
    if (!unitClass || !classMatch(unitClass.id) || !unit.priceLabsListingId) continue;
    const rooms = unit.rooms.filter((r) => scope.rooms.length === 0 || scope.rooms.includes(r)).length;
    if (rooms > 0) listingWeights.set(unit.priceLabsListingId, rooms);
  }
  const marketByDate = new Map<string, { sum: number; weight: number }>();
  for (const m of ctx.marketDaily) {
    const w = listingWeights.get(m.listing_id);
    if (!w || m.market_occupancy == null) continue;
    const acc = marketByDate.get(m.stay_date) ?? { sum: 0, weight: 0 };
    acc.sum += n(m.market_occupancy) * w;
    acc.weight += w;
    marketByDate.set(m.stay_date, acc);
  }
  const marketLeadByMonth = new Map<string, { sum: number; weight: number }>();
  for (const m of ctx.marketMonthly) {
    const w = listingWeights.get(m.listing_id);
    if (!w || m.market_booking_window == null) continue;
    const acc = marketLeadByMonth.get(m.month) ?? { sum: 0, weight: 0 };
    acc.sum += n(m.market_booking_window) * w;
    acc.weight += w;
    marketLeadByMonth.set(m.month, acc);
  }
  const marketLeadOf = (month: string) => {
    const acc = marketLeadByMonth.get(month);
    return acc && acc.weight > 0 ? acc.sum / acc.weight : null;
  };

  // ── Forward book by horizon ───────────────────────────────────────────────
  const fwdRows = ctx.forward.filter((f) => classMatch(f.class_id));
  const fwdByDate = new Map<string, { available: number; onBooks: number }>();
  for (const f of fwdRows) {
    const acc = fwdByDate.get(f.stay_date) ?? { available: 0, onBooks: 0 };
    acc.available += n(f.available);
    acc.onBooks += n(f.on_books);
    fwdByDate.set(f.stay_date, acc);
  }
  const forward: BookingWindowForwardBand[] = FORWARD_BANDS.map((b) => {
    let available = 0;
    let onBooks = 0;
    let expected = 0;
    let mSum = 0;
    let mWeight = 0;
    for (const [date, v] of fwdByDate) {
      const lead = daysBetween(todayIso, date);
      if (lead < b.min || lead > b.max) continue;
      available += v.available;
      onBooks += v.onBooks;
      expected += v.available * historyAt(lead);
      const m = marketByDate.get(date);
      if (m && m.weight > 0) {
        mSum += (m.sum / m.weight) * v.available;
        mWeight += v.available;
      }
    }
    return {
      label: b.label,
      minDays: b.min,
      maxDays: b.max,
      availableNights: available,
      onBooks,
      occupancy: ratio(onBooks, available),
      historyOccupancy: hasHistory ? ratio(expected, available) : null,
      marketOccupancy: mWeight > 0 ? mSum / mWeight : null,
    };
  });

  // ── Months ────────────────────────────────────────────────────────────────
  const capByMonth = new Map<string, { available: number; sold: number }>();
  for (const c of capRows) {
    const acc = capByMonth.get(c.month) ?? { available: 0, sold: 0 };
    acc.available += n(c.available);
    acc.sold += n(c.sold);
    capByMonth.set(c.month, acc);
  }
  const months: BookingWindowMonthRow[] = [...capByMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => {
      const keys = cls === 'all' ? ['1kk|' + month, '2kk|' + month] : [`${cls}|${month}`];
      const money = zeroMoney();
      for (const k of keys) {
        const m = monthMoney.get(k);
        if (m) addMoney(money, m);
      }
      const monthArrivals = arrivals.filter((r) => !r.isCancelled && r.checkIn.slice(0, 7) === month);
      const leads = monthArrivals.map((r) => r.leadDays);
      const avail = availCompleted.get(month) ?? 0;
      const otb = (d: number) => (avail > 0 ? ratio(onBooksBy.get(`${month}|${d}`) ?? 0, avail) : null);
      return {
        month,
        availableNights: v.available,
        soldNights: v.sold,
        occupancy: ratio(v.sold, v.available),
        otb60: otb(60),
        otb30: otb(30),
        otb14: otb(14),
        otb7: otb(7),
        netAdr: ratio(money.net, money.nights),
        gpPerNight: ratio(money.net - money.turnover, money.nights),
        gpPerAvailableNight: ratio(money.net - money.turnover, v.available),
        avgLeadDays: leads.length > 0 ? mean(leads) : null,
        marketAvgLeadDays: marketLeadOf(month),
        inProgress: monthEnd(month) >= todayIso,
      };
    });

  // ── Channels ──────────────────────────────────────────────────────────────
  const channels = [...new Set(classRows.map((r) => r.channel))];
  const channelRows: BookingWindowChannelRow[] = channels
    .map((channel) => {
      const chLive = live.filter((r) => r.channel === channel);
      const money = zeroMoney();
      for (const r of chLive) addMoney(money, moneyOf(r));
      const chArrivals = arrivals.filter((r) => r.channel === channel);
      const survivors = chArrivals.filter((r) => !r.isCancelled);
      const leads = [...survivors.map((r) => r.leadDays)].sort((a, b) => a - b);
      const nights15 = chLive.filter((r) => r.leadDays >= 15).reduce((a, r) => a + r.nightsInScope, 0);
      const gp = money.net - money.turnover;
      return {
        channel,
        bookings: bookingsOf(survivors),
        nights: money.nights,
        nightShare: ratio(money.nights, totalNights),
        adr: ratio(money.gbv, money.nights),
        netAdr: ratio(money.net, money.nights),
        gpPerNight: ratio(gp, money.nights),
        grossProfit: gp,
        avgLos: mean(survivors.map((r) => r.span)),
        medianLeadDays: leads.length > 0 ? quantile(leads, 0.5) : null,
        share15Plus: ratio(nights15, money.nights),
        bookedBookings: bookingsOf(chArrivals),
        cancellationRate: ratio(bookingsOf(chArrivals.filter((r) => r.isCancelled)), bookingsOf(chArrivals)),
        bands: WINDOW_BANDS.map((b) => {
          const m = zeroMoney();
          for (const r of chLive) if (bandOf(r.leadDays).id === b.id) addMoney(m, moneyOf(r));
          return { id: b.id, nights: m.nights, gpPerNight: m.nights > 0 ? ratio(m.net - m.turnover, m.nights) : null };
        }),
      };
    })
    .filter((c) => c.nights > 0 || c.bookedBookings > 0)
    .sort((a, b) => b.nights - a.nights);

  // ── Cancellations & resale ────────────────────────────────────────────────
  const cancelledArrivals = arrivals.filter((r) => r.isCancelled);
  const notice = cancelledArrivals
    .filter((r) => r.cancelledOn)
    .map((r) => daysBetween(r.cancelledOn as string, r.checkIn));
  const noticeBuckets = [
    { label: 'Over 30 days before', test: (d: number) => d > 30 },
    { label: '8–30 days before', test: (d: number) => d > 7 && d <= 30 },
    { label: '4–7 days before', test: (d: number) => d > 3 && d <= 7 },
    { label: '1–3 days before', test: (d: number) => d >= 1 && d <= 3 },
    { label: 'Day of arrival or later', test: (d: number) => d <= 0 },
  ].map((b) => {
    const count = notice.filter(b.test).length;
    return { label: b.label, cancelled: count, share: ratio(count, notice.length) };
  });

  const resaleRows = ctx.resale.filter((r) => classMatch(r.class_id));
  let pastCancelled = 0;
  let resold = 0;
  let openNights = 0;
  let cancelledValue = 0;
  let cancelledValued = 0;
  let resoldOriginalValue = 0;
  let resoldNewValue = 0;
  let resoldLeadSum = 0;
  let resoldLeadWeight = 0;
  for (const r of resaleRows) {
    const c = n(r.cancelled);
    cancelledValue += n(r.cancelled_value);
    cancelledValued += n(r.valued);
    if (r.stay_date >= todayIso) {
      openNights += c;
      continue;
    }
    pastCancelled += c;
    const empty = Math.max(0, n(r.capacity) - n(r.final_sold));
    const recovered = Math.max(0, Math.min(c, n(r.later_nights), c - Math.min(c, empty)));
    resold += recovered;
    if (recovered > 0 && r.later_value != null && n(r.valued) > 0) {
      resoldOriginalValue += (n(r.cancelled_value) / n(r.valued)) * recovered;
      resoldNewValue += n(r.later_value) * recovered;
      if (r.later_lead != null) {
        resoldLeadSum += n(r.later_lead) * recovered;
        resoldLeadWeight += recovered;
      }
    }
  }

  const cancellations: BookingWindowCancellations = {
    bookedBookings: bookingsOf(arrivals),
    cancelledBookings: bookingsOf(cancelledArrivals),
    cancellationRate: ratio(bookingsOf(cancelledArrivals), bookingsOf(arrivals)),
    cancelledNights: resaleRows.reduce((a, r) => a + n(r.cancelled), 0),
    cancelledValue,
    unvaluedNights: resaleRows.reduce((a, r) => a + n(r.cancelled) - n(r.valued), 0),
    avgNoticeDays: notice.length > 0 ? mean(notice) : null,
    notice: noticeBuckets.filter((b) => b.cancelled > 0),
    pastCancelledNights: pastCancelled,
    resoldNights: resold,
    lostNights: pastCancelled - resold,
    openNights,
    resaleRate: pastCancelled > 0 ? resold / pastCancelled : null,
    resalePriceRatio: resoldOriginalValue > 0 ? resoldNewValue / resoldOriginalValue : null,
    resaleLeadDays: resoldLeadWeight > 0 ? resoldLeadSum / resoldLeadWeight : null,
    lostValue:
      pastCancelled > 0 && cancelledValued > 0
        ? (cancelledValue / cancelledValued) * (pastCancelled - resold)
        : 0,
  };

  // ── When the nights were booked ───────────────────────────────────────────
  const production = new Map<string, number>();
  for (const p of ctx.production.filter((x) => classMatch(x.class_id))) {
    const key = `${p.booked_month}|${p.stay_month}`;
    production.set(key, (production.get(key) ?? 0) + n(p.nights));
  }
  const leadRow = ctx.nightLeads.find((x) => (cls === 'all' ? x.class_id == null : x.class_id === cls));
  const nightLeads = leadRow
    ? {
        p25: n(leadRow.p25),
        p50: n(leadRow.p50),
        p75: n(leadRow.p75),
        p90: n(leadRow.p90),
        nights: n(leadRow.nights),
      }
    : null;

  // ── Promo calendar ────────────────────────────────────────────────────────
  const promo: BookingWindowPromoRow[] = [];
  for (let k = 0; k < PROMO_MONTHS; k++) {
    const month = addMonths(currentMonth, k);
    let available = 0;
    let onBooks = 0;
    let expected = 0;
    let mSum = 0;
    let mWeight = 0;
    for (const [date, v] of fwdByDate) {
      if (date.slice(0, 7) !== month) continue;
      available += v.available;
      onBooks += v.onBooks;
      expected += v.available * historyAt(daysBetween(todayIso, date));
      const m = marketByDate.get(date);
      if (m && m.weight > 0) {
        mSum += (m.sum / m.weight) * v.available;
        mWeight += v.available;
      }
    }
    if (available === 0) continue;
    const mid = `${month}-15`;
    const bookedBy = (lead: number | undefined) =>
      lead == null || !nightLeads ? null : addDays(mid, -Math.round(lead));
    const pace = expected > 0 ? onBooks / expected : null;
    promo.push({
      month,
      availableNights: available,
      onBooks,
      occupancy: ratio(onBooks, available),
      expectedOccupancy: hasHistory ? ratio(expected, available) : null,
      marketOccupancy: mWeight > 0 ? mSum / mWeight : null,
      pace,
      status:
        pace == null || expected / available < TOO_EARLY_OCCUPANCY
          ? 'too-early'
          : pace < PACE_BEHIND
            ? 'behind'
            : pace > PACE_AHEAD
              ? 'ahead'
              : 'on-pace',
      quarterBookedBy: bookedBy(nightLeads?.p75),
      halfBookedBy: bookedBy(nightLeads?.p50),
      threeQuartersBookedBy: bookedBy(nightLeads?.p25),
    });
  }

  // ── Booking clock ─────────────────────────────────────────────────────────
  const heat = new Map<string, number>();
  for (const r of arrivals) {
    if (r.isCancelled || r.bookDow == null || r.bookHour == null) continue;
    const key = `${r.bookDow}|${r.bookHour}`;
    heat.set(key, (heat.get(key) ?? 0) + 1);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const survivorsArriving = arrivals.filter((r) => !r.isCancelled);
  const bookingLeads = [
    ...new Map(survivorsArriving.map((r) => [r.reservation, r.leadDays])).values(),
  ].sort((a, b) => a - b);
  const allMoney = zeroMoney();
  for (const r of live) addMoney(allMoney, moneyOf(r));
  const gpOf = (pred: (r: Row) => boolean) => {
    const m = zeroMoney();
    for (const r of live) if (pred(r)) addMoney(m, moneyOf(r));
    return m.nights > 0 ? { gpPerNight: ratio(m.net - m.turnover, m.nights), nights: m.nights } : null;
  };
  const nightsWhere = (pred: (r: Row) => boolean) =>
    live.filter(pred).reduce((a, r) => a + r.nightsInScope, 0);
  const availableTotal = [...capByMonth.values()].reduce((a, v) => a + v.available, 0);
  const marketLeads = months
    .filter((m) => !m.inProgress && m.marketAvgLeadDays != null)
    .map((m) => m.marketAvgLeadDays as number);
  const ourMonthLeads = months
    .filter((m) => !m.inProgress && m.marketAvgLeadDays != null && m.avgLeadDays != null)
    .map((m) => m.avgLeadDays as number);

  return {
    classId: cls,
    label,
    description: meta?.description ?? 'All seven apartments',
    rooms: roomsInScope,
    summary: {
      bookings: bookingLeads.length,
      medianLeadDays: quantile(bookingLeads, 0.5),
      avgLeadDays: mean(bookingLeads),
      p90LeadDays: quantile(bookingLeads, 0.9),
      nights: allMoney.nights,
      availableNights: availableTotal,
      grossProfit: allMoney.net - allMoney.turnover,
      gpPerNight: ratio(allMoney.net - allMoney.turnover, allMoney.nights),
      gpPerAvailableNight: ratio(allMoney.net - allMoney.turnover, availableTotal),
      netAdr: ratio(allMoney.net, allMoney.nights),
      shareWithin7: ratio(nightsWhere((r) => r.leadDays <= 7), allMoney.nights),
      share15Plus: ratio(nightsWhere((r) => r.leadDays >= 15), allMoney.nights),
      share30Plus: ratio(nightsWhere((r) => r.leadDays >= 30), allMoney.nights),
      gpWithin7: gpOf((r) => r.leadDays <= 7),
      gp8to29: gpOf((r) => r.leadDays >= 8 && r.leadDays <= 29),
      gp30Plus: gpOf((r) => r.leadDays >= 30),
      otbAt60: curvePointsAvailable(curve) ? curveAt(60) : null,
      otbAt30: curvePointsAvailable(curve) ? curveAt(30) : null,
      otbAt14: curvePointsAvailable(curve) ? curveAt(14) : null,
      otbAt7: curvePointsAvailable(curve) ? curveAt(7) : null,
      finalOccupancy: curvePointsAvailable(curve) ? curveAt(0) : null,
      cancellationRate: cancellations.cancellationRate,
      resaleRate: cancellations.resaleRate,
      ourAvgLeadVsMarket: ourMonthLeads.length > 0 ? mean(ourMonthLeads) : null,
      marketAvgLeadDays: marketLeads.length > 0 ? mean(marketLeads) : null,
    },
    bands,
    curve,
    forward,
    months,
    channels: channelRows,
    cancellations,
    production: [...production.entries()].map(([key, nights]) => {
      const [bookedMonth, stayMonth] = key.split('|');
      return { bookedMonth, stayMonth, nights };
    }),
    nightLeads,
    promo,
    heat: [...heat.entries()].map(([key, bookings]) => {
      const [dow, hour] = key.split('|').map(Number);
      return { isoDow: dow, hour, bookings };
    }),
    trend: ctx.trend
      .filter((t) => t.class_id === cls)
      .map((t) => ({
        month: t.month,
        bookings: n(t.bookings),
        medianLeadDays: n(t.median_lead),
        avgLeadDays: n(t.avg_lead),
      })),
  };
}

/**
 * Pool the per-month on-the-books counts into one curve: room-nights on the books
 * N days out ÷ sellable room-nights, over every completed night. The current
 * month counts only its elapsed nights, so it is not diluted by nights that are
 * still selling.
 */
function pooledCurve(
  curveRowsAll: CurveDb[],
  capacityAll: CapacityDb[],
  classMatch: (id: string) => boolean,
) {
  const availCompleted = new Map<string, number>();
  for (const c of capacityAll) {
    if (!classMatch(c.class_id)) continue;
    availCompleted.set(c.month, (availCompleted.get(c.month) ?? 0) + n(c.available_completed));
  }
  const onBooksBy = new Map<string, number>(); // `${month}|${days}` → nights
  for (const c of curveRowsAll) {
    if (!classMatch(c.class_id)) continue;
    const key = `${c.month}|${n(c.days_before)}`;
    onBooksBy.set(key, (onBooksBy.get(key) ?? 0) + n(c.on_books));
  }
  const months = [...availCompleted.keys()];
  const pooledAvail = months.reduce((a, m) => a + (availCompleted.get(m) ?? 0), 0);
  const pooledAt = (d: number) => months.reduce((a, m) => a + (onBooksBy.get(`${m}|${d}`) ?? 0), 0);
  const finalPooled = pooledAt(0);
  const curve = CURVE_CHECKPOINTS.map((d) => ({
    daysBefore: d,
    occupancy: ratio(pooledAt(d), pooledAvail),
    shareOfFinal: ratio(pooledAt(d), finalPooled),
  }));
  return { curve, onBooksBy, availCompleted };
}

/** A curve with no completed nights behind it is not a history to compare against. */
function curvePointsAvailable(curve: { occupancy: number }[]): boolean {
  return curve.some((p) => p.occupancy > 0);
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function readBookingWindow(
  scope: AnalyticsScope,
  todayIso: string,
): Promise<BookingWindowResponse> {
  // Whole trading history up to yesterday, all channels — the benchmark for the
  // forward book and the promo calendar's "booked by" dates.
  const historyScope: AnalyticsScope = {
    from: HISTORY_FROM,
    to: addDays(todayIso, -1),
    rooms: scope.rooms,
    channels: [],
  };

  const [
    rawRows,
    cells,
    curve,
    capacity,
    historyCurve,
    historyCapacity,
    forward,
    market,
    resale,
    production,
    nightLeads,
    trend,
  ] = await Promise.all([
    readRows(scope),
    readTurnoverCells(scope).catch(() => null),
    readCurve(scope, todayIso),
    readCapacity(scope, todayIso),
    readCurve(historyScope, todayIso),
    readCapacity(historyScope, todayIso),
    readForward(scope, todayIso),
    readMarketSnapshots(todayIso),
    readResale(scope),
    readProduction(scope),
    readNightLeads(historyScope, todayIso),
    readTrend(scope),
  ]);

  const { rows, imputed, costed } = attachTurnover(rawRows, cells);

  const ctx = {
    curve,
    capacity,
    historyCurve,
    historyCapacity,
    forward,
    marketDaily: market.daily,
    marketMonthly: market.monthly,
    resale,
    production,
    nightLeads,
    trend,
  };

  const classes = CLASS_KEYS.map((cls) => buildClassBlock(cls, rows, scope, todayIso, ctx));

  // Capacity check: sellable nights per month against seven units × days.
  const totalRooms = SELLABLE_UNITS.flatMap((u) => u.rooms).filter(
    (room) => scope.rooms.length === 0 || scope.rooms.includes(room),
  ).length;
  const capMonths = [...new Set(capacity.map((c) => c.month))].sort();
  const capacityCheck = capMonths.map((month) => {
    const byClass: Record<string, number> = {};
    for (const c of capacity.filter((x) => x.month === month)) {
      byClass[c.class_id] = (byClass[c.class_id] ?? 0) + n(c.available);
    }
    const first = month === scope.from.slice(0, 7) ? scope.from : `${month}-01`;
    const last = monthEnd(month) > scope.to ? scope.to : monthEnd(month);
    const days = daysBetween(first, last) + 1;
    const total = Object.values(byClass).reduce((a, v) => a + v, 0);
    return {
      month,
      days,
      oneKk: byClass['1kk'] ?? 0,
      twoKk: byClass['2kk'] ?? 0,
      total,
      fullCapacity: totalRooms * days,
    };
  });

  const notes: string[] = [];
  if (!cells) {
    notes.push(
      'Turnover costs are unavailable in this environment (the cleaning rate cards live in Redis), so gross profit here equals net sales. The ranking between booking windows still holds; the levels do not.',
    );
  }
  const marketCaptured = market.daily.reduce<string | null>(
    (acc, m) => (m.captured_at && (!acc || m.captured_at > acc) ? m.captured_at : acc),
    null,
  );

  return {
    basis: 'booked',
    query: { from: scope.from, to: scope.to, rooms: scope.rooms, channels: scope.channels },
    todayIso,
    capacity: capacityCheck,
    classes,
    costCoverage: { costsAvailable: !!cells, costedStays: costed, imputedStays: imputed },
    market: market.daily.length > 0 ? { capturedAt: marketCaptured } : null,
    notes,
  };
}

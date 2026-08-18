/**
 * Market benchmark — our position against the Brno comp set.
 *
 * THE DIVISION OF LABOUR, WHICH IS THE WHOLE POINT
 * -----------------------------------------------
 * Our side always comes from `bookings_mirror`. The market side always comes from
 * the PriceLabs snapshot. MPI is computed HERE from those two, never taken from
 * PriceLabs' own `mpi` field.
 *
 * That is not fussiness. PriceLabs syncs at the sellable-listing level and does
 * not attribute Beds24's physical-room bookings back up to it, so its view of our
 * own performance reads 0.0% occupancy for both multi-unit virtual rooms — five of
 * our seven rooms are effectively invisible to it. Its market data, by contrast,
 * checked out: for K.201, where we compare 1:1, its inferred occupancy over the
 * trailing 90 days was 86.7% against our archive's 86.7%.
 *
 * So: take the benchmark, compute our own numerator, divide it ourselves.
 *
 * DEGRADATION, NOT FAILURE
 * ------------------------
 * No key, no snapshot yet, or a stale snapshot are all normal states, not errors.
 * The response still carries our own side in full and marks the market side
 * unavailable, so every chart that overlays a market reference line simply drops
 * the line instead of the section failing to load.
 */
import { sql } from 'drizzle-orm';
import type {
  HorizonPosition,
  MarketMonthPoint,
  MarketPricePoint,
  MarketResponse,
  UnitHorizons,
} from '@/utils/analyticsTypes';
import { baseCtes, n, query, ratio, unitIdOf, unitsInScope, type AnalyticsScope } from './shared';
import { priceLabsConfigured } from './marketTypes';

/** Horizons the snapshot stores, with the labels the UI shows. */
const HORIZONS: { days: number; label: string }[] = [
  { days: 7, label: 'Next 7 days' },
  { days: 30, label: 'Next 30 days' },
  { days: 60, label: 'Next 60 days' },
  { days: 90, label: 'Next 90 days' },
  { days: 180, label: 'Next 180 days' },
  { days: 360, label: 'Next 360 days' },
];

const MAX_HORIZON = 360;
const STALE_HOURS = 48;

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Our own forward position, from the archive ───────────────────────────────

interface ForwardRow {
  unit_id: string;
  horizon_days: number;
  sold_nights: number;
  available_nights: number;
}

/**
 * Nights on the books and nights available, per unit, for each horizon.
 *
 * One query for all six horizons: the horizon list is joined in as a VALUES list
 * and each row counts the nights inside its own window, so a booking spanning two
 * horizons is counted in both — which is what "position at 30 days" means. Six
 * separate round trips would return the same numbers more slowly.
 */
async function readForwardPosition(
  scope: AnalyticsScope,
  todayIso: string,
): Promise<ForwardRow[]> {
  // The CTE stack must cover the furthest horizon, not the filter window: this is
  // a forward-looking question and the user's selected period is irrelevant to it.
  const forwardScope: AnalyticsScope = {
    ...scope,
    from: todayIso,
    to: addDays(todayIso, MAX_HORIZON),
  };

  return query<ForwardRow>(sql`
    ${baseCtes(forwardScope)},
    horizons AS (
      SELECT * FROM (VALUES ${sql.join(
        HORIZONS.map((h) => sql`(${h.days}::int)`),
        sql`, `,
      )}) AS v(horizon_days)
    ),
    sold AS (
      SELECT
        ${unitIdOf(sql`nights.room`)} AS unit_id,
        h.horizon_days,
        COUNT(*)::int AS sold_nights
      FROM nights
      CROSS JOIN horizons h
      WHERE nights.stay_date >= ${todayIso}::date
        AND nights.stay_date < (${todayIso}::date + h.horizon_days)
      GROUP BY 1, 2
    ),
    avail AS (
      SELECT
        ${unitIdOf(sql`available.room`)} AS unit_id,
        h.horizon_days,
        COUNT(*)::int AS available_nights
      FROM available
      CROSS JOIN horizons h
      WHERE available.stay_date >= ${todayIso}::date
        AND available.stay_date < (${todayIso}::date + h.horizon_days)
      GROUP BY 1, 2
    )
    SELECT
      a.unit_id,
      a.horizon_days,
      COALESCE(s.sold_nights, 0) AS sold_nights,
      a.available_nights
    FROM avail a
    LEFT JOIN sold s ON s.unit_id = a.unit_id AND s.horizon_days = a.horizon_days
    ORDER BY 1, 2
  `);
}

// ── Snapshot reads ───────────────────────────────────────────────────────────

interface HorizonSnapshotRow {
  listing_id: string;
  horizon_days: number;
  market_occupancy: string | null;
  comp_set_listings: number | null;
  captured_at: string | null;
}

interface MonthlySnapshotRow {
  listing_id: string;
  month: string;
  market_booking_window: string | null;
  market_los: string | null;
  market_occupancy: string | null;
  market_adr: string | null;
}

interface DailySnapshotRow {
  listing_id: string;
  stay_date: string;
  p25: string | null;
  p50: string | null;
  p75: string | null;
  p90: string | null;
  median_booked_price: string | null;
  recommended_price: string | null;
  live_price: string | null;
  market_occupancy: string | null;
  market_supply: number | null;
}

const nullable = (value: string | null): number | null =>
  value === null || value === undefined ? null : n(value);

// ── Entry point ──────────────────────────────────────────────────────────────

export async function readMarket(scope: AnalyticsScope, todayIso: string): Promise<MarketResponse> {
  const units = unitsInScope(scope);
  const listingIds = units.map((u) => u.priceLabsListingId).filter((id): id is string => !!id);
  // Forward window for the price chart — a year ahead is what can be priced.
  const priceTo = addDays(todayIso, MAX_HORIZON);

  const [forward, horizonRows, monthlyRows, dailyRows, ourWindow] = await Promise.all([
    readForwardPosition(scope, todayIso),
    listingIds.length === 0
      ? Promise.resolve([])
      : query<HorizonSnapshotRow>(sql`
          SELECT listing_id, horizon_days, market_occupancy, comp_set_listings,
                 captured_at::text AS captured_at
          FROM market_horizon
          WHERE listing_id = ANY (${sql.raw(pgArray(listingIds))})
        `),
    listingIds.length === 0
      ? Promise.resolve([])
      : query<MonthlySnapshotRow>(sql`
          SELECT listing_id, month, market_booking_window, market_los, market_occupancy, market_adr
          FROM market_monthly
          WHERE listing_id = ANY (${sql.raw(pgArray(listingIds))})
          ORDER BY month
        `),
    listingIds.length === 0
      ? Promise.resolve([])
      : query<DailySnapshotRow>(sql`
          SELECT listing_id, stay_date::text AS stay_date, p25, p50, p75, p90,
                 median_booked_price, recommended_price, live_price,
                 market_occupancy, market_supply
          FROM market_daily
          WHERE listing_id = ANY (${sql.raw(pgArray(listingIds))})
            AND stay_date BETWEEN ${todayIso}::date AND ${priceTo}::date
          ORDER BY stay_date
        `),
    readOurBookingWindow(scope),
  ]);

  // ── Freshness ──────────────────────────────────────────────────────────────
  const captures = horizonRows
    .map((r) => r.captured_at)
    .filter((v): v is string => !!v)
    .sort();
  const capturedAt = captures[0] ?? null; // oldest vintage on screen, not the newest
  const ageHours = capturedAt
    ? (Date.now() - new Date(capturedAt).getTime()) / 3_600_000
    : Number.POSITIVE_INFINITY;

  // ── Horizon positions ──────────────────────────────────────────────────────
  const marketByListingHorizon = new Map(
    horizonRows.map((r) => [`${r.listing_id}|${r.horizon_days}`, nullable(r.market_occupancy)]),
  );

  const forwardByUnitHorizon = new Map(
    forward.map((r) => [`${r.unit_id}|${n(r.horizon_days)}`, r]),
  );

  const compSetByListing = new Map(
    horizonRows
      .filter((r) => r.comp_set_listings !== null)
      .map((r) => [r.listing_id, n(r.comp_set_listings)]),
  );

  const byUnit: UnitHorizons[] = units.map((unit) => ({
    unitId: unit.id,
    label: unit.label,
    shortLabel: unit.shortLabel,
    listingId: unit.priceLabsListingId,
    compSetListings: unit.priceLabsListingId
      ? (compSetByListing.get(unit.priceLabsListingId) ?? null)
      : null,
    horizons: HORIZONS.map(({ days, label }) => {
      const own = forwardByUnitHorizon.get(`${unit.id}|${days}`);
      const sold = n(own?.sold_nights);
      const available = n(own?.available_nights);
      const occupancy = ratio(sold, available);
      const market = unit.priceLabsListingId
        ? (marketByListingHorizon.get(`${unit.priceLabsListingId}|${days}`) ?? null)
        : null;
      return {
        horizonDays: days,
        label,
        ourOccupancy: occupancy,
        ourSoldNights: sold,
        ourAvailableNights: available,
        marketOccupancy: market,
        mpi: market && market > 0 ? occupancy / market : null,
      };
    }),
  }));

  /**
   * Portfolio market occupancy is weighted by OUR capacity in each unit, not by a
   * plain mean across listings. A flat average would give the single O.308 the
   * same say as the three Urban studios, so the portfolio MPI would drift away
   * from the sum of its parts for no reason the reader could see.
   */
  const portfolio: HorizonPosition[] = HORIZONS.map(({ days, label }) => {
    let sold = 0;
    let available = 0;
    let weightedMarket = 0;
    let marketWeight = 0;
    for (const unit of byUnit) {
      const h = unit.horizons.find((x) => x.horizonDays === days);
      if (!h) continue;
      sold += h.ourSoldNights;
      available += h.ourAvailableNights;
      if (h.marketOccupancy !== null && h.ourAvailableNights > 0) {
        weightedMarket += h.marketOccupancy * h.ourAvailableNights;
        marketWeight += h.ourAvailableNights;
      }
    }
    const occupancy = ratio(sold, available);
    const market = marketWeight > 0 ? weightedMarket / marketWeight : null;
    return {
      horizonDays: days,
      label,
      ourOccupancy: occupancy,
      ourSoldNights: sold,
      ourAvailableNights: available,
      marketOccupancy: market,
      mpi: market && market > 0 ? occupancy / market : null,
    };
  });

  // ── Monthly market series ──────────────────────────────────────────────────
  const monthlyByUnit = units
    .filter((u) => u.priceLabsListingId)
    .map((unit) => ({
      unitId: unit.id,
      shortLabel: unit.shortLabel,
      points: monthlyRows
        .filter((r) => r.listing_id === unit.priceLabsListingId)
        .map<MarketMonthPoint>((r) => ({
          month: r.month,
          marketOccupancy: nullable(r.market_occupancy),
          marketAdr: nullable(r.market_adr),
          marketBookingWindow: nullable(r.market_booking_window),
          marketLos: nullable(r.market_los),
        })),
    }));

  // Capacity weights per unit, used to collapse per-unit market series into one
  // portfolio line. Derived from the 360-day forward availability, which is the
  // closest thing to "how much of the portfolio is this unit".
  const weights = new Map(
    byUnit.map((u) => [
      u.unitId,
      u.horizons.find((h) => h.horizonDays === MAX_HORIZON)?.ourAvailableNights ?? 0,
    ]),
  );

  const monthly = collapseMonthly(monthlyByUnit, weights);

  // ── Per-night prices ───────────────────────────────────────────────────────
  const prices = units
    .filter((u) => u.priceLabsListingId)
    .map((unit) => ({
      unitId: unit.id,
      shortLabel: unit.shortLabel,
      bedrooms: unit.bedrooms,
      points: dailyRows
        .filter((r) => r.listing_id === unit.priceLabsListingId)
        .map<MarketPricePoint>((r) => ({
          stayDate: r.stay_date,
          p25: nullable(r.p25),
          p50: nullable(r.p50),
          p75: nullable(r.p75),
          p90: nullable(r.p90),
          medianBooked: nullable(r.median_booked_price),
          recommended: nullable(r.recommended_price),
          live: nullable(r.live_price),
          marketOccupancy: nullable(r.market_occupancy),
          marketSupply: r.market_supply === null ? null : n(r.market_supply),
        })),
    }));

  // ── Booking window: the comparison that matters most ───────────────────────
  // Market booking window is a trailing 12-month mean across the comp set; ours is
  // the median over the same trailing year, because our distribution has a long
  // thin tail and a mean would flatter it.
  const recentWindows = monthlyRows
    .map((r) => nullable(r.market_booking_window))
    .filter((v): v is number => v !== null && v > 0);
  const marketAvgDays =
    recentWindows.length > 0
      ? recentWindows.reduce((acc, v) => acc + v, 0) / recentWindows.length
      : null;

  const bookingWindow = ourWindow
    ? {
        ourMedianDays: ourWindow.median,
        ourAvgDays: ourWindow.mean,
        marketAvgDays,
        marketMultiple:
          marketAvgDays && ourWindow.median > 0 ? marketAvgDays / ourWindow.median : null,
      }
    : null;

  const caveats = [
    'The comp set is scraped from Airbnb and VRBO. Booking.com — most of our nights — is not in it.',
    'Market occupancy holds up regardless: a channel manager blocks the Airbnb calendar whichever channel books, and PriceLabs reproduced our own K.201 occupancy to the decimal.',
    'Market PRICE percentiles are Airbnb-listed prices, which carry a ~3% host fee where our Booking.com-facing rates absorb ~17%. Read them as position, never as a target.',
    'Our own occupancy here is computed from the bookings archive. PriceLabs’ view of our side reads 0% for the multi-unit listings and is not used.',
  ];

  return {
    meta: {
      configured: priceLabsConfigured(),
      capturedAt,
      stale: ageHours > STALE_HOURS,
      compSetListings: smallestCompSet(byUnit),
      source: 'PriceLabs — Airbnb + VRBO comp set, Brno',
      caveats,
    },
    portfolio,
    byUnit,
    monthly,
    monthlyByUnit,
    prices,
    bookingWindow,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Bind a string list as a Postgres text[] literal.
 *
 * Listing ids are generated by us from `SELLABLE_UNITS`, never from request input,
 * so there is no untrusted value in this path. The braces are still rejected
 * defensively: a stray one would corrupt the array literal and silently return the
 * wrong rows, which is a worse failure than throwing.
 */
function pgArray(values: string[]): string {
  for (const v of values) {
    if (/[{}",\\]/.test(v)) throw new Error(`Unexpected character in listing id: ${v}`);
  }
  return `'{${values.join(',')}}'::text[]`;
}

/**
 * The SMALLEST comp set on screen, not the largest.
 *
 * The banner is a confidence statement, so it should report the weakest evidence
 * being shown rather than the most flattering.
 */
function smallestCompSet(units: UnitHorizons[]): number | null {
  const sizes = units
    .map((u) => u.compSetListings)
    .filter((v): v is number => v !== null && v > 0);
  return sizes.length > 0 ? Math.min(...sizes) : null;
}

/** Capacity-weighted mean of the per-unit monthly series. */
function collapseMonthly(
  perUnit: { unitId: string; points: MarketMonthPoint[] }[],
  weights: Map<string, number>,
): MarketMonthPoint[] {
  const months = new Map<string, { occ: Acc; adr: Acc; window: Acc; los: Acc }>();
  const blank = (): Acc => ({ sum: 0, weight: 0 });

  for (const unit of perUnit) {
    const weight = Math.max(weights.get(unit.unitId) ?? 0, 0);
    if (weight === 0) continue;
    for (const point of unit.points) {
      const slot =
        months.get(point.month) ??
        (() => {
          const fresh = { occ: blank(), adr: blank(), window: blank(), los: blank() };
          months.set(point.month, fresh);
          return fresh;
        })();
      add(slot.occ, point.marketOccupancy, weight);
      add(slot.adr, point.marketAdr, weight);
      add(slot.window, point.marketBookingWindow, weight);
      add(slot.los, point.marketLos, weight);
    }
  }

  return [...months.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, slot]) => ({
      month,
      marketOccupancy: mean(slot.occ),
      marketAdr: mean(slot.adr),
      marketBookingWindow: mean(slot.window),
      marketLos: mean(slot.los),
    }));
}

interface Acc {
  sum: number;
  weight: number;
}

function add(acc: Acc, value: number | null, weight: number): void {
  if (value === null || !Number.isFinite(value)) return;
  acc.sum += value * weight;
  acc.weight += weight;
}

function mean(acc: Acc): number | null {
  return acc.weight > 0 ? acc.sum / acc.weight : null;
}

/** Our own booking window over the trailing year, on a booked basis. */
async function readOurBookingWindow(
  scope: AnalyticsScope,
): Promise<{ median: number; mean: number } | null> {
  const rows = await query<{ median_days: string | null; mean_days: string | null }>(sql`
    ${baseCtes(scope)}
    SELECT
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY (alloc.check_in_date - alloc.reservation_date)
      )::text AS median_days,
      AVG(alloc.check_in_date - alloc.reservation_date)::text AS mean_days
    FROM alloc
    WHERE alloc.is_cancelled = false
      AND alloc.is_blackout = false
      AND alloc.reservation_date IS NOT NULL
      AND alloc.check_in_date BETWEEN ${scope.from}::date AND ${scope.to}::date
  `);
  const row = rows[0];
  if (!row || row.median_days === null) return null;
  return { median: n(row.median_days), mean: n(row.mean_days) };
}

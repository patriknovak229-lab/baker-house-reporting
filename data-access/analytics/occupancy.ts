/**
 * Occupancy — how full each room class runs, against the market, and what that
 * occupancy actually earned.
 *
 * THE QUESTIONS, IN THE ORDER THE TAB ANSWERS THEM
 * ------------------------------------------------
 *  1. How full were the 1KK studios and the 2KK apartments, against the Brno
 *     comp set? (class scorecard, monthly MPI, forward position)
 *  2. Did occupancy turn into gross profit? 90% at a low rate can earn less than
 *     80% at a higher one, so every view carries GP per available night next to
 *     occupancy — and compares rooms of the same class in the same month.
 *  3. Do long (weekly-rate) stays pay? A long stay is discounted but fills every
 *     night and costs one turnover; it is compared against the sibling rooms
 *     over the exact same nights.
 *  4. Where did each class run out of rooms? (sold-out dates, by weekday)
 *
 * Every figure is split by ROOM CLASS (`ROOM_CLASSES`): the studios and the
 * two-bedroom apartments have different ADR and seasonality, and a blended
 * number hides both.
 *
 * This module only FETCHES — three flat lists out of Postgres plus the cost
 * engine — and hands them to `buildOccupancyModel` (occupancyModel.ts), which is
 * pure and unit-tested. See that file for the attribution rules.
 */
import { sql } from 'drizzle-orm';
import { LONG_STAY_MIN_NIGHTS, ROOM_CLASSES, SELLABLE_UNITS } from '@/data/analyticsConfig';
import { subscriptionMonthsInRange } from '@/utils/grossProfit';
import { computeVariableCosts } from '@/utils/variableCostsEngine';
import { ROOM_TO_BEDS24_ID } from '@/utils/variableCostsShared';
import type { OccupancyResponse } from '@/utils/analyticsTypes';
import { buildOccupancyModel, type ModelCostCell, type ModelNight } from './occupancyModel';
import { priceLabsConfigured } from './marketTypes';
import { baseCtes, n, nightsInScope, query, type AnalyticsScope } from './shared';

const FORWARD_HORIZONS = [
  { days: 7, label: 'Next 7 days' },
  { days: 30, label: 'Next 30 days' },
  { days: 60, label: 'Next 60 days' },
  { days: 90, label: 'Next 90 days' },
  { days: 180, label: 'Next 180 days' },
];

const BEDS24_TO_ROOM: Record<string, string> = Object.fromEntries(
  Object.entries(ROOM_TO_BEDS24_ID).map(([room, id]) => [id, room]),
);

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  while (`${y}-${String(m).padStart(2, '0')}` <= to.slice(0, 7)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

// ── Postgres reads ───────────────────────────────────────────────────────────

interface RoomDateRow {
  room: string;
  date: string;
}

async function readAvailable(scope: AnalyticsScope): Promise<RoomDateRow[]> {
  return query<RoomDateRow>(sql`
    ${baseCtes(scope)}
    SELECT available.room, available.stay_date::text AS date
    FROM available
  `);
}

interface NightRow {
  room: string;
  stay_room: string;
  date: string;
  reservation_number: string;
  channel: string;
  check_in: string;
  check_out: string;
  span_nights: number;
  gross: number;
  commission: number;
  fee: number;
}

async function readNights(scope: AnalyticsScope): Promise<ModelNight[]> {
  const rows = await query<NightRow>(sql`
    ${baseCtes(scope)}
    SELECT
      nights.room,
      nights.stay_room,
      nights.stay_date::text              AS date,
      nights.reservation_number,
      nights.channel,
      nights.check_in_date::text          AS check_in,
      nights.check_out_date::text         AS check_out,
      nights.span_nights::int             AS span_nights,
      nights.night_price::float8          AS gross,
      nights.night_commission::float8     AS commission,
      nights.night_fee::float8            AS fee
    FROM nights
    WHERE ${nightsInScope(scope)}
  `);
  return rows.map((r) => ({
    room: r.room,
    stayRoom: r.stay_room,
    date: r.date,
    reservation: r.reservation_number,
    channel: r.channel,
    checkIn: r.check_in,
    checkOut: r.check_out,
    span: n(r.span_nights),
    gross: n(r.gross),
    commission: n(r.commission),
    fee: n(r.fee),
  }));
}

/**
 * Every real checkout in the window, ALL channels and rooms — how the model
 * tells a stay's turnover (spread over that stay) from a cleaning with no
 * checkout behind it (left on its own date). Channel-blind on purpose: a
 * cleaning caused by a filtered-out channel's booking is not a "loose" cost of
 * the room.
 */
async function readCheckoutKeys(scope: AnalyticsScope): Promise<Set<string>> {
  const rows = await query<RoomDateRow>(sql`
    ${baseCtes(scope)}
    SELECT DISTINCT alloc.room, alloc.check_out_date::text AS date
    FROM alloc
    WHERE alloc.is_cancelled = false
      AND alloc.is_blackout  = false
      AND alloc.span_nights  > 0
      AND alloc.check_out_date BETWEEN ${scope.from}::date AND ${scope.to}::date
  `);
  return new Set(rows.map((r) => `${r.date}|${r.room}`));
}

/** On-the-books position from today, all channels — a market comparison. */
async function readForward(
  scope: AnalyticsScope,
  todayIso: string,
): Promise<{ available: RoomDateRow[]; nights: RoomDateRow[] }> {
  const maxDays = Math.max(...FORWARD_HORIZONS.map((h) => h.days));
  const forwardScope: AnalyticsScope = {
    from: todayIso,
    to: addDays(todayIso, maxDays - 1),
    rooms: scope.rooms,
    channels: [],
  };
  const [available, nights] = await Promise.all([
    readAvailable(forwardScope),
    query<RoomDateRow>(sql`
      ${baseCtes(forwardScope)}
      SELECT nights.room, nights.stay_date::text AS date
      FROM nights
      WHERE ${nightsInScope(forwardScope)}
    `),
  ]);
  return { available, nights };
}

interface MarketMonthlyDbRow {
  listing_id: string;
  month: string;
  market_occupancy: string | null;
  market_adr: string | null;
}

interface MarketHorizonDbRow {
  listing_id: string;
  horizon_days: number;
  market_occupancy: string | null;
  comp_set_listings: number | null;
  captured_at: string | null;
}

async function readMarket(listingIds: string[]) {
  if (listingIds.length === 0) return { monthly: [], horizon: [] };
  const list = sql.join(
    listingIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const [monthly, horizon] = await Promise.all([
    query<MarketMonthlyDbRow>(sql`
      SELECT listing_id, month, market_occupancy, market_adr
      FROM market_monthly
      WHERE listing_id IN (${list})
    `),
    query<MarketHorizonDbRow>(sql`
      SELECT listing_id, horizon_days, market_occupancy, comp_set_listings,
             captured_at::text AS captured_at
      FROM market_horizon
      WHERE listing_id IN (${list})
    `),
  ]);
  return { monthly, horizon };
}

// ── Costs (cleaning-app rate cards, via the shared engine) ───────────────────

async function readCosts(
  months: string[],
): Promise<{ cells: ModelCostCell[]; subscriptions: Map<string, number> } | null> {
  const costs = await computeVariableCosts();
  if (!costs) return null;

  const cells: ModelCostCell[] = [];
  for (const [key, entry] of Object.entries(costs.byDateRoom)) {
    const [date, roomId] = key.split('|');
    const room = roomId ? BEDS24_TO_ROOM[roomId] : undefined;
    if (!date || !room) continue;
    cells.push({
      date,
      room,
      turnover: (entry.cleaning ?? 0) + (entry.laundry ?? 0) + (entry.consumables ?? 0),
      incidents: (entry.wearTear ?? 0) + (entry.misc ?? 0),
    });
  }

  // Monthly amount per (room, month), honouring each item's start/end month the
  // same way the gross-profit engine does. The model pro-rates it by day.
  const subscriptions = new Map<string, number>();
  for (const item of costs.subscriptionItems) {
    for (const [roomId, cfg] of Object.entries(item.rooms ?? {})) {
      if (!cfg?.enabled || !cfg.monthlyAmount || cfg.monthlyAmount <= 0) continue;
      const room = BEDS24_TO_ROOM[roomId];
      if (!room) continue;
      for (const month of months) {
        if (subscriptionMonthsInRange(item, `${month}-01`, `${month}-01`) <= 0) continue;
        const key = `${room}|${month}`;
        subscriptions.set(key, (subscriptions.get(key) ?? 0) + cfg.monthlyAmount);
      }
    }
  }
  return { cells, subscriptions };
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function readOccupancy(
  scope: AnalyticsScope,
  todayIso: string,
  completeMonths: number,
): Promise<OccupancyResponse> {
  const classes = ROOM_CLASSES.map((c) => ({
    ...c,
    rooms: scope.rooms.length === 0 ? c.rooms : c.rooms.filter((r) => scope.rooms.includes(r)),
  }));
  const scopedRooms = new Set(classes.flatMap((c) => c.rooms));
  const listings = SELLABLE_UNITS.filter((u) => u.priceLabsListingId).map((u) => ({
    listingId: u.priceLabsListingId as string,
    rooms: u.rooms.filter((r) => scopedRooms.has(r)),
  })).filter((l) => l.rooms.length > 0);

  const [available, nights, checkoutKeys, forward, market, costs] = await Promise.all([
    readAvailable(scope),
    readNights(scope),
    readCheckoutKeys(scope),
    readForward(scope, todayIso),
    readMarket(listings.map((l) => l.listingId)),
    readCosts(monthsBetween(scope.from, scope.to)),
  ]);

  const model = buildOccupancyModel({
    from: scope.from,
    to: scope.to,
    today: todayIso,
    classes,
    available,
    nights,
    costCells: costs?.cells ?? null,
    checkoutKeys,
    subscriptionsByRoomMonth: costs?.subscriptions ?? null,
    listings,
    marketMonthly: market.monthly.map((r) => ({
      listingId: r.listing_id,
      month: r.month,
      occupancy: r.market_occupancy === null ? null : n(r.market_occupancy),
      adr: r.market_adr === null ? null : n(r.market_adr),
    })),
    forward: {
      available: forward.available,
      nights: forward.nights,
      horizons: FORWARD_HORIZONS,
      market: market.horizon.map((r) => ({
        listingId: r.listing_id,
        horizonDays: n(r.horizon_days),
        occupancy: r.market_occupancy === null ? null : n(r.market_occupancy),
        compSet: r.comp_set_listings === null ? null : n(r.comp_set_listings),
      })),
    },
    longStayMinNights: LONG_STAY_MIN_NIGHTS,
  });

  const notes = [...model.notes];
  if (!costs) {
    notes.unshift(
      'Stay costs are unavailable here (the cleaning-app rate cards live in Redis, which is not configured for this environment), so gross-profit figures are hidden. Occupancy, ADR and RevPAR are unaffected.',
    );
  }
  if (scope.channels.length > 0) {
    notes.unshift(
      `Channel filter is on (${scope.channels.join(', ')}): occupancy counts only nights sold through those channels, so sold-out dates and the market comparison understate how full the rooms really were. The forward position always counts every channel.`,
    );
  }

  const captures = market.horizon
    .map((r) => r.captured_at)
    .filter((v): v is string => !!v)
    .sort();

  const partialYear = completeMonths < 12;
  const message = partialYear
    ? `Based on ${completeMonths} complete month${completeMonths === 1 ? '' : 's'} of trading, with rooms coming online in stages. Month-to-month shape is indicative, not seasonality; the same-month room comparisons and the long-stay comparisons hold season fixed and are the sturdier signals.`
    : 'A full year of trading is available, so month-to-month shape can be read as seasonality.';

  return {
    basis: 'stay',
    query: { from: scope.from, to: scope.to, rooms: scope.rooms, channels: scope.channels },
    ...model,
    notes,
    market: {
      configured: priceLabsConfigured(),
      capturedAt: captures[0] ?? null,
      source: 'PriceLabs — Airbnb + VRBO comp set, Brno',
    },
    confidence: { completeMonths, partialYear, message },
  };
}

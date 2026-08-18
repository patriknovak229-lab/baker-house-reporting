/**
 * Costs & commissions — what the business pays to sell a night, and to turn one
 * over.
 *
 * TWO COST FAMILIES, DELIBERATELY KEPT APART
 * ------------------------------------------
 *  1. DISTRIBUTION cost (OTA commission + payment fees) scales with REVENUE and
 *     comes from Beds24, already in the Postgres archive.
 *  2. OPERATING cost (cleaning, laundry, consumables, wear & tear, misc,
 *     subscriptions) scales with CHECKOUTS and MONTHS, and comes from the
 *     cleaning app's rate cards, which still live in Redis.
 *
 * The distinction is the section's most useful idea. Distribution cost is a
 * percentage — a longer stay costs proportionally the same. Turnover cost is a
 * FLAT FEE PER CHECKOUT — a one-night stay pays a full cleaning, laundry and
 * consumables set out of one night's revenue. That is why `losEconomics` exists,
 * and why comparing channels on gross ADR alone is misleading: `channelProfit`
 * lands both cost families on the same per-night basis.
 *
 * ATTRIBUTION: stay basis for revenue and commission (matching the Overview and
 * the Performance tab), checkout-date basis for turnover costs — which is how the
 * cleaning app bills them and how `utils/grossProfit.ts` already reads them.
 */
import { sql } from 'drizzle-orm';
import {
  EXPECTED_COMMISSION_RATES,
  TURNOVER_COST_KEYS,
} from '@/data/analyticsConfig';
import { subscriptionMonthsInRange } from '@/utils/grossProfit';
import { ROOM_TO_BEDS24_ID } from '@/utils/variableCostsShared';
import { computeVariableCosts } from '@/utils/variableCostsEngine';
import type { VariableCostsResponse } from '@/utils/variableCostsShared';
import {
  VARIABLE_COST_KEYS,
  type ChannelProfitRow,
  type CommissionByChannelMonth,
  type CostMonthlyPoint,
  type CostsResponse,
  type LosEconomicsRow,
  type SettlementVarianceRow,
  type SupplierCostRow,
  type VariableCostTotals,
} from '@/utils/analyticsTypes';
import {
  baseCtes,
  channelFilter,
  LOS_BUCKETS,
  n,
  nightsInScope,
  PHYSICAL_ROOMS,
  query,
  ratio,
  roomFilter,
  type AnalyticsScope,
} from './shared';

const BEDS24_TO_ROOM: Record<string, string> = Object.fromEntries(
  Object.entries(ROOM_TO_BEDS24_ID).map(([room, id]) => [id, room]),
);

function zeroCosts(): VariableCostTotals {
  return { cleaning: 0, laundry: 0, consumables: 0, wearTear: 0, misc: 0, subscriptions: 0 };
}

function addCosts(target: VariableCostTotals, source: Partial<VariableCostTotals>): void {
  for (const key of VARIABLE_COST_KEYS) target[key] += source[key] ?? 0;
}

function sumCosts(totals: VariableCostTotals): number {
  return VARIABLE_COST_KEYS.reduce((acc, key) => acc + totals[key], 0);
}

// ── Cost cells, scoped ───────────────────────────────────────────────────────

interface CostCell {
  date: string;
  room: string;
  cleaning: number;
  laundry: number;
  consumables: number;
  wearTear: number;
  misc: number;
}

/**
 * Flatten the engine's `date|beds24RoomId` map into scoped, room-named cells.
 *
 * Cells for rooms outside the filter, or dates outside the window, are dropped
 * here so no downstream total can accidentally include them.
 */
function scopedCostCells(costs: VariableCostsResponse, scope: AnalyticsScope): CostCell[] {
  const roomFilterSet = scope.rooms.length > 0 ? new Set(scope.rooms) : null;
  const cells: CostCell[] = [];
  for (const [key, entry] of Object.entries(costs.byDateRoom)) {
    const [date, roomId] = key.split('|');
    if (!date || !roomId) continue;
    if (date < scope.from || date > scope.to) continue;
    const room = BEDS24_TO_ROOM[roomId];
    if (!room) continue;
    if (roomFilterSet && !roomFilterSet.has(room)) continue;
    cells.push({
      date,
      room,
      cleaning: entry.cleaning ?? 0,
      laundry: entry.laundry ?? 0,
      consumables: entry.consumables ?? 0,
      wearTear: entry.wearTear ?? 0,
      misc: entry.misc ?? 0,
    });
  }
  return cells;
}

/**
 * Subscription cost for a window, month-aware.
 *
 * Reuses `subscriptionMonthsInRange` from the gross-profit engine rather than
 * re-deriving it, so a subscription cancelled mid-period is charged for exactly
 * the months it was live in both places.
 */
function subscriptionsForWindow(
  costs: VariableCostsResponse,
  scope: AnalyticsScope,
  from: string,
  to: string,
): number {
  const roomFilterSet = scope.rooms.length > 0 ? new Set(scope.rooms) : null;
  let total = 0;
  for (const item of costs.subscriptionItems) {
    const months = subscriptionMonthsInRange(item, from, to);
    if (months <= 0) continue;
    for (const [roomId, cfg] of Object.entries(item.rooms ?? {})) {
      if (!cfg?.enabled || !cfg.monthlyAmount || cfg.monthlyAmount <= 0) continue;
      const room = BEDS24_TO_ROOM[roomId];
      if (!room) continue;
      if (roomFilterSet && !roomFilterSet.has(room)) continue;
      total += cfg.monthlyAmount * months;
    }
  }
  return total;
}

// ── Revenue side, from Postgres ──────────────────────────────────────────────

interface RevenueMonthRow {
  month: string;
  sold_nights: number;
  available_nights: number;
  gbv: number;
  commission: number;
  fees: number;
  month_end: string | null;
}

async function readRevenueByMonth(scope: AnalyticsScope): Promise<RevenueMonthRow[]> {
  return query<RevenueMonthRow>(sql`
    ${baseCtes(scope)},
    sold AS (
      SELECT
        to_char(nights.stay_date, 'YYYY-MM')              AS month,
        COUNT(*)::int                                     AS sold_nights,
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
      a.month_end
    FROM avail a
    FULL OUTER JOIN sold s ON s.month = a.month
    ORDER BY 1
  `);
}

interface CommissionRow {
  month: string;
  channel: string;
  gbv: number;
  commission: number;
  fees: number;
}

async function readCommissionByChannelMonth(scope: AnalyticsScope): Promise<CommissionRow[]> {
  return query<CommissionRow>(sql`
    ${baseCtes(scope)}
    SELECT
      to_char(nights.stay_date, 'YYYY-MM')              AS month,
      nights.channel                                    AS channel,
      COALESCE(SUM(nights.night_price), 0)::float8       AS gbv,
      COALESCE(SUM(nights.night_commission), 0)::float8  AS commission,
      COALESCE(SUM(nights.night_fee), 0)::float8         AS fees
    FROM nights
    WHERE ${nightsInScope(scope)}
    GROUP BY 1, 2
    ORDER BY 1, 2
  `);
}

interface RoomNightsRow {
  room: string;
  sold_nights: number;
}

async function readRoomNights(scope: AnalyticsScope): Promise<RoomNightsRow[]> {
  return query<RoomNightsRow>(sql`
    ${baseCtes(scope)}
    SELECT nights.room AS room, COUNT(*)::int AS sold_nights
    FROM nights
    WHERE ${nightsInScope(scope)}
    GROUP BY 1
  `);
}

/**
 * One row per booking that CHECKS OUT inside the window, with the room and date
 * that turnover costs are billed against.
 *
 * Checkout-date scoping is what makes turnover cost attributable at all: the
 * cleaning app logs a cleaning against (checkout date, room), so a booking is the
 * thing that caused exactly one such cell.
 */
interface CheckoutBookingRow {
  reservation_number: string;
  channel: string;
  room: string;
  check_out_date: string;
  span_nights: number;
  price: number;
  commission: number;
  fee: number;
}

async function readCheckoutBookings(scope: AnalyticsScope): Promise<CheckoutBookingRow[]> {
  return query<CheckoutBookingRow>(sql`
    ${baseCtes(scope)}
    SELECT
      alloc.reservation_number,
      alloc.channel,
      alloc.room,
      alloc.check_out_date::text AS check_out_date,
      alloc.span_nights::int     AS span_nights,
      alloc.price::float8        AS price,
      alloc.commission::float8   AS commission,
      alloc.fee::float8          AS fee
    FROM alloc
    WHERE alloc.is_cancelled = false
      AND alloc.is_blackout  = false
      AND alloc.span_nights  > 0
      AND alloc.check_out_date BETWEEN ${scope.from}::date AND ${scope.to}::date
      AND ${roomFilter(sql`alloc.room`, scope)}
      AND ${channelFilter(sql`alloc.channel`, scope)}
  `);
}

// ── Supplier ledger ──────────────────────────────────────────────────────────

interface SupplierMixRow {
  category: string;
  label: string | null;
  invoices: number;
  amount: number;
}

interface TopSupplierRow {
  supplier: string;
  invoices: number;
  amount: number;
}

/**
 * The accounting ledger's own view of cost, alongside the operational one.
 *
 * These two never tie exactly and should not be forced to: the variable-cost
 * engine is accrual-by-checkout (what a stay cost to service), while supplier
 * invoices are cash-by-invoice-date (what was purchased). A pallet of linen bought
 * in April serves stays through August. Both are shown because the gap is the
 * interesting part — a category with ledger spend and no operational cost is one
 * the P&L sees and the per-night economics do not.
 */
async function readSupplierLedger(scope: AnalyticsScope): Promise<{
  mix: SupplierCostRow[];
  top: TopSupplierRow[];
}> {
  const [mixRows, topRows] = await Promise.all([
    query<SupplierMixRow>(sql`
      SELECT
        si.category                                       AS category,
        MAX(ic.label)                                     AS label,
        COUNT(*)::int                                     AS invoices,
        COALESCE(SUM(si.amount_czk::numeric), 0)::float8  AS amount
      FROM supplier_invoices si
      LEFT JOIN invoice_categories ic ON ic.id = si.category
      WHERE si.invoice_date BETWEEN ${scope.from}::date AND ${scope.to}::date
      GROUP BY 1
      ORDER BY 4 DESC
    `),
    query<TopSupplierRow>(sql`
      SELECT
        si.supplier_name                                  AS supplier,
        COUNT(*)::int                                     AS invoices,
        COALESCE(SUM(si.amount_czk::numeric), 0)::float8  AS amount
      FROM supplier_invoices si
      WHERE si.invoice_date BETWEEN ${scope.from}::date AND ${scope.to}::date
      GROUP BY 1
      ORDER BY 3 DESC
      LIMIT 12
    `),
  ]);

  const total = mixRows.reduce((acc, r) => acc + n(r.amount), 0);
  return {
    mix: mixRows.map((r) => ({
      category: r.category,
      label: r.label ?? r.category,
      invoices: n(r.invoices),
      amount: n(r.amount),
      share: ratio(n(r.amount), total),
    })),
    top: topRows.map((r) => ({
      supplier: r.supplier,
      invoices: n(r.invoices),
      amount: n(r.amount),
    })),
  };
}

// ── OTA settlement variance ──────────────────────────────────────────────────

interface SettlementRow {
  source: string | null;
  period_label: string;
  statement_count: number;
  period_start: string | null;
  period_end: string | null;
  gross_amount: number | null;
  commission_amount: number | null;
  net_amount: number | null;
  beds24_commission: number;
}

/**
 * Commission the OTA charged (from the imported settlement statements) versus
 * commission Beds24 reported for stays in the same period.
 *
 * This is the only independent check the business has on its largest single cost
 * line. Two things make it a sanity check rather than a reconciliation:
 *
 *  - A channel issues SEVERAL payouts for one month. Comparing each against the
 *    whole month's Beds24 commission would report a 100–400% variance on every
 *    one of them, which is an artefact, not a finding. Statements are therefore
 *    POOLED per channel-month before the comparison.
 *  - Statements settle on payout dates while Beds24 records per booking, and a
 *    payout period straddles stays outside it. Residual timing differences of a
 *    few percent are expected.
 *
 * Read a 40% gap as a question and a 4% gap as timing.
 */
async function readSettlementVariance(scope: AnalyticsScope): Promise<SettlementVarianceRow[]> {
  const rows = await query<SettlementRow>(sql`
    ${baseCtes(scope)},
    pooled AS (
      SELECT
        sg.source                                             AS source,
        to_char(date_trunc('month', sg.period_start), 'YYYY-MM') AS period_label,
        COUNT(*)::int                                         AS statement_count,
        MIN(sg.period_start)                                  AS period_start,
        MAX(sg.period_end)                                    AS period_end,
        SUM(sg.gross_amount::numeric)::float8                 AS gross_amount,
        SUM(sg.commission_amount::numeric)::float8            AS commission_amount,
        SUM(sg.net_amount::numeric)::float8                   AS net_amount
      FROM settlement_groups sg
      WHERE sg.period_start IS NOT NULL
        AND sg.period_end   IS NOT NULL
        AND sg.period_end   >= ${scope.from}::date
        AND sg.period_start <= ${scope.to}::date
      GROUP BY 1, 2
    )
    SELECT
      p.source,
      p.period_label,
      p.statement_count,
      p.period_start::text AS period_start,
      p.period_end::text   AS period_end,
      p.gross_amount,
      p.commission_amount,
      p.net_amount,
      COALESCE((
        SELECT SUM(nights.night_commission)::float8
        FROM nights
        WHERE nights.stay_date BETWEEN p.period_start AND p.period_end
          AND (
            (p.source = 'booking' AND nights.channel = 'Booking.com')
            OR (p.source = 'airbnb' AND nights.channel = 'Airbnb')
            OR p.source IS NULL
          )
      ), 0) AS beds24_commission
    FROM pooled p
    ORDER BY p.period_label, p.source
  `);

  const channelLabel = (source: string | null) =>
    source === 'booking' ? 'Booking.com' : source === 'airbnb' ? 'Airbnb' : (source ?? 'Unknown channel');

  return rows.map<SettlementVarianceRow>((r) => {
    const statementCommission = r.commission_amount == null ? null : n(r.commission_amount);
    const beds24Commission = n(r.beds24_commission);
    const variance = statementCommission == null ? null : beds24Commission - statementCommission;
    const count = n(r.statement_count);
    return {
      name: `${channelLabel(r.source)} \u00b7 ${r.period_label}${count > 1 ? ` (${count} payouts)` : ''}`,
      source: r.source,
      statementCount: count,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      statementCommission,
      statementGross: r.gross_amount == null ? null : n(r.gross_amount),
      statementNet: r.net_amount == null ? null : n(r.net_amount),
      beds24Commission,
      variance,
      variancePct:
        statementCommission && statementCommission !== 0 && variance != null
          ? variance / statementCommission
          : null,
    };
  });
}

// ── Booking.com Genius ───────────────────────────────────────────────────────

interface GeniusRow {
  is_genius: boolean;
  bookings: number;
  nights: number;
  gbv: number;
}

/**
 * What the Genius programme costs in ADR terms.
 *
 * Genius is not a line item anywhere — it is a discount baked into the rate, so
 * its cost is invisible in the P&L. Beds24 does preserve the marker: the booking's
 * `infoItems` carry a `BOOKINGCOMFLAG` and the per-night `rateDescription` lines
 * are tagged "genius". Comparing ADR across the two groups is the closest thing to
 * a price for it. Read it as a correlation, not a controlled experiment — Genius
 * members may also book different rooms, seasons and stay lengths.
 */
async function readGeniusImpact(scope: AnalyticsScope): Promise<CostsResponse['geniusImpact']> {
  const rows = await query<GeniusRow>(sql`
    ${baseCtes(scope)},
    tagged AS (
      SELECT
        nights.reservation_number,
        nights.night_price,
        (
          alloc.rate_description ILIKE '%genius%'
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(bm.raw -> 'infoItems', '[]'::jsonb)) AS item
            WHERE item ->> 'code' = 'BOOKINGCOMFLAG'
              AND item ->> 'text' ILIKE '%genius%'
          )
        ) AS is_genius
      FROM nights
      JOIN alloc ON alloc.reservation_number = nights.reservation_number AND alloc.room = nights.room
      JOIN bookings_mirror bm ON bm.reservation_number = nights.reservation_number
      WHERE ${nightsInScope(scope)}
        AND nights.channel = 'Booking.com'
    )
    SELECT
      is_genius,
      COUNT(DISTINCT reservation_number)::int      AS bookings,
      COUNT(*)::int                                AS nights,
      COALESCE(SUM(night_price), 0)::float8        AS gbv
    FROM tagged
    GROUP BY 1
  `);

  if (rows.length === 0) return null;

  const genius = rows.find((r) => r.is_genius);
  const other = rows.find((r) => !r.is_genius);
  const geniusNights = n(genius?.nights);
  const otherNights = n(other?.nights);
  if (geniusNights === 0 || otherNights === 0) return null;

  const geniusAdr = ratio(n(genius?.gbv), geniusNights);
  const nonGeniusAdr = ratio(n(other?.gbv), otherNights);
  const geniusBookings = n(genius?.bookings);
  const nonGeniusBookings = n(other?.bookings);

  /**
   * Both groups need a real sample before the ADR gap means anything.
   *
   * In practice almost every Booking.com booking is Genius — the non-Genius group
   * has been under ten bookings — so a raw comparison would report a confident
   * percentage built on a handful of stays that also differ by room, month and
   * length. Below the threshold the shares are still shown (they are just counts)
   * but the delta is withheld rather than dressed up.
   */
  const MIN_COMPARISON_BOOKINGS = 15;
  const comparable =
    geniusBookings >= MIN_COMPARISON_BOOKINGS && nonGeniusBookings >= MIN_COMPARISON_BOOKINGS;

  return {
    geniusBookings,
    nonGeniusBookings,
    geniusAdr,
    nonGeniusAdr,
    adrDelta: comparable && nonGeniusAdr > 0 ? geniusAdr / nonGeniusAdr - 1 : null,
    geniusNightShare: ratio(geniusNights, geniusNights + otherNights),
    comparable,
    minComparisonBookings: MIN_COMPARISON_BOOKINGS,
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function readCosts(
  scope: AnalyticsScope,
  todayIso: string,
): Promise<CostsResponse> {
  const [costs, revenueMonths, commissionRows, roomNights, checkoutBookings, supplier, settlementVariance, geniusImpact] =
    await Promise.all([
      computeVariableCosts(),
      readRevenueByMonth(scope),
      readCommissionByChannelMonth(scope),
      readRoomNights(scope),
      readCheckoutBookings(scope),
      readSupplierLedger(scope),
      readSettlementVariance(scope),
      readGeniusImpact(scope),
    ]);

  const notes: string[] = [];
  if (!costs) {
    notes.push(
      'Operating costs are unavailable: the cleaning app rate cards live in Redis and it is not configured for this environment. Commission and revenue figures below are unaffected.',
    );
  }

  const cells = costs ? scopedCostCells(costs, scope) : [];

  // ── Monthly bridge ─────────────────────────────────────────────────────────
  const costByMonth = new Map<string, VariableCostTotals>();
  for (const cell of cells) {
    const month = cell.date.slice(0, 7);
    const bucket = costByMonth.get(month) ?? zeroCosts();
    addCosts(bucket, cell);
    costByMonth.set(month, bucket);
  }

  const monthly: CostMonthlyPoint[] = revenueMonths.map((r) => {
    const month = r.month;
    const monthCosts = costByMonth.get(month) ?? zeroCosts();
    // Subscriptions are monthly, not per-cell — charged once for the month,
    // clipped to the selected window so a half-month is not double counted.
    const monthStart = `${month}-01`;
    const windowStart = monthStart < scope.from ? scope.from : monthStart;
    const windowEnd = (r.month_end ?? monthStart) > scope.to ? scope.to : (r.month_end ?? monthStart);
    monthCosts.subscriptions = costs
      ? subscriptionsForWindow(costs, scope, windowStart, windowEnd)
      : 0;

    const soldNights = n(r.sold_nights);
    const availableNights = n(r.available_nights);
    const gbv = n(r.gbv);
    const otaCommission = n(r.commission);
    const paymentFees = n(r.fees);
    const netSales = gbv - otaCommission - paymentFees;
    const totalVariableCosts = sumCosts(monthCosts);
    const grossProfit = netSales - totalVariableCosts;

    return {
      month,
      soldNights,
      gbv,
      otaCommission,
      paymentFees,
      netSales,
      costs: monthCosts,
      totalVariableCosts,
      grossProfit,
      grossMargin: ratio(grossProfit, gbv),
      cpor: ratio(totalVariableCosts, soldNights),
      gopar: ratio(grossProfit, availableNights),
      availableNights,
      partial:
        (r.month_end ?? '') > todayIso ||
        month === scope.from.slice(0, 7) ||
        month === scope.to.slice(0, 7),
    };
  });

  // ── Period totals ──────────────────────────────────────────────────────────
  const totalCosts = zeroCosts();
  for (const cell of cells) addCosts(totalCosts, cell);
  totalCosts.subscriptions = costs ? subscriptionsForWindow(costs, scope, scope.from, scope.to) : 0;

  const gbv = revenueMonths.reduce((acc, r) => acc + n(r.gbv), 0);
  const otaCommission = revenueMonths.reduce((acc, r) => acc + n(r.commission), 0);
  const paymentFees = revenueMonths.reduce((acc, r) => acc + n(r.fees), 0);
  const soldNights = revenueMonths.reduce((acc, r) => acc + n(r.sold_nights), 0);
  const availableNights = revenueMonths.reduce((acc, r) => acc + n(r.available_nights), 0);
  const netSales = gbv - otaCommission - paymentFees;
  const totalVariableCosts = sumCosts(totalCosts);
  const grossProfit = netSales - totalVariableCosts;

  // ── Commission by channel ──────────────────────────────────────────────────
  const commissionByChannelMonth: CommissionByChannelMonth[] = commissionRows.map((r) => ({
    month: r.month,
    channel: r.channel,
    gbv: n(r.gbv),
    commission: n(r.commission),
    paymentFees: n(r.fees),
    effectiveRate: ratio(n(r.commission) + n(r.fees), n(r.gbv)),
  }));

  const channelTotals = new Map<string, { gbv: number; commission: number; fees: number }>();
  for (const r of commissionRows) {
    const bucket = channelTotals.get(r.channel) ?? { gbv: 0, commission: 0, fees: 0 };
    bucket.gbv += n(r.gbv);
    bucket.commission += n(r.commission);
    bucket.fees += n(r.fees);
    channelTotals.set(r.channel, bucket);
  }
  const commissionByChannel = [...channelTotals.entries()]
    .map(([channel, v]) => ({
      channel,
      gbv: v.gbv,
      commission: v.commission,
      paymentFees: v.fees,
      effectiveRate: ratio(v.commission + v.fees, v.gbv),
    }))
    .sort((a, b) => b.commission - a.commission);

  for (const row of commissionByChannel) {
    const expected = EXPECTED_COMMISSION_RATES[row.channel];
    if (expected == null || row.gbv <= 0) continue;
    const drift = row.effectiveRate - expected;
    if (Math.abs(drift) > 0.02) {
      notes.push(
        `${row.channel} is costing ${(row.effectiveRate * 100).toFixed(1)}% of gross, against an expected ${(expected * 100).toFixed(1)}%. Check the rate plan mix and EXPECTED_COMMISSION_RATES in data/analyticsConfig.ts.`,
      );
    }
  }

  // ── Cost per room ──────────────────────────────────────────────────────────
  const costPerRoom = new Map<string, VariableCostTotals>();
  for (const cell of cells) {
    const bucket = costPerRoom.get(cell.room) ?? zeroCosts();
    addCosts(bucket, cell);
    costPerRoom.set(cell.room, bucket);
  }
  const nightsByRoom = new Map(roomNights.map((r) => [r.room, n(r.sold_nights)]));
  const roomOrder = new Map(PHYSICAL_ROOMS.map((room, i) => [room, i]));
  const costByRoom = PHYSICAL_ROOMS.filter((room) => scope.rooms.length === 0 || scope.rooms.includes(room))
    .map((room) => {
      const roomCosts = costPerRoom.get(room) ?? zeroCosts();
      // Subscriptions are per-room monthly amounts, not per-checkout cells, so
      // they have to be added here or a room's cost-per-night would omit its
      // largest fixed component.
      roomCosts.subscriptions = costs
        ? subscriptionsForWindow(costs, { ...scope, rooms: [room] }, scope.from, scope.to)
        : 0;
      const total = sumCosts(roomCosts);
      const nights = nightsByRoom.get(room) ?? 0;
      return { room, soldNights: nights, costs: roomCosts, total, cpor: ratio(total, nights) };
    })
    .sort((a, b) => (roomOrder.get(a.room) ?? 99) - (roomOrder.get(b.room) ?? 99));

  // ── Per-booking turnover cost ──────────────────────────────────────────────
  //
  // A booking's turnover cost is the cleaning/laundry/consumables cell logged
  // against (its checkout date, its room). Multi-room bookings appear once per
  // room in `alloc`, so each room's own cell is picked up independently, which is
  // right: three rooms turned over means three cleanings.
  const cellByKey = new Map(cells.map((c) => [`${c.date}|${c.room}`, c]));

  const losBuckets = new Map<
    string,
    { bookings: number; nights: number; gbv: number; netSales: number; turnoverCost: number }
  >();
  const channelBuckets = new Map<
    string,
    { bookings: number; nights: number; gbv: number; commission: number; fees: number; variableCosts: number }
  >();

  for (const b of checkoutBookings) {
    const span = n(b.span_nights);
    const price = n(b.price);
    const commission = n(b.commission);
    const fee = n(b.fee);
    const cell = cellByKey.get(`${b.check_out_date}|${b.room}`);
    const turnoverCost = cell
      ? TURNOVER_COST_KEYS.reduce((acc, key) => acc + (cell[key] ?? 0), 0)
      : 0;

    const losLabel =
      LOS_BUCKETS.find((x) => span >= x.min && (x.max === null || span <= x.max))?.label ?? 'Unknown';
    const los = losBuckets.get(losLabel) ?? {
      bookings: 0,
      nights: 0,
      gbv: 0,
      netSales: 0,
      turnoverCost: 0,
    };
    los.bookings += 1;
    los.nights += span;
    los.gbv += price;
    los.netSales += price - commission - fee;
    los.turnoverCost += turnoverCost;
    losBuckets.set(losLabel, los);

    const ch = channelBuckets.get(b.channel) ?? {
      bookings: 0,
      nights: 0,
      gbv: 0,
      commission: 0,
      fees: 0,
      variableCosts: 0,
    };
    ch.bookings += 1;
    ch.nights += span;
    ch.gbv += price;
    ch.commission += commission;
    ch.fees += fee;
    ch.variableCosts += turnoverCost;
    channelBuckets.set(b.channel, ch);
  }

  const losEconomics: LosEconomicsRow[] = LOS_BUCKETS.map((b) => {
    const v = losBuckets.get(b.label);
    const bookings = v?.bookings ?? 0;
    const nights = v?.nights ?? 0;
    const netSalesPerBooking = ratio(v?.netSales ?? 0, bookings);
    const turnoverCostPerBooking = ratio(v?.turnoverCost ?? 0, bookings);
    const contributionPerBooking = netSalesPerBooking - turnoverCostPerBooking;
    return {
      label: b.label,
      bookings,
      nights,
      gbv: v?.gbv ?? 0,
      netSales: v?.netSales ?? 0,
      turnoverCostPerBooking,
      netSalesPerBooking,
      contributionPerBooking,
      contributionPerNight: bookings > 0 ? contributionPerBooking / ratio(nights, bookings) : 0,
    };
  }).filter((r) => r.bookings > 0);

  const channelProfit: ChannelProfitRow[] = [...channelBuckets.entries()]
    .map<ChannelProfitRow>(([channel, v]) => {
      const netSales = v.gbv - v.commission - v.fees;
      const contribution = netSales - v.variableCosts;
      return {
        channel,
        soldNights: v.nights,
        bookings: v.bookings,
        gbv: v.gbv,
        adr: ratio(v.gbv, v.nights),
        otaCommission: v.commission,
        paymentFees: v.fees,
        netSales,
        variableCosts: v.variableCosts,
        contribution,
        contributionPerNight: ratio(contribution, v.nights),
        contributionMargin: ratio(contribution, v.gbv),
      };
    })
    .sort((a, b) => b.contribution - a.contribution);

  if (costs && cells.length === 0) {
    notes.push(
      'No operating-cost entries fall inside this window, so gross profit equals net sales here. Costs are logged in the cleaning app against each checkout date.',
    );
  }

  return {
    basis: 'stay',
    query: { from: scope.from, to: scope.to, rooms: scope.rooms, channels: scope.channels },
    totals: {
      gbv,
      otaCommission,
      paymentFees,
      netSales,
      costs: totalCosts,
      totalVariableCosts,
      grossProfit,
      grossMargin: ratio(grossProfit, gbv),
      soldNights,
      availableNights,
      cpor: ratio(totalVariableCosts, soldNights),
      gopar: ratio(grossProfit, availableNights),
      otaCommissionRate: ratio(otaCommission, gbv),
    },
    monthly,
    commissionByChannelMonth,
    commissionByChannel,
    costByRoom,
    losEconomics,
    channelProfit,
    supplierMix: supplier.mix,
    topSuppliers: supplier.top,
    settlementVariance,
    geniusImpact,
    notes,
  };
}

/**
 * Client-safe contract for the /api/analytics/* routes.
 *
 * KEEP THIS MODULE FREE OF SERVER-ONLY IMPORTS. It is imported by browser
 * components AND by the route handlers, so nothing here may reach `@/lib/db`,
 * `@upstash/redis`, `next/server` or `process.env` — that import chain is what
 * white-screened the app on 2026-08-15 (see the comment block in `lib/db.ts`).
 * Types only, plus pure constants.
 */

// ── Shared query contract ────────────────────────────────────────────────────

/** Every analytics route takes the same window + scope. */
export interface AnalyticsQuery {
  /** Inclusive stay-date window start, YYYY-MM-DD. */
  from: string;
  /** Inclusive stay-date window end, YYYY-MM-DD. */
  to: string;
  /** Physical rooms in scope; empty/absent = all rooms. */
  rooms?: string[];
  /** Channels in scope; empty/absent = all channels. */
  channels?: string[];
}

/**
 * Which date a metric is attributed to.
 *
 * - `stay`  — the night is counted on the date it was slept (occupancy/RevPAR
 *             semantics; matches the Performance tab's `getNightsInPeriod`).
 * - `booked`— the whole booking is counted on the date it was made (demand /
 *             pace semantics; what a revenue manager calls "production").
 *
 * Mixing the two is the single most common analytics bug in this domain, so the
 * basis is always explicit in the response.
 */
export type AttributionBasis = 'stay' | 'booked';

// ── Meta / data coverage ─────────────────────────────────────────────────────

/**
 * Data-coverage envelope. Rendered as a banner so no chart is ever read as
 * more authoritative than the data behind it. With ~6 months of realised
 * trading, "seasonality" is directional, not established — the UI says so.
 */
export interface AnalyticsMeta {
  /** Archive freshness — last time a bookings sync touched the mirror. */
  mirrorLastSyncedAt: string | null;
  /** True when the archive has not been written for over 24h. */
  mirrorStale: boolean;
  /** Rows in the archive, by source. */
  rows: { bookings: number; blackouts: number };
  /** Realised trading window (first check-in → yesterday). */
  coverage: {
    firstCheckIn: string | null;
    lastCheckIn: string | null;
    /** Whole months of COMPLETED stay data available. */
    completeMonths: number;
    /** True when there is less than a full year — seasonality is indicative. */
    partialYear: boolean;
  };
  /** Rooms present in the archive, in display order. */
  rooms: string[];
  /** Channels present in the archive. */
  channels: string[];
  /** Known data quality caveats worth surfacing to the reader. */
  caveats: string[];
}

// ── Overview ────────────────────────────────────────────────────────────────

export interface CoreKpis {
  /** Nights physically sold inside the window (excl. cancellations & blackouts). */
  soldNights: number;
  /** Room-nights the portfolio could have sold (rooms × days − blackout nights). */
  availableNights: number;
  /** soldNights ÷ availableNights. 0–1. */
  occupancy: number;
  /** Gross booking value allocated to nights inside the window. */
  gbv: number;
  /** GBV ÷ soldNights. */
  adr: number;
  /** GBV ÷ availableNights — the gross headline. */
  revpar: number;
  /** OTA / channel commission allocated to the window. */
  otaCommission: number;
  /** Payment-processing fees allocated to the window. */
  paymentFees: number;
  /** GBV − commission − fees. */
  netSales: number;
  /** netSales ÷ availableNights — the headline the business is actually run on. */
  netRevpar: number;
  /**
   * netSales ÷ soldNights — what the business keeps per night sold.
   *
   * The companion to `adr`, and the one that decides a channel argument. Gross ADR
   * is what the guest paid; this is what survived the commission. A channel can
   * lose on `adr` and win on `netAdr`, which is exactly what direct booking does.
   */
  netAdr: number;
  /** (commission + fees) ÷ GBV — the all-in distribution take rate. 0–1. */
  takeRate: number;
  /** Distinct bookings with at least one night in the window. */
  bookings: number;
  /** Mean nights per booking (full stay length, not clipped). */
  avgLengthOfStay: number;
  /** Mean guests per booking. */
  avgPartySize: number;
  /** Mean days between booking and arrival. */
  avgLeadDays: number;
  /** Median days between booking and arrival — the honest central case. */
  medianLeadDays: number;
  /**
   * Guest cancellations ÷ all bookings due to arrive in the window, by booking
   * count. Abandoned checkouts (cancelled within minutes of creation) are
   * excluded from BOTH sides — same definition as the Booking windows section,
   * so the two never disagree.
   */
  cancellationRate: number;
  /** Mean review score normalised to 0–10, or null when nothing is reviewed. */
  avgReviewScore: number | null;
  reviewCount: number;
}

export interface MonthlyPoint {
  /** YYYY-MM */
  month: string;
  soldNights: number;
  availableNights: number;
  occupancy: number;
  gbv: number;
  adr: number;
  revpar: number;
  netSales: number;
  netRevpar: number;
  otaCommission: number;
  paymentFees: number;
  bookings: number;
  /** True when the month is not finished — render dashed / hatched. */
  partial: boolean;
}

export interface RoomPerformance {
  room: string;
  /** 'Deluxe' | 'Urban' | 'Other' — from utils/roomCategory. */
  category: string;
  soldNights: number;
  availableNights: number;
  blackoutNights: number;
  occupancy: number;
  gbv: number;
  adr: number;
  revpar: number;
  netSales: number;
  netRevpar: number;
  bookings: number;
  avgLengthOfStay: number;
  /** revpar ÷ portfolio revpar. 1.0 = exactly average. */
  revparIndex: number;
  avgReviewScore: number | null;
}

export interface ChannelPerformance {
  channel: string;
  bookings: number;
  soldNights: number;
  gbv: number;
  /** GBV ÷ nights — what the guest paid per night. */
  adr: number;
  otaCommission: number;
  paymentFees: number;
  netSales: number;
  /** netSales ÷ nights — what the business actually earned per night. */
  netAdr: number;
  /** (commission + fees) ÷ gbv. 0–1. */
  effectiveCommissionRate: number;
  /** Share of portfolio sold nights. 0–1. */
  nightShare: number;
  /** Share of portfolio net sales. 0–1. */
  netSalesShare: number;
  avgLengthOfStay: number;
  avgLeadDays: number;
  cancellationRate: number;
}

export interface DistributionBucket {
  label: string;
  bookings: number;
  nights: number;
  gbv: number;
  /** Share of bookings. 0–1. */
  share: number;
}

export interface NationalityRow {
  /** ISO-3166 alpha-2, or '—' when Beds24 supplied nothing. */
  code: string;
  bookings: number;
  nights: number;
  gbv: number;
  adr: number;
  avgLengthOfStay: number;
}

export interface PaceRow {
  /** YYYY-MM of the stay month. */
  month: string;
  /** Nights currently on the books for that month. */
  nightsOnBooks: number;
  /** Room-nights available in that month. */
  availableNights: number;
  /** nightsOnBooks ÷ availableNights. */
  occupancyOnBooks: number;
  gbvOnBooks: number;
  adrOnBooks: number;
  /**
   * Nights that had been booked for the PREVIOUS month at the same number of
   * days before that month started — the STLY substitute for a business with
   * under a year of history. Null when the comparison isn't computable.
   */
  nightsAtSameLeadPrevMonth: number | null;
  /** nightsOnBooks − nightsAtSameLeadPrevMonth, as a ratio. Null if no base. */
  paceVsPrevMonth: number | null;
  /** Days from today to the first of the stay month (negative = in progress). */
  daysOut: number;
}

export interface OverviewResponse {
  basis: AttributionBasis;
  query: Required<Pick<AnalyticsQuery, 'from' | 'to'>> & { rooms: string[]; channels: string[] };
  kpis: CoreKpis;
  /** Same KPIs for the immediately preceding window of equal length. */
  previous: CoreKpis | null;
  monthly: MonthlyPoint[];
  /** Physical-room league table — the detail view. */
  rooms: RoomPerformance[];
  /** Sellable-unit league table — the headline view. See `UnitPerformance`. */
  units: UnitPerformance[];
  channels: ChannelPerformance[];
  lengthOfStay: DistributionBucket[];
  partySize: DistributionBucket[];
  nationalities: NationalityRow[];
  /** Next 6 stay months, on-the-books position. Always forward-looking. */
  pace: PaceRow[];
  /** Revenue bridge, in render order. */
  bridge: { label: string; amount: number; kind: 'total' | 'deduction' | 'result' }[];
}

// ── Seasonality ─────────────────────────────────────────────────────────────

export interface HeatmapCell {
  /** YYYY-MM */
  month: string;
  room: string;
  soldNights: number;
  availableNights: number;
  occupancy: number;
  adr: number;
  revpar: number;
}

export interface WeekdayPoint {
  /** 1 = Monday … 7 = Sunday (ISO). */
  isoDow: number;
  label: string;
  soldNights: number;
  availableNights: number;
  occupancy: number;
  gbv: number;
  adr: number;
  revpar: number;
  /** Bookings that ARRIVE on this weekday. */
  arrivals: number;
  /** Bookings that DEPART on this weekday. */
  departures: number;
}

export interface DemandEvent {
  id: string;
  label: string;
  /** YYYY-MM-DD inclusive. */
  start: string;
  /** YYYY-MM-DD inclusive. */
  end: string;
  kind: 'motorsport' | 'trade-fair' | 'festival' | 'holiday' | 'other';
  /** Free-text note shown in the tooltip. */
  note?: string;
}

export interface EventImpactRow {
  event: DemandEvent;
  /**
   * True when the event has not happened yet.
   *
   * An upcoming event has no shoulder period to compare against — the fortnight
   * either side has not been sold either — so `baseline*` and `*Uplift` are null
   * and the row is a FORWARD position: how much of it is already on the books.
   * That is the actionable form: the biggest trade fair of the year is only worth
   * knowing about while there is still time to price for it.
   */
  isUpcoming: boolean;
  soldNights: number;
  availableNights: number;
  occupancy: number;
  adr: number;
  revpar: number;
  /** Same metrics for the ±14-day shoulder around the event, as a baseline. */
  baselineOccupancy: number | null;
  baselineAdr: number | null;
  /** adr ÷ baselineAdr − 1. Null when no baseline. */
  adrUplift: number | null;
  /** occupancy − baselineOccupancy. Null when no baseline. */
  occupancyUplift: number | null;
}

export interface SeasonalityResponse {
  basis: 'stay';
  query: OverviewResponse['query'];
  /** Month × room occupancy/ADR/RevPAR grid. */
  heatmap: HeatmapCell[];
  /** Portfolio totals per month, for the marginal row of the heatmap. */
  monthly: MonthlyPoint[];
  weekday: WeekdayPoint[];
  /** Per-month index: month RevPAR ÷ overall RevPAR. */
  seasonIndex: { month: string; revparIndex: number; occupancyIndex: number; adrIndex: number; partial: boolean }[];
  events: EventImpactRow[];
  /** Explicit warning when the window covers under 12 complete months. */
  confidence: { completeMonths: number; partialYear: boolean; message: string };
}

// ── Booking window ──────────────────────────────────────────────────────────

export interface LeadTimeBucket {
  label: string;
  /** Inclusive lower bound in days. */
  minDays: number;
  /** Inclusive upper bound in days, or null for open-ended. */
  maxDays: number | null;
  bookings: number;
  nights: number;
  gbv: number;
  adr: number;
  share: number;
  /** Cancellation rate for bookings made in this window. 0–1. */
  cancellationRate: number;
}

export interface BookingCurvePoint {
  /** Days before arrival (0 = day of arrival). Descending series. */
  daysBefore: number;
  /** Cumulative share of the month's final booked nights already on the books. */
  cumulativeShare: number;
  cumulativeNights: number;
}

export interface BookingCurveSeries {
  /** YYYY-MM stay month, or 'all' for the pooled curve. */
  month: string;
  /** Final (or current) booked nights for the month — the curve's 100%. */
  finalNights: number;
  /** True when the month is still selling, so the curve is incomplete. */
  inProgress: boolean;
  points: BookingCurvePoint[];
}

export interface LeadTimeTrendPoint {
  /** YYYY-MM of the BOOKING date. */
  month: string;
  bookings: number;
  avgLeadDays: number;
  medianLeadDays: number;
  p90LeadDays: number;
}

export interface CancellationAnalysis {
  totalBookings: number;
  cancelledBookings: number
  cancellationRate: number;
  /** GBV that was cancelled (nights × allocated price), i.e. demand lost. */
  cancelledGbv: number;
  /** Mean days between cancellation and arrival. */
  avgDaysBeforeArrival: number | null;
  byChannel: { channel: string; bookings: number; cancelled: number; rate: number; cancelledGbv: number; avgDaysBeforeArrival: number | null }[];
  byLeadBucket: { label: string; bookings: number; cancelled: number; rate: number }[];
  /** How long a cancelled booking survived before being cancelled. */
  survivalBuckets: { label: string; cancelled: number; share: number }[];
  /** Cancellations that were re-sold: the same room-night booked again later. */
  recoveredNights: number;
  cancelledNights: number;
}

export interface BookingHeatCell {
  /** 1 = Monday … 7 = Sunday, of the BOOKING timestamp (Europe/Prague). */
  isoDow: number;
  /** 0–23 local hour of the BOOKING timestamp. */
  hour: number;
  bookings: number;
}

export interface BookingWindowResponse {
  basis: 'booked';
  query: OverviewResponse['query'];
  leadTime: LeadTimeBucket[];
  summary: {
    bookings: number;
    avgLeadDays: number;
    medianLeadDays: number;
    p90LeadDays: number;
    /** Share of bookings made 7 or fewer days out. 0–1. */
    lastMinuteShare: number;
    /** Share of bookings made 60+ days out. 0–1. */
    earlyBirdShare: number;
  };
  curves: BookingCurveSeries[];
  trend: LeadTimeTrendPoint[];
  byChannel: { channel: string; bookings: number; avgLeadDays: number; medianLeadDays: number }[];
  byRoom: { room: string; bookings: number; avgLeadDays: number; medianLeadDays: number }[];
  /** Lead time by stay month — is the window for peak months longer? */
  byStayMonth: { month: string; bookings: number; avgLeadDays: number; medianLeadDays: number }[];
  cancellations: CancellationAnalysis;
  bookingHeat: BookingHeatCell[];
}

// ── Costs & commissions ─────────────────────────────────────────────────────

/** The variable-cost categories, in bridge order. */
export const VARIABLE_COST_KEYS = [
  'cleaning',
  'laundry',
  'consumables',
  'wearTear',
  'misc',
  'subscriptions',
] as const;
export type VariableCostKey = (typeof VARIABLE_COST_KEYS)[number];

export const VARIABLE_COST_LABELS: Record<VariableCostKey, string> = {
  cleaning: 'Cleaning',
  laundry: 'Laundry',
  consumables: 'Consumables',
  wearTear: 'Wear & tear',
  misc: 'Misc',
  subscriptions: 'Subscriptions',
};

export type VariableCostTotals = Record<VariableCostKey, number>;

export interface CostMonthlyPoint {
  month: string;
  soldNights: number;
  gbv: number;
  otaCommission: number;
  paymentFees: number;
  netSales: number;
  costs: VariableCostTotals;
  totalVariableCosts: number;
  grossProfit: number;
  /** grossProfit ÷ gbv. */
  grossMargin: number;
  /** totalVariableCosts ÷ soldNights — cost per occupied room night. */
  cpor: number;
  /** grossProfit ÷ availableNights — the profit twin of RevPAR. */
  gopar: number;
  availableNights: number;
  partial: boolean;
}

export interface CommissionByChannelMonth {
  month: string;
  channel: string;
  gbv: number;
  commission: number;
  paymentFees: number;
  /** (commission + fees) ÷ gbv. */
  effectiveRate: number;
}

export interface LosEconomicsRow {
  /** '1', '2', '3', '4–6', '7+' */
  label: string;
  bookings: number;
  nights: number
  gbv: number;
  netSales: number;
  /** Turnover-driven costs (cleaning + laundry + consumables) per booking. */
  turnoverCostPerBooking: number;
  /** Net sales per booking. */
  netSalesPerBooking: number;
  /** netSalesPerBooking − turnoverCostPerBooking. */
  contributionPerBooking: number;
  /** contributionPerBooking ÷ nights per booking. */
  contributionPerNight: number;
}

export interface ChannelProfitRow {
  channel: string;
  soldNights: number;
  bookings: number;
  gbv: number;
  adr: number;
  otaCommission: number;
  paymentFees: number;
  netSales: number;
  /** Turnover + consumable costs attributed to this channel's checkouts. */
  variableCosts: number;
  contribution: number;
  /** contribution ÷ soldNights — the only fair channel comparison. */
  contributionPerNight: number;
  /** contribution ÷ gbv. */
  contributionMargin: number;
}

export interface SupplierCostRow {
  category: string;
  label: string;
  invoices: number;
  amount: number;
  share: number;
}

export interface SettlementVarianceRow {
  /** Channel + period label, e.g. "Booking.com · February 2026". */
  name: string;
  source: string | null;
  /**
   * How many imported statements were pooled into this row. A channel often
   * issues several payouts for one month; comparing each one against the whole
   * month's Beds24 commission would report a huge false variance on every one of
   * them, so they are summed first.
   */
  statementCount: number;
  periodStart: string | null;
  periodEnd: string | null;
  /** Commission the OTA actually charged, from the imported statement. */
  statementCommission: number | null;
  statementGross: number | null;
  statementNet: number | null;
  /**
   * Commission Beds24 reported for bookings whose STAY overlapped the same
   * period. Statements are settled on payout dates, not stay dates, so a gap
   * here is expected — it flags order-of-magnitude problems, not pennies.
   */
  beds24Commission: number;
  variance: number | null;
  variancePct: number | null;
}

export interface CostsResponse {
  basis: 'stay';
  query: OverviewResponse['query'];
  totals: {
    gbv: number;
    otaCommission: number;
    paymentFees: number;
    netSales: number;
    costs: VariableCostTotals;
    totalVariableCosts: number;
    grossProfit: number;
    grossMargin: number;
    soldNights: number;
    availableNights: number;
    cpor: number;
    gopar: number;
    /** commission ÷ gbv, OTA only. */
    otaCommissionRate: number;
  };
  monthly: CostMonthlyPoint[];
  commissionByChannelMonth: CommissionByChannelMonth[];
  commissionByChannel: { channel: string; gbv: number; commission: number; paymentFees: number; effectiveRate: number }[];
  costByRoom: { room: string; soldNights: number; costs: VariableCostTotals; total: number; cpor: number }[];
  losEconomics: LosEconomicsRow[];
  channelProfit: ChannelProfitRow[];
  supplierMix: SupplierCostRow[];
  topSuppliers: { supplier: string; invoices: number; amount: number }[];
  settlementVariance: SettlementVarianceRow[];
  /** Booking.com Genius: what the discount programme costs in ADR terms. */
  geniusImpact: {
    geniusBookings: number;
    nonGeniusBookings: number;
    geniusAdr: number;
    nonGeniusAdr: number;
    /**
     * geniusAdr ÷ nonGeniusAdr − 1. Negative = Genius books cheaper.
     * Null when either group is too small to compare — see `comparable`.
     */
    adrDelta: number | null;
    geniusNightShare: number;
    /** False when either group has fewer than `minComparisonBookings` bookings. */
    comparable: boolean;
    minComparisonBookings: number;
  } | null;
  /** Costs that exist in the accounting ledger but not in the variable-cost engine. */
  notes: string[];
}

// ── Sellable units (room groups) ─────────────────────────────────────────────

/**
 * Performance of one sellable unit — the grain the market actually buys.
 *
 * Per-room numbers are kept alongside these, but they answer a different
 * question. Beds24 chooses which of K.102 / K.103 / K.106 a booking lands in, so
 * a single room at 100% while its siblings sit lower is an allocator artefact.
 * The unit is what was on sale, so the unit is what can be judged.
 */
export interface UnitPerformance {
  unitId: string;
  label: string;
  shortLabel: string;
  /** Physical rooms backing the unit, so the UI can show what it contains. */
  rooms: string[];
  bedrooms: number;
  soldNights: number;
  availableNights: number;
  occupancy: number;
  gbv: number;
  adr: number;
  revpar: number;
  netSales: number;
  netRevpar: number;
  bookings: number;
  avgLengthOfStay: number;
  /** revpar ÷ portfolio revpar. 1.0 = exactly average. */
  revparIndex: number;
  /**
   * Calendar dates on which EVERY unit of this group was sold.
   *
   * The bias-free underpricing signal: a group with nothing left to sell could
   * not have sold more at any price, so its rate never had to ration demand.
   */
  soldOutDates: number;
  /** Dates the unit had any capacity on sale. */
  openDates: number;
  /** soldOutDates ÷ openDates. */
  soldOutRate: number;
  avgReviewScore: number | null;
}

// ── Occupancy section ───────────────────────────────────────────────────────
//
// Every figure is split by ROOM CLASS (1KK studios vs 2KK apartments — see
// `ROOM_CLASSES` in data/analyticsConfig.ts): the two have different ADR and
// seasonality, so a blended number hides more than it shows.

export type OccupancyClassId = '1kk' | '2kk';

/**
 * Gross profit for a slice, on the nights that have both HAPPENED and been
 * COSTED (cost logging began in March 2026).
 *
 * "Gross profit" here is net sales minus STAY costs — cleaning, laundry,
 * consumables, wear & tear and misc — i.e. before the fixed monthly
 * subscriptions. Subscriptions do not move with occupancy, price or stay length,
 * and they differ by room for reasons unrelated to demand (only the Urban
 * studios pay for parking; O.308 carries none), so leaving them in would bias
 * every room-to-room comparison. The class scorecard shows them separately.
 */
export interface ProfitSlice {
  /** Room-nights on sale in the costed, completed part of the slice. */
  availableNights: number;
  soldNights: number;
  occupancy: number;
  /** Gross ADR on the same nights. */
  adr: number;
  netSales: number;
  /** Cleaning + laundry + consumables + wear & tear + misc. */
  stayCosts: number;
  grossProfit: number;
  /** grossProfit ÷ availableNights — THE number this section ranks on. */
  perAvailableNight: number;
  perSoldNight: number;
}

/** Occupancy and money for one slice (a class, a room, a month, …). */
export interface OccSlice {
  /** Room-nights on sale (room online, not blacked out). */
  availableNights: number;
  /** Room-nights sold. */
  soldNights: number;
  occupancy: number;
  gbv: number;
  /** gbv − OTA commission − payment fees. */
  netSales: number;
  adr: number;
  netAdr: number;
  /** gbv ÷ availableNights = occupancy × ADR. */
  revpar: number;
  netRevpar: number;
  /** Distinct bookings with a night in the slice. */
  stays: number;
  /** Mean full length of those bookings, in nights. */
  avgLos: number;
  /** Share of sold nights that came from stays of `longStayMinNights`+. */
  longStayShare: number;
  /** Null when no night in the slice is both completed and costed. */
  profit: ProfitSlice | null;
}

export interface MarketPosition {
  /** Comp-set occupancy, weighted by our nights on sale in each listing. */
  occupancy: number | null;
  /** Our occupancy ÷ market occupancy. */
  mpi: number | null;
  /** Comp-set ADR — Airbnb-listed prices, context only (different fee load). */
  adr: number | null;
}

export interface OccupancyClassInfo {
  id: OccupancyClassId;
  label: string;
  description: string;
  /** Physical rooms of the class that are in scope. */
  rooms: string[];
}

export interface ClassScorecard {
  classId: OccupancyClassId | 'all';
  label: string;
  rooms: string[];
  slice: OccSlice;
  market: MarketPosition;
  /** Fixed subscriptions over the costed nights, pro-rated by day. */
  subscriptions: number | null;
  /** profit.grossProfit − subscriptions. */
  grossProfitAfterSubscriptions: number | null;
}

export interface ClassMonthPoint {
  month: string;
  /** Month not fully inside the window, or not finished yet. */
  partial: boolean;
  slice: OccSlice;
  market: MarketPosition;
}

export interface ClassForwardHorizon {
  horizonDays: number;
  label: string;
  ourOccupancy: number;
  ourSoldNights: number;
  ourAvailableNights: number;
  marketOccupancy: number | null;
  mpi: number | null;
}

export interface RoomMonthCell {
  room: string;
  classId: OccupancyClassId;
  month: string;
  partial: boolean;
  slice: OccSlice;
}

/**
 * Same class, same month, two rooms whose occupancy differed by at least
 * `minOccupancyGap`: did the FULLER room earn more gross profit per available
 * night? Holding class and month fixed is what takes season and product out of
 * the comparison, leaving price and stay mix.
 */
export interface SameMonthPairSummary {
  classId: OccupancyClassId;
  minOccupancyGap: number;
  pairs: number;
  /** Pairs where the fuller room also earned more GP per available night. */
  fullerEarnedMore: number;
  /** Mean (fuller − emptier) occupancy, in ratio points. */
  avgOccupancyGap: number;
  /** Mean fuller ADR ÷ emptier ADR − 1. */
  avgAdrGap: number;
  /** Mean (fuller − emptier) GP per available night, Kč. */
  avgProfitGap: number;
  /** The pairs where the emptier room won, largest margin first. */
  counterExamples: {
    month: string;
    fuller: { room: string; occupancy: number; adr: number; perAvailableNight: number };
    emptier: { room: string; occupancy: number; adr: number; perAvailableNight: number };
  }[];
}

export interface LosEconomicsBucket {
  label: string;
  stays: number;
  nights: number;
  adr: number;
  netAdr: number;
  /** Cleaning + laundry + consumables, spread over the stay's nights. */
  turnoverCostPerNight: number;
  /** netAdr − turnoverCostPerNight. */
  profitPerNight: number;
}

/**
 * A long stay against its sibling rooms over EXACTLY the same nights.
 *
 * The question it answers: a weekly guest takes a discount but fills every night
 * and costs one cleaning — did that room out-earn the same-class rooms that sold
 * the same dates to shorter stays (gaps and extra turnovers included)?
 * Siblings that themselves held a long stay on those dates are left out, so the
 * comparison is long stay vs short stays.
 */
export interface LongStayDuel {
  classId: OccupancyClassId;
  reservationNumber: string;
  channel: string;
  /** Room(s) the stay occupied (two for a mid-stay move). */
  rooms: string[];
  /** Full booking. */
  checkIn: string;
  checkOut: string;
  stayNights: number;
  /** First and last compared night (completed, costed, in the window). */
  from: string;
  to: string;
  /** Nights compared. */
  nights: number;
  adr: number;
  netAdr: number;
  profitPerNight: number;
  siblings: {
    rooms: string[];
    availableNights: number;
    occupancy: number;
    adr: number;
    stays: number;
    profitPerAvailableNight: number;
  };
  /** profitPerNight − siblings.profitPerAvailableNight. */
  deltaPerNight: number;
  /** deltaPerNight × nights. */
  deltaTotal: number;
}

export interface LongStaySummary {
  classId: OccupancyClassId;
  duels: number;
  /** Duels the long stay won (positive delta). */
  won: number;
  nights: number;
  /** Night-weighted mean delta per night. */
  avgDeltaPerNight: number;
  totalDelta: number;
}

export interface SoldOutDay {
  date: string;
  capacity: number;
  sold: number;
  soldOut: boolean;
  future: boolean;
}

export interface ClassWeekdayPoint {
  isoDow: number;
  label: string;
  dates: number;
  availableNights: number;
  soldNights: number;
  occupancy: number;
  soldOutDates: number;
  soldOutRate: number;
  /** ADR of stays shorter than `longStayMinNights` — weekly rates excluded. */
  shortStayAdr: number;
  /** Same, on sold-out dates vs dates with a room left. */
  shortStayAdrSoldOut: number | null;
  shortStayAdrSpare: number | null;
  spareDates: number;
}

export interface ClassSoldOut {
  classId: OccupancyClassId;
  /** Physical rooms of the class in scope. */
  rooms: number;
  /** Calendar dates with at least one room of the class on sale. */
  dates: number;
  /** Dates on which every room of the class on sale that night was sold. */
  soldOutDates: number;
  soldOutRate: number;
  longestRun: number;
  days: SoldOutDay[];
  weekday: ClassWeekdayPoint[];
}

export interface OccupancyResponse {
  basis: 'stay';
  query: OverviewResponse['query'];
  classes: OccupancyClassInfo[];
  /** Stays of this many nights or more count as long (weekly-rate) stays. */
  longStayMinNights: number;
  /** What the gross-profit figures cover. */
  profitCoverage: {
    costsAvailable: boolean;
    /** First night with logged stay costs (YYYY-MM-DD), or null. */
    costsFrom: string | null;
    /** GP covers nights strictly before this date (today). */
    completedBefore: string;
  };
  scorecard: ClassScorecard[];
  monthly: { classId: OccupancyClassId; points: ClassMonthPoint[] }[];
  forward: { classId: OccupancyClassId; compSetListings: number | null; horizons: ClassForwardHorizon[] }[];
  roomMonths: RoomMonthCell[];
  /** Each room over the whole window — the grid's "Period" column. */
  roomTotals: { room: string; classId: OccupancyClassId; slice: OccSlice }[];
  sameMonthPairs: SameMonthPairSummary[];
  losEconomics: { classId: OccupancyClassId; buckets: LosEconomicsBucket[] }[];
  longStayDuels: LongStayDuel[];
  longStaySummary: LongStaySummary[];
  soldOut: ClassSoldOut[];
  market: {
    configured: boolean;
    capturedAt: string | null;
    source: string;
  };
  notes: string[];
  confidence: { completeMonths: number; partialYear: boolean; message: string };
}

// ── Rates section ───────────────────────────────────────────────────────────
//
// Organised around the four questions the tab exists to answer, every one of
// them in GROSS PROFIT rather than ADR — because a plan, promotion or channel
// that lifts ADR while cancelling more, costing more commission or selling
// shorter stays can still lose money:
//   1. Do the rate plans (non-refundable / standard / flexible) make sense?
//   2. Are the time-limited deals working?
//   3. Which rates cancel, do we resell those nights, and at what price?
//   4. Is the direct channel earning more, or is it priced too cheap?
//
// Everything is computed per room CLASS — 1KK studios and 2KK apartments have
// different ADR, seasonality and guest mix, so a blended figure hides more
// than it shows. Each response carries one view per class plus the blend.

export type RateClassId = 'all' | '1kk' | '2kk';

/**
 * Gross profit per night, and everything it is built from, for one slice of the
 * book (a plan, a promotion, a channel, a class).
 *
 * Gross profit here = gross − OTA commission − payment fees − TURNOVER cost
 * (cleaning, laundry, consumables, charged once per checkout and spread over the
 * stay's nights). Subscriptions and wear & tear are the same whichever rate sold
 * the night, so they are left out of every comparison on this tab.
 */
export interface RateEconomics {
  /** Live bookings with at least one night in the window. */
  bookings: number;
  nights: number;
  /** Share of the class's nights in the window. 0–1. */
  nightShare: number;
  gbv: number;
  commission: number;
  paymentFees: number;
  turnoverCost: number;
  netSales: number;
  grossProfit: number;
  adr: number;
  /** (gross − commission − fees) per night. */
  netAdr: number;
  gpPerNight: number;
  /** (commission + fees) ÷ gross. */
  takeRate: number;
  turnoverPerNight: number;
  avgLengthOfStay: number;
  avgLeadDays: number;
  /** Live + guest-cancelled bookings whose stay touches the window. */
  cancellableBookings: number;
  guestCancellations: number;
  cancellationRate: number;
}

/**
 * The same unit on the same night, sold two different ways.
 *
 * Comparing plan or channel averages mixes in WHEN each sold — a plan that
 * happens to sell in August looks dearer than one that sells in February. Pairing
 * nights of the same sellable unit on the same date takes the season, weekday and
 * events out, so what is left is the plan (or channel) itself. Each matched
 * (unit, date) cell counts once.
 */
export interface SameDateComparison {
  /** What is being compared against, e.g. "Booking.com Non-refundable". */
  against: string;
  /**
   * 'date' = same unit, same night. 'week' = same unit, same ISO week and the
   * same kind of night (Fri/Sat vs the rest) — the fallback for single-room
   * units (K.201, O.308), where two bookings can never share a night.
   */
  grain: 'date' | 'week';
  matchedDates: number;
  /** Distinct bookings behind the compared side's matched nights. */
  matchedBookings: number;
  /** MEDIAN over matched cells of (slice ÷ reference) − 1, so one odd booking cannot move it. */
  adrDelta: number | null;
  netAdrDelta: number | null;
  gpDelta: number | null;
  /** True when both floors (matched cells, distinct bookings) are cleared and the deltas are reported. */
  comparable: boolean;
}

export interface RatePlanRow extends RateEconomics {
  channel: string;
  plan: string;
  vsNonRefundable: SameDateComparison | null;
  /** Guest-cancelled room-nights in the window that are already in the past. */
  cancelledNights: number;
  resoldNights: number;
  /**
   * Gross profit per night this plan BOOKED, after its cancellations:
   * (GP of the nights that stayed + GP recovered by reselling its cancelled
   * nights) ÷ (stayed + cancelled nights). The fair way to compare a cheap
   * plan that sticks with a dearer one that cancels.
   */
  gpPerBookedNight: number;
}

export interface PromoCampaignRow {
  /** The promotion name exactly as the channel sent it. */
  name: string;
  firstBooked: string | null;
  lastBooked: string | null;
  bookings: number;
  nights: number;
  adr: number;
  gpPerNight: number;
  cancellationRate: number;
}

export interface PromoRow extends RateEconomics {
  promo: string;
  /** Standing promotion (always on) or a time-limited one switched on by hand. */
  timeLimited: boolean;
  /** Against every other night that sold for the same unit on the same date. */
  vsSameDate: SameDateComparison | null;
  /**
   * How full the rest of the class was on the nights this promotion sold —
   * other rooms' sold nights ÷ other rooms' available nights. A discount that
   * lands on nights the class was filling anyway is the expensive kind.
   */
  dateStrength: number | null;
  campaigns: PromoCampaignRow[];
}

export interface ChannelRow extends RateEconomics {
  channel: string;
  vsBookingCom: SameDateComparison | null;
}

/**
 * Is the direct channel priced too cheap?
 *
 * A direct night can sell `breakEvenDiscount` below Booking.com and net exactly
 * the same; the commission saving beyond that is margin kept. Compared on the
 * same unit and date so the season cannot masquerade as a pricing decision.
 */
export interface DirectPricingCheck {
  channel: string;
  takeRate: number;
  bookingComTakeRate: number;
  breakEvenDiscount: number;
  /** How the same-night comparison was matched (see SameDateComparison.grain). */
  grain: 'date' | 'week';
  matchedDates: number;
  /** Direct gross ÷ Booking.com gross − 1, same unit, same date. Negative = cheaper. */
  sameDateGrossDelta: number | null;
  sameDateNetDelta: number | null;
  sameDateGpDelta: number | null;
  verdict: 'too-cheap' | 'near-break-even' | 'keeping-margin' | 'insufficient-data';
}

/** Cancelled room-nights and what became of them, for one plan or one unit. */
export interface ResaleRow {
  label: string;
  channel: string | null;
  cancelledBookings: number;
  /** Past cancelled room-nights — the ones whose fate is known. */
  cancelledNights: number;
  resoldNights: number;
  resaleRate: number;
  /** Per-night price the cancelled booking had agreed. Null when unknown (direct). */
  originalAdr: number | null;
  /** Per-night price the replacement booking paid. */
  resaleAdr: number | null;
  /** resaleAdr ÷ originalAdr over resold nights where both are known. */
  priceRatio: number | null;
  /** GP the cancelled nights would have made vs what the resale made. */
  originalGp: number | null;
  recoveredGp: number;
  avgDaysBeforeArrival: number | null;
  avgDaysToResell: number | null;
  /** Cancelled nights still in the future — fate not yet known. */
  openNights: number;
}

/**
 * ADR by lead time, on a STAY basis — the far-out pricing test.
 *
 * The pricing engine is configured to charge a premium for booking far ahead. This
 * is the measurement of whether that premium is actually landing: what was
 * achieved per night by how far ahead it was bought, and how much of the book each
 * bucket delivers. A far-out bucket with a lower achieved ADR than the near-in one
 * means the premium is not being paid — it is being avoided.
 */
export interface LeadAdrRow {
  label: string;
  minDays: number;
  maxDays: number | null;
  nights: number;
  bookings: number;
  adr: number;
  gpPerNight: number;
  /** adr ÷ the near-in reference bucket's adr − 1. */
  vsReference: number | null;
  nightShare: number;
  /** Guest cancellation rate for bookings made in this bucket. */
  cancellationRate: number;
  /** ADR net of the cancellation risk in this bucket — adr × (1 − cancellationRate). */
  riskAdjustedAdr: number;
}

export interface RateMixMonthPoint {
  month: string;
  adr: number;
  gpPerNight: number;
  /** Night share per channel, so a mix shift is visible against the ADR line. */
  shares: Record<string, number>;
}

export interface RatesClassView {
  classId: RateClassId;
  label: string;
  description: string;
  /** Sellable units in the class (see SELLABLE_UNITS). */
  unitIds: string[];
  totals: RateEconomics;
  /** Share of nights sold on a non-refundable plan. */
  nonRefundableShare: number;
  /** Share of nights that arrived on any promotion. */
  promoShare: number;
  /** Share of nights on a time-limited deal. */
  timeLimitedShare: number;
  /** Share of nights sold direct (web + phone). */
  directShare: number;
  /** How full the rest of the class was, on average, on the nights it sold — the baseline for a promotion's dateStrength. */
  avgDateStrength: number | null;
  plans: RatePlanRow[];
  promos: PromoRow[];
  channels: ChannelRow[];
  directPricing: DirectPricingCheck[];
  resaleByPlan: ResaleRow[];
  resaleByUnit: ResaleRow[];
  resaleTotal: ResaleRow;
  leadAdr: LeadAdrRow[];
  achievedFarOutPremium: number | null;
  mixMonthly: RateMixMonthPoint[];
  channelList: string[];
  genius: {
    geniusNights: number;
    totalBookingComNights: number;
    geniusNightShare: number;
    geniusAdr: number;
    nonGeniusAdr: number;
    adrDelta: number | null;
    comparable: boolean;
    minComparisonBookings: number;
  } | null;
  losMix: { label: string; bookings: number; nights: number; adr: number; gpPerNight: number; nightShare: number }[];
}

export interface RatesResponse {
  basis: 'stay';
  query: OverviewResponse['query'];
  /** 1KK, 2KK and the blend, in that order. */
  classes: RatesClassView[];
  /** The far-out premium the pricing engine is configured to charge. */
  configuredFarOutPremium: { nearDays: number; farDays: number; premium: number };
  /** Same-date comparisons need at least this many matched dates… */
  minMatchedDates: number;
  /** …from at least this many distinct bookings. */
  minMatchedBookings: number;
  /** How the turnover cost in every GP figure was sourced. */
  costCoverage: {
    available: boolean;
    /** Booking-rooms whose checkout cleaning is logged in the cleaning app. */
    actual: number;
    /** Booking-rooms costed at their unit's average turnover (future, legacy or unlogged). */
    estimated: number;
    perCheckoutByUnit: { unitId: string; label: string; perCheckout: number; samples: number }[];
  };
  notes: string[];
}

// ── Market benchmark (PriceLabs) ────────────────────────────────────────────

/**
 * Provenance for every market figure.
 *
 * Rendered wherever market data appears. The comp set is scraped from Airbnb and
 * VRBO; Booking.com — 83% of our nights — is not in it. Occupancy survives that
 * (a channel manager blocks the Airbnb calendar whichever channel books, and
 * PriceLabs' inferred occupancy for K.201 reproduced our archive to the decimal),
 * but price percentiles are an Airbnb-listed view carrying a ~3% host fee where
 * our Booking.com-facing rates absorb ~17%. Position, not target.
 */
export interface MarketMeta {
  /** False when PRICELABS_API_KEY is absent — the section degrades, never errors. */
  configured: boolean;
  /** When the snapshot was pulled. Null when nothing has been captured yet. */
  capturedAt: string | null;
  /** True when the snapshot is over 48h old. */
  stale: boolean;
  /** Listings in the comp set PriceLabs used. */
  compSetListings: number | null;
  /** Which platforms the comp set is scraped from. */
  source: string;
  caveats: string[];
}

/** Our forward position against the market over one horizon. */
export interface HorizonPosition {
  horizonDays: number;
  label: string;
  /** From bookings_mirror — never from PriceLabs, whose own-side data is broken for multi-unit listings. */
  ourOccupancy: number;
  ourSoldNights: number;
  ourAvailableNights: number;
  marketOccupancy: number | null;
  /** ourOccupancy ÷ marketOccupancy. Above 1 = we are outselling the market. */
  mpi: number | null;
}

export interface UnitHorizons {
  unitId: string;
  label: string;
  shortLabel: string;
  /** Null when the unit is not synced to PriceLabs. */
  listingId: string | null;
  /**
   * Comp listings behind this unit's benchmark.
   *
   * Shown because it is not uniform: the 1-bedroom pool runs to a few hundred
   * listings while O.308's 2-bedroom pool is under twenty, and a reader comparing
   * the two MPI figures should be able to see that one rests on far less evidence.
   */
  compSetListings: number | null;
  horizons: HorizonPosition[];
}

export interface MarketMonthPoint {
  month: string;
  marketOccupancy: number | null;
  marketAdr: number | null;
  /** Mean days between booking and arrival across the comp set. */
  marketBookingWindow: number | null;
  marketLos: number | null;
}

export interface MarketPricePoint {
  stayDate: string;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  /** Median price of comps that actually booked this night. */
  medianBooked: number | null;
  /** PriceLabs' recommendation for us. */
  recommended: number | null;
  /** What is live on Beds24. Null when the night is already sold or closed. */
  live: number | null;
  marketOccupancy: number | null;
  marketSupply: number | null;
}

export interface MarketResponse {
  meta: MarketMeta;
  /** Portfolio position by horizon — our side summed, market side capacity-weighted. */
  portfolio: HorizonPosition[];
  byUnit: UnitHorizons[];
  /** Capacity-weighted market series by month, for reference lines. */
  monthly: MarketMonthPoint[];
  monthlyByUnit: { unitId: string; shortLabel: string; points: MarketMonthPoint[] }[];
  prices: { unitId: string; shortLabel: string; bedrooms: number; points: MarketPricePoint[] }[];
  /** The single most strategic comparison available: how far ahead each side books. */
  bookingWindow: {
    ourMedianDays: number;
    ourAvgDays: number;
    marketAvgDays: number | null;
    /** marketAvgDays ÷ ourMedianDays. */
    marketMultiple: number | null;
  } | null;
}

// ── Web funnel (admin only) ──────────────────────────────────────────────────

/** One Prague day of the site's own counters, joined with real web bookings. */
export interface WebFunnelDay {
  day: string;
  /** Raw counters for the day (`view_item_list`, `select_item|room=679714`, …). */
  metrics: Record<string, number>;
  /** Direct-Web bookings made that day (bookings archive, cancellations excluded). */
  bookings: number;
  /** Their gross value, CZK. */
  bookingsRevenue: number;
  /** Direct-Web bookings made that day and since cancelled. */
  cancelled: number;
}

/** Searches grouped by the ARRIVAL date the guest asked for. */
export interface WebDemandRow {
  arrival: string;
  searches: number;
  /** Searches for this arrival that came back with nothing bookable. */
  noAvailability: number;
  avgNights: number;
  avgGuests: number;
  /** Largest party asking for this arrival. */
  maxGuests: number;
}

export interface WebPartySizeRow {
  guests: number;
  searches: number;
  noAvailability: number;
}

export interface WebTrafficRow {
  key: string;
  sessions: number;
  /** Sum of GA's daily user counts — a returning visitor counts once per day. */
  users: number;
  purchases: number;
  revenue: number;
}

export interface WebFunnelResponse {
  /** Every figure here is dated by when it HAPPENED on the site, not by stay date. */
  basis: 'event';
  from: string;
  to: string;
  todayIso: string;
  /** First day the archive has first-party counts for; null = nothing copied yet. */
  countingSince: string | null;
  lastCopiedAt: string | null;
  /** Which Redis inbox the copy reads — anything but `bh:funnel` is test data. */
  copySource: { configured: boolean; prefix: string };
  days: WebFunnelDay[];
  demand: WebDemandRow[];
  partySize: WebPartySizeRow[];
  ga: {
    configured: boolean;
    lastFetchedAt: string | null;
    firstDay: string | null;
    channels: WebTrafficRow[];
    sourceMedium: WebTrafficRow[];
    /**
     * GA purchases vs archive bookings over the SAME days, starting no earlier than
     * GA_PURCHASES_SINCE (the site only sends `purchase` to GA from then). Null when
     * the window holds none of those days.
     */
    purchaseCheck: { since: string; until: string; gaPurchases: number; webBookings: number } | null;
  };
}

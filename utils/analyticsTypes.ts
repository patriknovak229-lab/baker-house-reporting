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

/**
 * Weekday performance on a TRANSIENT basis.
 *
 * The plain weekday view is contaminated by long stays: a Monday night inside a
 * 25-night booking was bought once, at a negotiated rate, months earlier — and it
 * then blocks the room against every later Monday enquiry. It drags weekday ADR
 * down while pushing weekday occupancy up, so the two errors cannot cancel.
 *
 * Here, stays longer than `transientLosMax` are removed from the sold side AND
 * their room-nights are removed from the available side, because a room committed
 * to a monthly guest was never on sale to a Friday transient booker.
 */
export interface TransientWeekdayPoint {
  isoDow: number;
  label: string;
  /** Sold transient room-nights. */
  soldNights: number;
  /** Room-nights that were genuinely on sale to transient demand. */
  availableNights: number;
  occupancy: number;
  adr: number;
  revpar: number;
  /** Room-nights removed because a long stay already held them. */
  longStayNights: number;
  /** Calendar dates of this weekday where transient capacity hit zero. */
  soldOutDates: number;
  /** Calendar dates of this weekday inside the window. */
  totalDates: number;
  /** soldOutDates ÷ totalDates — how often this weekday ran out of rooms. */
  soldOutRate: number;
  /**
   * ADR achieved on the dates that sold out, versus dates with capacity left.
   *
   * The diagnostic, not the headline. If sold-out nights are earning LESS than
   * nights with spare rooms, price is not rationing demand on the days that
   * matter — the classic underpricing signature. Null when either group is empty.
   */
  adrWhenSoldOut: number | null;
  adrWhenSpare: number | null;
  spareDates: number;
}

/** One calendar date's compression state, for the strip chart. */
export interface CompressionDay {
  stayDate: string;
  isoDow: number;
  capacity: number;
  sold: number;
  occupancy: number;
  soldOut: boolean;
  adr: number;
}

export interface UnitHeatCell {
  month: string;
  unitId: string;
  soldNights: number;
  availableNights: number;
  occupancy: number;
  adr: number;
  revpar: number;
}

export interface OccupancyResponse {
  basis: 'stay';
  query: OverviewResponse['query'];
  /** Portfolio totals per month. */
  monthly: MonthlyPoint[];
  /** Month × sellable unit grid — the group-level heatmap. */
  unitHeatmap: UnitHeatCell[];
  /** Month × physical room grid, kept as the detail view. */
  roomHeatmap: HeatmapCell[];
  /** Raw weekday view, all stay lengths. */
  weekday: WeekdayPoint[];
  /** Weekday view with long stays removed from both sides. */
  weekdayTransient: TransientWeekdayPoint[];
  /** The LOS ceiling used to define transient demand. */
  transientLosMax: number;
  compression: {
    /** Dates where every transient-available room sold. */
    soldOutDates: number;
    totalDates: number;
    soldOutRate: number;
    /** Room-nights lost to long stays inside the window. */
    longStayNights: number;
    longStayBookings: number;
    days: CompressionDay[];
  };
  seasonIndex: { month: string; revparIndex: number; occupancyIndex: number; adrIndex: number; partial: boolean }[];
  events: EventImpactRow[];
  confidence: { completeMonths: number; partialYear: boolean; message: string };
}

// ── Rates section ───────────────────────────────────────────────────────────

/**
 * Rate composition — what mix of rate plans produced the ADR.
 *
 * ADR is an outcome, not a decision. It moves when the mix moves: more Genius
 * nights, more non-refundable, more OTA and less direct. Splitting it out is the
 * difference between "ADR fell" and "ADR fell because Booking.com share rose 9
 * points", which are different problems with different fixes.
 */
export interface RateMixRow {
  /** The bucket: a rate-plan family, a promotion name, or a channel. */
  label: string;
  /** 'All' for channel rows; the owning channel for plan and promotion rows. */
  channel: string;
  bookings: number;
  nights: number;
  gbv: number;
  adr: number;
  /** Share of nights in the window. 0–1. */
  nightShare: number;
  /** adr ÷ portfolio adr − 1. */
  adrIndex: number;
  avgLengthOfStay: number;
  avgLeadDays: number;
  cancellationRate: number;
}

export interface RateMixMonthPoint {
  month: string;
  adr: number;
  /** Night share per channel, so a mix shift is visible against the ADR line. */
  shares: Record<string, number>;
  adrByChannel: Record<string, number>;
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
  /** adr ÷ the near-in reference bucket's adr − 1. */
  vsReference: number | null;
  nightShare: number;
  /** Guest cancellation rate for bookings made in this bucket. */
  cancellationRate: number;
  /** ADR net of the cancellation risk in this bucket — adr × (1 − cancellationRate). */
  riskAdjustedAdr: number;
}

export interface RatesResponse {
  basis: 'stay';
  query: OverviewResponse['query'];
  adr: number;
  /** Rate-plan families: non-refundable, flexible, weekly, one-night, standard. */
  planMix: RateMixRow[];
  /**
   * OTA promotions the booking arrived on — Last Minute Deal, Early Booker Deal,
   * Mobile app rate and friends, parsed out of Beds24's rate description.
   *
   * This is where most of the ADR story lives. A promotion is a standing discount
   * off the rate the pricing engine pushed, so the mix here decides how much of the
   * pushed rate is actually collected.
   */
  promoMix: RateMixRow[];
  /** Channel mix, the third lever on ADR. */
  channelMix: RateMixRow[];
  mixMonthly: RateMixMonthPoint[];
  channels: string[];
  leadAdr: LeadAdrRow[];
  /** The far-out premium the pricing engine is configured to charge. */
  configuredFarOutPremium: { nearDays: number; farDays: number; premium: number };
  /** What the data says the far-out premium actually is, same two horizons. */
  achievedFarOutPremium: number | null;
  /** Genius penetration and what it costs, when the sample allows it. */
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
  /** Length-of-stay mix, since it moves ADR as much as any rate plan. */
  losMix: { label: string; bookings: number; nights: number; adr: number; nightShare: number }[];
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

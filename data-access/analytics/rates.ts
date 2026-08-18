/**
 * Rates — what the ADR is actually made of.
 *
 * WHY THIS SECTION EXISTS
 * -----------------------
 * ADR is an outcome, not a decision. It moves when the MIX moves: a heavier
 * Booking.com share, more nights arriving on a Last Minute Deal, more one-night
 * stays. "ADR fell 6%" and "ADR fell 6% because promotional nights went from 70% to
 * 85% of the book" are different problems with different fixes, and only the second
 * one can be acted on.
 *
 * The pricing engine pushes a rate; the channel then discounts it. Beds24 records
 * what actually happened in its rate description, per night, including which
 * promotion rewrote the price and whether Genius applied. Parsing that is the only
 * way to see the gap between the rate we set and the rate we collected.
 *
 * THE FAR-OUT TEST
 * ----------------
 * PriceLabs is configured to charge a premium for booking far ahead
 * (`CONFIGURED_FAR_OUT_PREMIUM`). `leadAdr` measures whether that premium is
 * landing: achieved ADR by how far ahead the night was bought, on a stay basis, with
 * the cancellation rate of each bucket beside it. A far-out bucket that achieves
 * LESS per night than the near-in one means the premium is being avoided rather than
 * paid — and long-lead bookings cancel far more often, so the risk-adjusted column
 * is the one to read.
 */
import { sql } from 'drizzle-orm';
import { CONFIGURED_FAR_OUT_PREMIUM } from '@/data/analyticsConfig';
import type { LeadAdrRow, RateMixMonthPoint, RateMixRow, RatesResponse } from '@/utils/analyticsTypes';
import {
  baseCtes,
  LEAD_BUCKETS,
  leadBucketCase,
  losBucketCase,
  LOS_BUCKETS,
  n,
  nightsInScope,
  query,
  ratio,
} from './shared';
import type { AnalyticsScope } from './shared';

/**
 * The minimum bookings either side of a comparison before a delta is reported.
 *
 * Genius covers ~89% of Booking.com bookings, so the non-Genius group is a handful
 * of rows. An ADR gap computed off seven bookings is noise wearing a percentage
 * sign; below this floor the response says so and withholds the number.
 */
const MIN_COMPARISON_BOOKINGS = 15;

// ── Rate-plan and promotion parsing ──────────────────────────────────────────
//
// Beds24 packs the rate story into `rateDescription` as one line per night:
//
//   2026-08-10 (66698026 Flexible Urban 1KK rewritten from  Early Booker Deal) CZK 2149.16 genius
//
// Only the FIRST line is parsed. Every night of a booking carries the same plan and
// promotion, and matching across the whole blob lets a greedy pattern run past a
// newline and swallow the rest of the stay — which it did, before this was split.

/** The first night line, isolated from the rest of the description. */
const FIRST_LINE = sql`split_part(COALESCE(alloc.rate_description, ''), chr(10), 1)`;

/**
 * The promotion that rewrote the price, normalised into families.
 *
 * The raw names are operator-authored and drift ("Last Minute Deal", "Last Minute
 * Deal K201", "Last Minute Deal(10%", "Last Minute Deal deal - 3 dny predem"), so
 * they are grouped by intent. Mobile rates are matched before the generic deal
 * branch because "Mobile(App) Rate" contains a bracket that a simpler pattern cuts
 * in half.
 */
const PROMO_FAMILY = sql`
  CASE
    WHEN ${FIRST_LINE} ILIKE '%super last minute%'  THEN 'Super Last Minute'
    WHEN ${FIRST_LINE} ILIKE '%last minute%'        THEN 'Last Minute Deal'
    WHEN ${FIRST_LINE} ILIKE '%early booker%'       THEN 'Early Booker Deal'
    WHEN ${FIRST_LINE} ILIKE '%mobile%'             THEN 'Mobile app rate'
    WHEN ${FIRST_LINE} ILIKE '%limited time%'       THEN 'Limited Time Deal'
    WHEN ${FIRST_LINE} ~* 'rewritten from'          THEN 'Other promotion'
    ELSE 'No promotion'
  END
`;

/** The rate plan the booking sat on, before any promotion rewrote it. */
const PLAN_FAMILY = sql`
  CASE
    WHEN ${FIRST_LINE} ILIKE '%non-refundable%' OR ${FIRST_LINE} ILIKE '%non refundable%'
      OR alloc.rate_type = 'Non-Refundable'                    THEN 'Non-refundable'
    WHEN ${FIRST_LINE} ILIKE '%one night%' OR alloc.rate_type = 'One-Night' THEN 'One-night rate'
    WHEN ${FIRST_LINE} ILIKE '%weekly%'    OR alloc.rate_type = 'Weekly'    THEN 'Weekly rate'
    WHEN ${FIRST_LINE} ILIKE '%flexible%' OR ${FIRST_LINE} ILIKE '%flexi%'
      OR alloc.rate_type = 'Flexi'                             THEN 'Flexible'
    WHEN ${FIRST_LINE} ILIKE '%standard%'  OR alloc.rate_type = 'Standard'  THEN 'Standard'
    ELSE 'Unspecified'
  END
`;

/** Booking.com's Genius discount leaves a marker on every night it applied to. */
const IS_GENIUS = sql`(COALESCE(alloc.rate_description, '') ILIKE '%genius%')`;

/**
 * Mix rows are computed on the NIGHT grain but need booking-level averages
 * (length of stay, lead time) that must not be weighted by nights — a 7-night
 * booking would otherwise count seven times in "average length of stay". So the
 * per-booking facts are aggregated once, per booking, and joined back.
 */
function mixCte(scope: AnalyticsScope, dimension: 'plan' | 'promo' | 'channel'): SQLDimension {
  const label =
    dimension === 'plan' ? PLAN_FAMILY : dimension === 'promo' ? PROMO_FAMILY : sql`alloc.channel`;
  const channel = dimension === 'channel' ? sql`'All'::text` : sql`alloc.channel`;
  return { label, channel };
}

interface SQLDimension {
  label: ReturnType<typeof sql>;
  channel: ReturnType<typeof sql>;
}

interface MixRow {
  label: string;
  channel: string;
  bookings: number;
  nights: number;
  gbv: number;
  avg_los: number;
  avg_lead: number;
  cancelled: number;
  total_bookings: number;
}

async function readMix(
  scope: AnalyticsScope,
  dimension: 'plan' | 'promo' | 'channel',
): Promise<MixRow[]> {
  const { label, channel } = mixCte(scope, dimension);
  return query<MixRow>(sql`
    ${baseCtes(scope)},
    /* One row per booking that has at least one night in the window, carrying the
       dimension label plus the booking-level facts that must not be night-weighted. */
    booking_grain AS (
      SELECT DISTINCT
        alloc.reservation_number,
        ${label}                   AS label,
        ${channel}                 AS channel,
        alloc.span_nights          AS los,
        (alloc.check_in_date - alloc.reservation_date) AS lead_days,
        alloc.is_cancelled,
        alloc.cancel_class
      FROM alloc
      WHERE alloc.is_blackout = false
        AND alloc.span_nights > 0
        AND alloc.check_in_date <= ${scope.to}::date
        AND alloc.check_out_date > ${scope.from}::date
    ),
    night_grain AS (
      SELECT
        ${label}                                      AS label,
        ${channel}                                    AS channel,
        COUNT(*)::int                                 AS nights,
        COALESCE(SUM(nights.night_price), 0)::float8  AS gbv
      FROM nights
      JOIN alloc ON alloc.reservation_number = nights.reservation_number
                AND alloc.room = nights.room
      WHERE ${nightsInScope(scope)}
      GROUP BY 1, 2
    ),
    booked AS (
      SELECT
        label,
        channel,
        COUNT(*) FILTER (WHERE is_cancelled = false)::int                    AS bookings,
        COUNT(*) FILTER (WHERE cancel_class = 'guest')::int                  AS cancelled,
        /* Guest cancellations plus live bookings — abandoned checkouts are excluded
           from BOTH sides so this rate matches every other section's. */
        COUNT(*) FILTER (WHERE is_cancelled = false OR cancel_class = 'guest')::int AS total_bookings,
        AVG(los) FILTER (WHERE is_cancelled = false)::float8                 AS avg_los,
        AVG(lead_days) FILTER (WHERE is_cancelled = false)::float8           AS avg_lead
      FROM booking_grain
      GROUP BY 1, 2
    )
    SELECT
      COALESCE(g.label, b.label)      AS label,
      COALESCE(g.channel, b.channel)  AS channel,
      COALESCE(b.bookings, 0)         AS bookings,
      COALESCE(g.nights, 0)           AS nights,
      COALESCE(g.gbv, 0)              AS gbv,
      COALESCE(b.avg_los, 0)          AS avg_los,
      COALESCE(b.avg_lead, 0)         AS avg_lead,
      COALESCE(b.cancelled, 0)        AS cancelled,
      COALESCE(b.total_bookings, 0)   AS total_bookings
    FROM night_grain g
    FULL OUTER JOIN booked b ON b.label = g.label AND b.channel = g.channel
    ORDER BY 5 DESC
  `);
}

function toMixRows(rows: MixRow[], portfolioAdr: number, totalNights: number): RateMixRow[] {
  return rows
    .filter((r) => n(r.nights) > 0)
    .map<RateMixRow>((r) => {
      const nights = n(r.nights);
      const gbv = n(r.gbv);
      const adr = ratio(gbv, nights);
      return {
        label: r.label ?? 'Unspecified',
        channel: r.channel ?? 'All',
        bookings: n(r.bookings),
        nights,
        gbv,
        adr,
        nightShare: ratio(nights, totalNights),
        adrIndex: portfolioAdr > 0 ? adr / portfolioAdr - 1 : 0,
        avgLengthOfStay: n(r.avg_los),
        avgLeadDays: n(r.avg_lead),
        cancellationRate: ratio(n(r.cancelled), n(r.total_bookings)),
      };
    });
}

// ── ADR by lead time: the far-out premium test ───────────────────────────────

interface LeadAdrQueryRow {
  label: string;
  nights: number;
  bookings: number;
  gbv: number;
  cancelled: number;
  total_bookings: number;
}

/**
 * Achieved ADR by lead time, on a STAY basis.
 *
 * Stay basis, not booked basis, on purpose: the question is what a night in this
 * window was worth depending on how early it was sold, and that requires the night
 * to be inside the window. Cancellation rates are computed on the booking grain from
 * the same lead bucket, so the risk adjustment lines up with the ADR beside it.
 */
async function readLeadAdr(scope: AnalyticsScope): Promise<LeadAdrQueryRow[]> {
  const leadOfNight = sql`(nights.check_in_date - nights.reservation_date)`;
  const leadOfBooking = sql`(alloc.check_in_date - alloc.reservation_date)`;
  return query<LeadAdrQueryRow>(sql`
    ${baseCtes(scope)},
    by_night AS (
      SELECT
        ${leadBucketCase(leadOfNight)}                AS label,
        COUNT(*)::int                                 AS nights,
        COALESCE(SUM(nights.night_price), 0)::float8  AS gbv
      FROM nights
      WHERE ${nightsInScope(scope)}
        AND nights.reservation_date IS NOT NULL
      GROUP BY 1
    ),
    by_booking AS (
      SELECT
        ${leadBucketCase(leadOfBooking)} AS label,
        COUNT(*) FILTER (WHERE alloc.is_cancelled = false)::int   AS bookings,
        COUNT(*) FILTER (WHERE alloc.cancel_class = 'guest')::int AS cancelled,
        COUNT(*) FILTER (
          WHERE alloc.is_cancelled = false OR alloc.cancel_class = 'guest'
        )::int                                                   AS total_bookings
      FROM alloc
      WHERE alloc.is_blackout = false
        AND alloc.span_nights > 0
        AND alloc.reservation_date IS NOT NULL
        AND alloc.check_in_date BETWEEN ${scope.from}::date AND ${scope.to}::date
      GROUP BY 1
    )
    SELECT
      COALESCE(nn.label, bb.label)  AS label,
      COALESCE(nn.nights, 0)        AS nights,
      COALESCE(bb.bookings, 0)      AS bookings,
      COALESCE(nn.gbv, 0)           AS gbv,
      COALESCE(bb.cancelled, 0)     AS cancelled,
      COALESCE(bb.total_bookings, 0) AS total_bookings
    FROM by_night nn
    FULL OUTER JOIN by_booking bb ON bb.label = nn.label
  `);
}

// ── Monthly mix, so an ADR move can be attributed ────────────────────────────

interface MixMonthRow {
  month: string;
  channel: string;
  nights: number;
  gbv: number;
}

async function readMixMonthly(scope: AnalyticsScope): Promise<MixMonthRow[]> {
  return query<MixMonthRow>(sql`
    ${baseCtes(scope)}
    SELECT
      to_char(nights.stay_date, 'YYYY-MM')          AS month,
      nights.channel                                AS channel,
      COUNT(*)::int                                 AS nights,
      COALESCE(SUM(nights.night_price), 0)::float8  AS gbv
    FROM nights
    WHERE ${nightsInScope(scope)}
    GROUP BY 1, 2
    ORDER BY 1, 2
  `);
}

// ── Genius ───────────────────────────────────────────────────────────────────

interface GeniusRow {
  is_genius: boolean;
  bookings: number;
  nights: number;
  gbv: number;
}

async function readGenius(scope: AnalyticsScope): Promise<GeniusRow[]> {
  return query<GeniusRow>(sql`
    ${baseCtes(scope)},
    tagged AS (
      SELECT DISTINCT
        alloc.reservation_number,
        ${IS_GENIUS} AS is_genius
      FROM alloc
      WHERE alloc.channel = 'Booking.com'
        AND alloc.is_cancelled = false
        AND alloc.is_blackout = false
    )
    SELECT
      t.is_genius,
      COUNT(DISTINCT t.reservation_number)::int      AS bookings,
      COUNT(nights.stay_date)::int                   AS nights,
      COALESCE(SUM(nights.night_price), 0)::float8   AS gbv
    FROM tagged t
    JOIN nights ON nights.reservation_number = t.reservation_number
    WHERE ${nightsInScope(scope)}
    GROUP BY 1
  `);
}

// ── Length of stay ───────────────────────────────────────────────────────────

interface LosRow {
  label: string;
  bookings: number;
  nights: number;
  gbv: number;
}

async function readLosMix(scope: AnalyticsScope): Promise<LosRow[]> {
  return query<LosRow>(sql`
    ${baseCtes(scope)}
    SELECT
      ${losBucketCase(sql`nights.span_nights`)}      AS label,
      COUNT(DISTINCT nights.reservation_number)::int AS bookings,
      COUNT(*)::int                                  AS nights,
      COALESCE(SUM(nights.night_price), 0)::float8   AS gbv
    FROM nights
    WHERE ${nightsInScope(scope)}
    GROUP BY 1
  `);
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function readRates(scope: AnalyticsScope): Promise<RatesResponse> {
  const [planRows, promoRows, channelRows, leadRows, monthRows, geniusRows, losRows] =
    await Promise.all([
      readMix(scope, 'plan'),
      readMix(scope, 'promo'),
      readMix(scope, 'channel'),
      readLeadAdr(scope),
      readMixMonthly(scope),
      readGenius(scope),
      readLosMix(scope),
    ]);

  const totalNights = channelRows.reduce((acc, r) => acc + n(r.nights), 0);
  const totalGbv = channelRows.reduce((acc, r) => acc + n(r.gbv), 0);
  const portfolioAdr = ratio(totalGbv, totalNights);

  // ── Lead-time ADR, ordered by the shared bucket list ──────────────────────
  const leadByLabel = new Map(leadRows.map((r) => [r.label, r]));
  const leadAdr: LeadAdrRow[] = LEAD_BUCKETS.map((bucket) => {
    const row = leadByLabel.get(bucket.label);
    const nights = n(row?.nights);
    const adr = ratio(n(row?.gbv), nights);
    const cancellationRate = ratio(n(row?.cancelled), n(row?.total_bookings));
    return {
      label: bucket.label,
      minDays: bucket.min,
      maxDays: bucket.max,
      nights,
      bookings: n(row?.bookings),
      adr,
      vsReference: null,
      nightShare: ratio(nights, totalNights),
      cancellationRate,
      riskAdjustedAdr: adr * (1 - cancellationRate),
    };
  });

  /**
   * The reference bucket is the one containing the configured NEAR horizon, so the
   * comparison answers the question the pricing engine was configured to answer
   * rather than an arbitrary one. Everything is then indexed against it.
   */
  const { nearDays, farDays, premium } = CONFIGURED_FAR_OUT_PREMIUM;
  const bucketContaining = (days: number): LeadAdrRow | undefined =>
    leadAdr.find((b) => days >= b.minDays && (b.maxDays === null || days <= b.maxDays));

  const reference = bucketContaining(nearDays);
  if (reference && reference.adr > 0) {
    for (const row of leadAdr) {
      row.vsReference = row.nights > 0 ? row.adr / reference.adr - 1 : null;
    }
  }

  const far = bucketContaining(farDays);
  const achievedFarOutPremium =
    reference && far && reference.adr > 0 && far.nights > 0 ? far.adr / reference.adr - 1 : null;

  // ── Monthly mix ───────────────────────────────────────────────────────────
  const channels = [...new Set(monthRows.map((r) => r.channel))].sort();
  const monthMap = new Map<string, MixMonthRow[]>();
  for (const row of monthRows) {
    const list = monthMap.get(row.month) ?? [];
    list.push(row);
    monthMap.set(row.month, list);
  }
  const mixMonthly: RateMixMonthPoint[] = [...monthMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, rows]) => {
      const nights = rows.reduce((acc, r) => acc + n(r.nights), 0);
      const gbv = rows.reduce((acc, r) => acc + n(r.gbv), 0);
      const shares: Record<string, number> = {};
      const adrByChannel: Record<string, number> = {};
      for (const channel of channels) {
        const row = rows.find((r) => r.channel === channel);
        shares[channel] = ratio(n(row?.nights), nights);
        adrByChannel[channel] = ratio(n(row?.gbv), n(row?.nights));
      }
      return { month, adr: ratio(gbv, nights), shares, adrByChannel };
    });

  // ── Genius ────────────────────────────────────────────────────────────────
  const geniusRow = geniusRows.find((r) => r.is_genius);
  const nonGeniusRow = geniusRows.find((r) => !r.is_genius);
  const geniusNights = n(geniusRow?.nights);
  const nonGeniusNights = n(nonGeniusRow?.nights);
  const bookingComNights = geniusNights + nonGeniusNights;
  const geniusAdr = ratio(n(geniusRow?.gbv), geniusNights);
  const nonGeniusAdr = ratio(n(nonGeniusRow?.gbv), nonGeniusNights);
  const comparable =
    n(geniusRow?.bookings) >= MIN_COMPARISON_BOOKINGS &&
    n(nonGeniusRow?.bookings) >= MIN_COMPARISON_BOOKINGS;

  const genius =
    bookingComNights > 0
      ? {
          geniusNights,
          totalBookingComNights: bookingComNights,
          geniusNightShare: ratio(geniusNights, bookingComNights),
          geniusAdr,
          nonGeniusAdr,
          adrDelta: comparable && nonGeniusAdr > 0 ? geniusAdr / nonGeniusAdr - 1 : null,
          comparable,
          minComparisonBookings: MIN_COMPARISON_BOOKINGS,
        }
      : null;

  // ── LOS mix, in bucket order ──────────────────────────────────────────────
  const losByLabel = new Map(losRows.map((r) => [r.label, r]));
  const losMix = LOS_BUCKETS.map((bucket) => {
    const row = losByLabel.get(bucket.label);
    const nights = n(row?.nights);
    return {
      label: bucket.label,
      bookings: n(row?.bookings),
      nights,
      adr: ratio(n(row?.gbv), nights),
      nightShare: ratio(nights, totalNights),
    };
  }).filter((r) => r.nights > 0);

  return {
    basis: 'stay',
    query: { from: scope.from, to: scope.to, rooms: scope.rooms, channels: scope.channels },
    adr: portfolioAdr,
    planMix: toMixRows(planRows, portfolioAdr, totalNights),
    promoMix: toMixRows(promoRows, portfolioAdr, totalNights),
    channelMix: toMixRows(channelRows, portfolioAdr, totalNights),
    mixMonthly,
    channels,
    leadAdr,
    configuredFarOutPremium: { nearDays, farDays, premium },
    achievedFarOutPremium,
    genius,
    losMix,
  };
}

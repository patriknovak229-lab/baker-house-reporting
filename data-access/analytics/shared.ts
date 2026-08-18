/**
 * Shared SQL foundation for the analytics section.
 *
 * WHY THIS FILE IS THE WHOLE DESIGN
 * ---------------------------------
 * Every analytics number in the app is derived from ONE definition of "a sold
 * room-night" and ONE definition of "an available room-night", both expressed
 * here as SQL fragments. The Performance tab computes the equivalent in the
 * browser (`getNightsInPeriod` × `reservationRevenue`); duplicating that logic
 * per-endpoint is how dashboards start disagreeing with each other, so it is
 * written once and composed.
 *
 * SOURCE OF TRUTH: `public.bookings_mirror` — the durable Postgres archive of
 * every booking the app has ever seen. Analytics deliberately NEVER calls
 * Beds24 and never reads `baker:beds24-bookings-cache`:
 *   - a Beds24 sync costs API credits and seconds, and the operational tabs
 *     already coalesce it behind a 90s guard we must not undermine;
 *   - the Redis cache only holds arrival ±1 year and a full sync wipes it, so
 *     it can never answer a question about the whole history of the business;
 *   - aggregation belongs next to the data. A month × room × channel roll-up is
 *     a few KB out of Postgres versus the full reservation array over the wire.
 *
 * CONSEQUENCE TO ACCEPT: the archive is only as fresh as the last sync that ran
 * with `WRITE_BOOKINGS_MIRROR=true`. `readAnalyticsMeta` surfaces that staleness
 * and the UI renders it as a banner rather than letting a stale chart pass for a
 * live one.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db';
import { ALL_ROOMS_BY_CATEGORY, roomToCategory } from '@/utils/roomCategory';
import {
  ABANDONED_CANCEL_MINUTES,
  ROOM_ONLINE_OVERRIDES,
  SELLABLE_UNITS,
  TEST_BOOKING_NAME_REGEX,
  TRANSIENT_LOS_MAX,
  type SellableUnit,
} from '@/data/analyticsConfig';

// ── Scope ────────────────────────────────────────────────────────────────────

export interface AnalyticsScope {
  /** Inclusive stay-window start, YYYY-MM-DD. */
  from: string;
  /** Inclusive stay-window end, YYYY-MM-DD. */
  to: string;
  /** Physical rooms; empty = all. */
  rooms: string[];
  /** Channels; empty = all. */
  channels: string[];
}

/** The 7 physical, sellable rooms, in canonical order. */
export const PHYSICAL_ROOMS: string[] = [...ALL_ROOMS_BY_CATEGORY];

const PHYSICAL_ROOM_SET = new Set(PHYSICAL_ROOMS);

/**
 * Is this room label a real physical room?
 *
 * The archive also contains virtual-room labels ("1KK Deluxe Studios") for
 * bookings Beds24 could not auto-allocate. They carry real revenue but sit in no
 * room, so they must be counted in portfolio totals and EXCLUDED from per-room
 * breakdowns — never silently folded into a physical room, which is exactly the
 * `?? "K.202"` bug that shipped once already.
 */
export function isPhysicalRoom(room: string): boolean {
  return PHYSICAL_ROOM_SET.has(room);
}

export function roomCategoryLabel(room: string): string {
  return roomToCategory(room) ?? 'Unallocated';
}

// ── Row helpers ──────────────────────────────────────────────────────────────

/** `db.execute` returns `{ rows }` on the neon-http driver. */
export async function query<T>(statement: SQL): Promise<T[]> {
  const result = (await db.execute(statement)) as unknown as { rows?: T[] };
  return result.rows ?? [];
}

/** Postgres `numeric` arrives as a string; `float8` as a number. Be tolerant. */
export function n(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** Safe ratio — 0 when the denominator is 0, never NaN or Infinity. */
export function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

// ── Filters ──────────────────────────────────────────────────────────────────
//
// Room/channel lists are bound as ONE delimited TEXT parameter and expanded
// with `string_to_array`. That keeps them true bound parameters (no
// interpolation, no injection surface) without depending on how the driver
// serialises a JS array into a Postgres `text[]`.
//
// The delimiter is ASCII Unit Separator (0x1F) — it cannot occur in a room or
// channel name, so no value can ever be split in half.

const LIST_DELIMITER = '\u001f';

function csvFilter(column: SQL, values: string[]): SQL {
  if (values.length === 0) return sql`true`;
  return sql`${column} = ANY (string_to_array(${values.join(LIST_DELIMITER)}, chr(31)))`;
}

export function roomFilter(column: SQL, scope: AnalyticsScope): SQL {
  return csvFilter(column, scope.rooms);
}

export function channelFilter(column: SQL, scope: AnalyticsScope): SQL {
  return csvFilter(column, scope.channels);
}

// ── The core CTEs ────────────────────────────────────────────────────────────

/**
 * Excludes development test bookings from every figure.
 *
 * Applied in `alloc`, i.e. once, at the root of the CTE stack — so no endpoint
 * can forget it. `readAnalyticsMeta` reports how many rows this removes, because
 * a silent filter on a revenue number is worse than no filter at all.
 */
export const TEST_BOOKING_PREDICATE: SQL = TEST_BOOKING_NAME_REGEX
  ? sql`NOT (
      lower(trim(b.first_name)) ~* ${TEST_BOOKING_NAME_REGEX}
      OR lower(trim(b.last_name)) ~* ${TEST_BOOKING_NAME_REGEX}
    )`
  : sql`true`;

/**
 * `stripe_fees` — Stripe processing fees per reservation.
 *
 * The archive stores `payment_charge_amount` as Beds24 reported it, which is 0
 * for every OTA booking: Beds24 folds Booking.com's payment charge into the
 * single top-level `commission` total (deliberate — see
 * `parseCommissionBreakdown` in `utils/beds24Reservations.ts`). Direct bookings
 * paid through Stripe carry their real fee only in `additional_payments`, and
 * `/api/bookings` rolls it in at READ time, which is exactly why the mirror
 * cannot hold it: a Stripe webhook can change the fee with no bookings sync in
 * between, so a mirrored copy would go stale.
 *
 * Reproducing that roll-up here is what keeps the analytics "payment fees" line
 * equal to the one on the Performance tab. Refunded payments still count: Stripe
 * keeps the processing fee on a refund.
 */
export const STRIPE_FEES_CTE = sql`
  stripe_fees AS (
    SELECT
      reservation_number,
      SUM(stripe_fee_czk::numeric) AS fee
    FROM additional_payments
    WHERE stripe_fee_czk IS NOT NULL
      AND status IN ('paid', 'partially-refunded', 'refunded')
    GROUP BY reservation_number
  )
`;

/**
 * `alloc` — one row per (booking × physical room it occupies), with money split
 * evenly across linked rooms.
 *
 * This mirrors `utils/expandReservations.ts` exactly (price / N per room) so a
 * "K.202 + K.203" package contributes half its value to each room here and in
 * the Performance tab. The difference: that util rounds each share to whole Kč,
 * this keeps full precision and only rounds at presentation — a 3-room package
 * split three ways cannot lose a koruna to rounding in the totals.
 *
 * Cancelled and blackout rows are KEPT (with their flags) because several
 * questions are about them; every caller filters explicitly.
 */
export const ALLOC_CTE = sql`
  alloc AS (
    SELECT
      b.reservation_number,
      b.channel,
      b.rate_type,
      b.nationality,
      b.check_in_date,
      b.check_out_date,
      b.reservation_date,
      b.booking_timestamp,
      b.number_of_guests,
      b.is_cancelled,
      b.is_blackout,
      b.is_unallocated_vr,
      b.synced_rating,
      (b.raw ->> 'cancelTime')::timestamptz              AS cancelled_at,
      (b.raw ->> 'rateDescription')                      AS rate_description,
      /* Abandoned checkout vs genuine guest cancellation — see
         ABANDONED_CANCEL_MINUTES in data/analyticsConfig.ts. */
      CASE
        WHEN b.is_cancelled = false THEN NULL
        WHEN (b.raw ->> 'cancelTime') IS NULL OR b.booking_timestamp IS NULL THEN 'guest'
        WHEN (b.raw ->> 'cancelTime')::timestamptz - b.booking_timestamp
             < (${ABANDONED_CANCEL_MINUTES} || ' minutes')::interval THEN 'abandoned'
        ELSE 'guest'
      END                                                AS cancel_class,
      r.room,
      r.share,
      /* Nights from the DATE SPAN, not number_of_nights: the span is what the
         calendar actually blocks, and it is what generate_series expands below.
         A row where they disagree is a Beds24 oddity, and occupancy must follow
         the calendar. */
      GREATEST((b.check_out_date - b.check_in_date), 0)   AS span_nights,
      (b.price::numeric)             * r.share           AS price,
      (b.commission_amount::numeric) * r.share           AS commission,
      ((b.payment_charge_amount::numeric) + COALESCE(sf.fee, 0)) * r.share AS fee
    FROM bookings_mirror b
    LEFT JOIN stripe_fees sf ON sf.reservation_number = b.reservation_number
    CROSS JOIN LATERAL (
      /* Package booking → one row per linked room, each carrying 1/N. */
      SELECT u.room, 1.0::numeric / cardinality(b.linked_rooms) AS share
      FROM unnest(b.linked_rooms) AS u(room)
      WHERE b.linked_rooms IS NOT NULL AND cardinality(b.linked_rooms) > 1
      UNION ALL
      /* Single-room booking (incl. unallocated virtual rooms) → itself. */
      SELECT b.room, 1.0::numeric
      WHERE b.linked_rooms IS NULL OR cardinality(b.linked_rooms) <= 1
    ) r
    WHERE b.source = 'beds24-booking'
      AND b.check_in_date IS NOT NULL
      AND b.check_out_date IS NOT NULL
      AND ${TEST_BOOKING_PREDICATE}
  )
`;


/**
 * `nights` — one row per sold room-night: the grain every occupancy, ADR and
 * RevPAR figure is computed on.
 *
 * Money is spread evenly across the nights of the stay, so a stay straddling a
 * month boundary contributes to both months in proportion — identical to the
 * `nights / numberOfNights` fraction the Performance tab applies, but resolved
 * per night instead of per period, which makes any window (month, week,
 * weekday, single event) fall out of the same GROUP BY.
 *
 * EXCLUDES cancellations and blackouts: neither is a sold night. Non-arrivals
 * are a deliberate known gap — see the note in `readAnalyticsMeta`.
 */
export const NIGHTS_CTE = sql`
  nights AS (
    SELECT
      a.reservation_number,
      a.channel,
      a.room,
      a.rate_type,
      a.nationality,
      a.check_in_date,
      a.check_out_date,
      a.reservation_date,
      a.booking_timestamp,
      a.number_of_guests,
      a.span_nights,
      a.synced_rating,
      d::date                                     AS stay_date,
      a.price      / a.span_nights                AS night_price,
      a.commission / a.span_nights                AS night_commission,
      a.fee        / a.span_nights                AS night_fee,
      (a.check_in_date - a.reservation_date)      AS lead_days
    FROM alloc a
    CROSS JOIN generate_series(
      a.check_in_date,
      a.check_out_date - INTERVAL '1 day',
      INTERVAL '1 day'
    ) AS d
    WHERE a.is_cancelled = false
      AND a.is_blackout  = false
      AND a.span_nights  > 0
  )
`;

/**
 * `blackout_nights` — room-nights the operator deliberately closed.
 *
 * Subtracted from availability rather than counted as unsold: a room blocked for
 * a repair was never on sale, and leaving it in the denominator quietly punishes
 * occupancy for a maintenance decision.
 */
export const BLACKOUT_NIGHTS_CTE = sql`
  blackout_nights AS (
    SELECT a.room, d::date AS stay_date
    FROM alloc a
    CROSS JOIN generate_series(
      a.check_in_date,
      a.check_out_date - INTERVAL '1 day',
      INTERVAL '1 day'
    ) AS d
    WHERE a.is_blackout = true
      AND a.span_nights > 0
  )
`;

/**
 * `room_online` — the first date each room could actually be sold.
 *
 * This matters more than it looks. The portfolio opened in stages: the Deluxe
 * twins traded from February 2026, K.201 from March, the three Urban studios
 * only from late May, O.308 from mid-June. A flat `rooms × days` denominator —
 * what the Performance tab uses — therefore reports February occupancy against
 * four rooms that did not exist, understating it by more than half.
 *
 * Derived as the earliest evidence of the room existing (first booking or
 * blackout), with `data/analyticsConfig.ts` able to override any room whose real
 * opening date preceded its first booking.
 */
export const ROOM_ONLINE_CTE = (() => {
  const overrides = Object.entries(ROOM_ONLINE_OVERRIDES);
  // An empty VALUES list is a syntax error, so fall back to a never-matching
  // shape when the operator has configured no overrides (the default).
  const overrideRows: SQL =
    overrides.length > 0
      ? sql`VALUES ${sql.join(
          overrides.map(([room, date]) => sql`(${room}::text, ${date}::date)`),
          sql`, `,
        )}`
      : sql`SELECT NULL::text, NULL::date WHERE false`;

  return sql`
    room_online AS (
      SELECT
        o.room,
        COALESCE(ov.online_date, o.first_seen) AS online_date
      FROM (
        SELECT a.room, MIN(a.check_in_date) AS first_seen
        FROM alloc a
        GROUP BY a.room
      ) o
      LEFT JOIN (SELECT * FROM (${overrideRows}) AS v(room, online_date)) ov
        ON ov.room = o.room
    )
  `;
})();

/**
 * `room_days` — the availability denominator: one row per (physical room ×
 * calendar day) inside the window, from the day that room came online.
 *
 * Only physical rooms appear here. Virtual-room labels are not inventory.
 */
export function roomDaysCte(scope: AnalyticsScope): SQL {
  return sql`
    room_days AS (
      SELECT r.room, d::date AS stay_date
      FROM (
        SELECT * FROM (VALUES ${sql.join(
          PHYSICAL_ROOMS.map((room) => sql`(${room}::text)`),
          sql`, `,
        )}) AS v(room)
      ) r
      CROSS JOIN generate_series(${scope.from}::date, ${scope.to}::date, INTERVAL '1 day') AS d
      LEFT JOIN room_online o ON o.room = r.room
      WHERE ${roomFilter(sql`r.room`, scope)}
        AND (o.online_date IS NULL OR d::date >= o.online_date)
    )
  `;
}

/**
 * `available` — room-days minus blackouts, per (room, day).
 *
 * A blackout only removes the specific room-night it covers, so a room blocked
 * for two nights in a 30-day month still contributes 28 available nights.
 */
export const AVAILABLE_CTE = sql`
  available AS (
    SELECT rd.room, rd.stay_date
    FROM room_days rd
    WHERE NOT EXISTS (
      SELECT 1 FROM blackout_nights b
      WHERE b.room = rd.room AND b.stay_date = rd.stay_date
    )
  )
`;

/**
 * `asof_nights` — every room-night ever booked, INCLUDING nights whose booking
 * was later cancelled, tagged with when it was booked and when (if ever) it was
 * cancelled.
 *
 * This is what makes a real booking curve possible without storing daily
 * snapshots. Because the archive keeps `reservation_date` and Beds24's
 * `cancelTime`, the state of the book at any past instant is reconstructable:
 *
 *     booked_on <= AS_OF AND (cancelled_at IS NULL OR cancelled_at > AS_OF)
 *
 * KNOWN LIMIT — the one thing reconstruction cannot recover: a booking that was
 * MODIFIED (dates moved, price changed) is only stored in its final shape, so it
 * is replayed as if it had always looked that way. Cancellations are exact;
 * modifications are approximated. A nightly on-the-books snapshot table would
 * close that gap, and is the natural Phase 2 if the curve ever needs to be
 * audit-grade rather than decision-grade.
 */
export const ASOF_NIGHTS_CTE = sql`
  asof_nights AS (
    SELECT
      a.reservation_number,
      a.channel,
      a.room,
      a.reservation_date       AS booked_on,
      a.cancelled_at,
      a.is_cancelled,
      d::date                  AS stay_date,
      a.price / a.span_nights  AS night_price
    FROM alloc a
    CROSS JOIN generate_series(
      a.check_in_date,
      a.check_out_date - INTERVAL '1 day',
      INTERVAL '1 day'
    ) AS d
    WHERE a.is_blackout = false
      AND a.span_nights > 0
      AND a.reservation_date IS NOT NULL
  )
`;

/** The full stack, in dependency order. Every query starts with this. */
export function baseCtes(scope: AnalyticsScope): SQL {
  return sql`
    WITH ${STRIPE_FEES_CTE},
    ${ALLOC_CTE},
    ${NIGHTS_CTE},
    ${BLACKOUT_NIGHTS_CTE},
    ${ROOM_ONLINE_CTE},
    ${roomDaysCte(scope)},
    ${AVAILABLE_CTE},
    ${ASOF_NIGHTS_CTE}
  `;
}

/** Stay-window + room + channel predicate for the `nights` CTE. */
export function nightsInScope(scope: AnalyticsScope): SQL {
  return sql`
    nights.stay_date BETWEEN ${scope.from}::date AND ${scope.to}::date
    AND ${roomFilter(sql`nights.room`, scope)}
    AND ${channelFilter(sql`nights.channel`, scope)}
  `;
}

// ── Bucketing helpers shared by several endpoints ────────────────────────────

/** Lead-time buckets, in ascending order. Chosen to straddle the observed
 *  median (about a week) so the last-minute mass is not collapsed into one bar. */
export const LEAD_BUCKETS: { label: string; min: number; max: number | null }[] = [
  { label: 'Same day', min: 0, max: 0 },
  { label: '1–3 days', min: 1, max: 3 },
  { label: '4–7 days', min: 4, max: 7 },
  { label: '8–14 days', min: 8, max: 14 },
  { label: '15–30 days', min: 15, max: 30 },
  { label: '31–60 days', min: 31, max: 60 },
  { label: '61–90 days', min: 61, max: 90 },
  { label: '90+ days', min: 91, max: null },
];

/** SQL CASE that maps a day count to a `LEAD_BUCKETS` label. */
export function leadBucketCase(expr: SQL): SQL {
  const branches = LEAD_BUCKETS.map((b) =>
    b.max === null
      ? sql`WHEN ${expr} >= ${b.min} THEN ${b.label}`
      : sql`WHEN ${expr} BETWEEN ${b.min} AND ${b.max} THEN ${b.label}`,
  );
  return sql`CASE ${sql.join(branches, sql` `)} ELSE 'Unknown' END`;
}

/** Length-of-stay buckets — 1 and 2 nights kept separate because their unit
 *  economics differ sharply (one cleaning fee either way). */
export const LOS_BUCKETS: { label: string; min: number; max: number | null }[] = [
  { label: '1 night', min: 1, max: 1 },
  { label: '2 nights', min: 2, max: 2 },
  { label: '3 nights', min: 3, max: 3 },
  { label: '4–6 nights', min: 4, max: 6 },
  { label: '7+ nights', min: 7, max: null },
];

export function losBucketCase(expr: SQL): SQL {
  const branches = LOS_BUCKETS.map((b) =>
    b.max === null
      ? sql`WHEN ${expr} >= ${b.min} THEN ${b.label}`
      : sql`WHEN ${expr} BETWEEN ${b.min} AND ${b.max} THEN ${b.label}`,
  );
  return sql`CASE ${sql.join(branches, sql` `)} ELSE 'Unknown' END`;
}

export const ISO_DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Normalise a synced rating (Booking /10, Airbnb /5) onto a common 0–10 scale
 *  so a portfolio average is meaningful across channels. */
export const REVIEW_SCORE_10 = sql`
  CASE
    WHEN nights.synced_rating IS NULL THEN NULL
    WHEN (nights.synced_rating ->> 'scale') = '5'
      THEN (nights.synced_rating ->> 'score')::numeric * 2
    ELSE (nights.synced_rating ->> 'score')::numeric
  END
`;

// ── Sellable units (room groups) ─────────────────────────────────────────────

/**
 * SQL CASE mapping a physical-room column to its sellable-unit id.
 *
 * Written as an expression rather than a join table so it can be dropped into any
 * GROUP BY without changing the CTE stack. Rooms that belong to no configured unit
 * (a virtual-room label, or a room added to Beds24 before it is added here) fall
 * through to 'other', which callers filter out explicitly — the alternative is
 * silently folding unknown inventory into a real unit, which is the same class of
 * bug as the old room fallback.
 */
export function unitIdOf(roomColumn: SQL): SQL {
  const branches = SELLABLE_UNITS.map(
    (u) =>
      sql`WHEN ${roomColumn} = ANY (string_to_array(${u.rooms.join(LIST_DELIMITER)}, chr(31))) THEN ${u.id}`,
  );
  return sql`CASE ${sql.join(branches, sql` `)} ELSE 'other' END`;
}

const UNIT_BY_ID = new Map(SELLABLE_UNITS.map((u) => [u.id, u]));
const UNIT_BY_ROOM = new Map(SELLABLE_UNITS.flatMap((u) => u.rooms.map((r) => [r, u] as const)));

export function unitForRoom(room: string): SellableUnit | null {
  return UNIT_BY_ROOM.get(room) ?? null;
}

export function unitById(id: string): SellableUnit | null {
  return UNIT_BY_ID.get(id) ?? null;
}

/**
 * The units that survive the current room filter.
 *
 * A unit is in scope when at least one of its rooms is. Its capacity still comes
 * from the `available` CTE, which is already room-filtered — so filtering to a
 * single Urban room correctly shows the Urban unit with a capacity of one, not
 * three.
 */
export function unitsInScope(scope: AnalyticsScope): SellableUnit[] {
  if (scope.rooms.length === 0) return SELLABLE_UNITS;
  const wanted = new Set(scope.rooms);
  return SELLABLE_UNITS.filter((u) => u.rooms.some((r) => wanted.has(r)));
}

// ── Transient demand ─────────────────────────────────────────────────────────

/**
 * `long_nights` — room-nights consumed by stays longer than TRANSIENT_LOS_MAX.
 *
 * Used two ways, and both matter:
 *   - removed from the sold side, because their nightly rate was set once by a
 *     long-stay negotiation and says nothing about that weekday's value;
 *   - removed from the AVAILABLE side, because a room already committed to a
 *     month-long guest was never on sale to a Friday transient booker. Leaving it
 *     in the denominator would report unsellable inventory as unsold.
 */
export const LONG_NIGHTS_CTE = sql`
  long_nights AS (
    SELECT nights.room, nights.stay_date
    FROM nights
    WHERE nights.span_nights > ${TRANSIENT_LOS_MAX}
  )
`;

/** `transient_available` — capacity that was genuinely on sale to short stays. */
export const TRANSIENT_AVAILABLE_CTE = sql`
  transient_available AS (
    SELECT a.room, a.stay_date
    FROM available a
    WHERE NOT EXISTS (
      SELECT 1 FROM long_nights l
      WHERE l.room = a.room AND l.stay_date = a.stay_date
    )
  )
`;

/** Predicate selecting only transient sold nights out of the `nights` CTE. */
export const TRANSIENT_NIGHTS: SQL = sql`nights.span_nights <= ${TRANSIENT_LOS_MAX}`;

/** The base stack plus the transient overlay. */
export function transientCtes(scope: AnalyticsScope): SQL {
  return sql`
    ${baseCtes(scope)},
    ${LONG_NIGHTS_CTE},
    ${TRANSIENT_AVAILABLE_CTE}
  `;
}

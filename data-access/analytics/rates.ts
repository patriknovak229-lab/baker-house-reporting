/**
 * Rates — gross profit by rate plan, promotion and channel, and what became of
 * the nights that cancelled. Per room class (1KK / 2KK).
 *
 * This file is plumbing only: three reads off the shared CTE stack plus the
 * turnover cost per checkout from the variable-cost engine, handed to the pure
 * engine in `utils/ratesAnalysis.ts`, where every rule lives and is tested. The
 * questions the tab answers, and why each is asked in gross profit rather than
 * ADR, are written up there and in docs/analytics.md.
 *
 * WHY THE ROWS ARE PULLED RAW RATHER THAN AGGREGATED IN SQL
 * --------------------------------------------------------
 * Every other tab aggregates in Postgres, and this one used to. It stopped
 * because the questions now need things SQL is a poor place for: the rate plan
 * has to be recovered from a rate id learned across the whole archive, a
 * cancelled booking's value has to be read back out of its description, and a
 * cancelled night is matched to the booking that resold it. The rows are small —
 * a few thousand nights and well under a thousand bookings — and they still come
 * out of the ONE definition of a night in `shared.ts`, so nothing here can drift
 * from the other tabs.
 */
import { sql } from 'drizzle-orm';
import { CONFIGURED_FAR_OUT_PREMIUM, TURNOVER_COST_KEYS } from '@/data/analyticsConfig';
import type { RatesResponse } from '@/utils/analyticsTypes';
import { buildRatesResponse, type RateBookingInput, type RateNightInput } from '@/utils/ratesAnalysis';
import { originalNightly } from '@/utils/rateDescription';
import { ROOM_TO_BEDS24_ID } from '@/utils/variableCostsShared';
import { computeVariableCosts } from '@/utils/variableCostsEngine';
import {
  baseCtes,
  LEAD_BUCKETS,
  LOS_BUCKETS,
  n,
  query,
  roomFilter,
  type AnalyticsScope,
} from './shared';

const BEDS24_TO_ROOM: Record<string, string> = Object.fromEntries(
  Object.entries(ROOM_TO_BEDS24_ID).map(([room, id]) => [id, room]),
);

interface NightRow {
  reservation_number: string;
  room: string;
  channel: string;
  stay_date: string;
  price: number;
  commission: number;
  fee: number;
}

/**
 * Sold nights in the window, room-filtered but NOT channel-filtered: whether a
 * cancelled Booking.com night was resold does not depend on which channel
 * resold it, so the engine applies the channel filter itself, after resale.
 */
async function readNights(scope: AnalyticsScope): Promise<RateNightInput[]> {
  const rows = await query<NightRow>(sql`
    ${baseCtes(scope)}
    SELECT
      nights.reservation_number,
      nights.room,
      nights.channel,
      nights.stay_date::text               AS stay_date,
      nights.night_price::float8           AS price,
      nights.night_commission::float8      AS commission,
      nights.night_fee::float8             AS fee
    FROM nights
    WHERE nights.stay_date BETWEEN ${scope.from}::date AND ${scope.to}::date
      AND ${roomFilter(sql`nights.room`, scope)}
  `);
  return rows.map((r) => ({
    reservationNumber: r.reservation_number,
    room: r.room,
    channel: r.channel,
    stayDate: r.stay_date,
    price: n(r.price),
    commission: n(r.commission),
    fee: n(r.fee),
  }));
}

interface BookingRow {
  reservation_number: string;
  source: string;
  channel: string;
  room: string;
  rate_type: string | null;
  rate_line: string | null;
  /** Beds24 booking group (master id, else own id) — Airbnb repeats a group's total on every room. */
  group_key: string | null;
  /** Full description, cancelled rows only — their value has to be read back from it. */
  cancelled_description: string | null;
  share: number;
  check_in: string;
  check_out: string;
  span_nights: number;
  reservation_date: string | null;
  booked_at: string | null;
  cancelled_at: string | null;
  is_cancelled: boolean;
  cancel_class: 'guest' | 'abandoned' | null;
  price: number;
  commission: number;
  fee: number;
}

/**
 * Every booking × room in the archive, live and cancelled.
 *
 * The WHOLE archive, not the window: a Booking.com line sometimes carries only
 * a rate id ("65571709 rewritten from Early Booker Deal"), and the plan behind
 * that id is learned from other bookings that name it. The cancellation instant
 * follows `asof_nights`: a cancelled row with no cancelTime is dated by its
 * booking time if abandoned, else by its last modification.
 */
async function readBookings(scope: AnalyticsScope): Promise<RateBookingInput[]> {
  const rows = await query<BookingRow>(sql`
    ${baseCtes(scope)}
    SELECT
      alloc.reservation_number,
      alloc.source,
      alloc.channel,
      alloc.room,
      alloc.rate_type,
      split_part(COALESCE(alloc.rate_description, ''), chr(10), 1)   AS rate_line,
      CASE WHEN alloc.is_cancelled THEN alloc.rate_description END   AS cancelled_description,
      (SELECT COALESCE(NULLIF(bm.raw ->> 'masterId', ''), bm.raw ->> 'id')
         FROM bookings_mirror bm
        WHERE bm.reservation_number = alloc.reservation_number)    AS group_key,
      alloc.share::float8                                           AS share,
      alloc.check_in_date::text                                     AS check_in,
      alloc.check_out_date::text                                    AS check_out,
      alloc.span_nights::int                                        AS span_nights,
      alloc.reservation_date::text                                  AS reservation_date,
      alloc.booking_timestamp::text                                 AS booked_at,
      (CASE
        WHEN alloc.is_cancelled = false OR alloc.cancelled_at IS NOT NULL THEN alloc.cancelled_at
        WHEN alloc.cancel_class = 'abandoned' THEN alloc.booking_timestamp
        ELSE COALESCE(alloc.modified_at, alloc.booking_timestamp)
      END)::text                                                    AS cancelled_at,
      alloc.is_cancelled,
      alloc.cancel_class,
      alloc.price::float8                                           AS price,
      alloc.commission::float8                                      AS commission,
      alloc.fee::float8                                             AS fee
    FROM alloc
    WHERE alloc.is_blackout = false
      AND alloc.span_nights > 0
  `);
  // Airbnb writes the WHOLE group's base price into every room's description,
  // so a two-room Airbnb booking would read as each room worth the pair.
  const airbnbGroupSize = new Map<string, number>();
  for (const r of rows) {
    if (r.channel !== 'Airbnb' || !r.is_cancelled || !r.group_key) continue;
    const key = `${r.group_key}|${r.cancelled_description ?? ''}`;
    airbnbGroupSize.set(key, (airbnbGroupSize.get(key) ?? 0) + 1);
  }

  return rows.map((r) => {
    const nightly = r.is_cancelled ? originalNightly(r.cancelled_description, n(r.span_nights)) : null;
    const groupSize =
      r.channel === 'Airbnb' && r.group_key
        ? (airbnbGroupSize.get(`${r.group_key}|${r.cancelled_description ?? ''}`) ?? 1)
        : 1;
    return {
      reservationNumber: r.reservation_number,
      source: r.source,
      channel: r.channel,
      room: r.room,
      rateType: r.rate_type,
      rateLine: (r.rate_line ?? '').replace(/\r$/, ''),
      originalNightly: nightly === null ? null : (nightly * n(r.share)) / groupSize,
      checkIn: r.check_in,
      checkOut: r.check_out,
      spanNights: n(r.span_nights),
      reservationDate: r.reservation_date,
      bookedAt: r.booked_at,
      cancelledAt: r.cancelled_at,
      isCancelled: r.is_cancelled,
      cancelClass: r.cancel_class,
      price: n(r.price),
      commission: n(r.commission),
      fee: n(r.fee),
    };
  });
}

/** Room-nights on sale in the window — the capacity resale and date strength are judged against. */
async function readAvailable(scope: AnalyticsScope): Promise<{ room: string; stayDate: string }[]> {
  const rows = await query<{ room: string; stay_date: string }>(sql`
    ${baseCtes(scope)}
    SELECT available.room, available.stay_date::text AS stay_date
    FROM available
  `);
  return rows.map((r) => ({ room: r.room, stayDate: r.stay_date }));
}

/**
 * Turnover cost per (checkout date, room) — cleaning + laundry + consumables,
 * the costs charged once per stay. Same cells and keys the Costs tab uses for
 * its per-booking contribution, so the two tabs agree on what a stay cost.
 */
async function readTurnover(): Promise<Map<string, number> | null> {
  const costs = await computeVariableCosts();
  if (!costs) return null;
  const out = new Map<string, number>();
  for (const [key, entry] of Object.entries(costs.byDateRoom)) {
    const [date, roomId] = key.split('|');
    const room = roomId ? BEDS24_TO_ROOM[roomId] : undefined;
    if (!date || !room) continue;
    const total = TURNOVER_COST_KEYS.reduce((acc, k) => acc + (entry[k] ?? 0), 0);
    if (total > 0) out.set(`${date}|${room}`, total);
  }
  return out;
}

export async function readRates(scope: AnalyticsScope, todayIso: string): Promise<RatesResponse> {
  const [nights, bookings, available, turnover] = await Promise.all([
    readNights(scope),
    readBookings(scope),
    readAvailable(scope),
    readTurnover().catch(() => null),
  ]);

  return buildRatesResponse({
    from: scope.from,
    to: scope.to,
    today: todayIso,
    rooms: scope.rooms,
    channels: scope.channels,
    query: { from: scope.from, to: scope.to, rooms: scope.rooms, channels: scope.channels },
    nights,
    bookings,
    available,
    turnoverByCheckout: turnover,
    leadBuckets: LEAD_BUCKETS,
    losBuckets: LOS_BUCKETS,
    farOut: CONFIGURED_FAR_OUT_PREMIUM,
  });
}

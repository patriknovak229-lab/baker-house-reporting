/**
 * Parity check for `bookings_mirror`: re-normalize from the raw Beds24 cache in
 * Redis and diff field-by-field against the mirrored rows.
 *
 *   npx tsx scripts/verify/bookings-mirror.ts
 *
 * This proves the WRITE path (projection == what the sync computed). It is not
 * the dual-read gate — that's a later step comparing a mirror-backed reservation
 * against the computed one at the consumer level.
 *
 * ARCHIVE SEMANTICS: the mirror is upsert-only and deliberately outlives the Redis
 * cache, so "in Postgres but not in the cache" is the FEATURE, not drift — those
 * rows are counted as `archivedBeyondCache`. Only the opposite direction (in the
 * cache but missing from Postgres) and genuine field differences are failures.
 *
 * Other expected non-zero cases, reported separately rather than as mismatches:
 *  - `cleaningStatus` is derived from today's date, so a row written on an
 *    earlier day legitimately differs (reported as `staleCleaningStatus`).
 *  - `raw` / `firstSeenAt` are archive bookkeeping, not projected data.
 *  - `inventory-override` rows come from a 5-min-TTL cache, so they're only
 *    compared when that cache is present.
 */
import '../_loadEnv';

import { Redis } from '@upstash/redis';
import { mergeGroupedBookings, mapToReservation, type Beds24Booking } from '../../utils/beds24Reservations';
import { toBookingsMirrorRow } from '../../utils/bookingsMirror';
import type { BookingsMirrorInsert } from '../../lib/db/schema/bookingsMirror';
import type { GuestRating, Reservation } from '../../types/reservation';

const BOOKINGS_CACHE_KEY = 'baker:beds24-bookings-cache';
const REVIEWS_CACHE_KEY = 'baker:beds24-reviews-cache';
const OVERRIDE_BLACKOUTS_CACHE_KEY = 'baker:override-blackouts-cache';

const isCancelledStatus = (b: Beds24Booking) => b.status === 'cancelled' || b.status === 'canceled';

/**
 * Key-order-independent JSON. Postgres `jsonb` does not preserve insertion
 * order, so `syncedRating` comes back with its keys reshuffled — comparing raw
 * JSON.stringify output would flag every review as drift.
 */
function canonical(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, walk(val)]),
      );
    }
    return v;
  };
  return JSON.stringify(walk(value) ?? null);
}

/** Compare a projected value against what came back out of Postgres. */
function same(expected: unknown, actual: unknown): boolean {
  if (expected instanceof Date || actual instanceof Date) {
    const e = expected instanceof Date ? expected.getTime() : null;
    const a = actual instanceof Date ? actual.getTime() : null;
    return e === a;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    return canonical(expected) === canonical(actual);
  }
  if (typeof expected === 'object' || typeof actual === 'object') {
    return canonical(expected) === canonical(actual);
  }
  // numeric columns round-trip as strings — compare numerically when both look numeric
  if (expected != null && actual != null && !Number.isNaN(Number(expected)) && !Number.isNaN(Number(actual))) {
    return Number(expected) === Number(actual);
  }
  return (expected ?? null) === (actual ?? null);
}

async function main() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });

  const [cacheRaw, reviewsRaw, blackoutsRaw] = await Promise.all([
    redis.get<Record<string, Beds24Booking>>(BOOKINGS_CACHE_KEY),
    redis.get<{ fetchedAt: number; byRef: Record<string, GuestRating> }>(REVIEWS_CACHE_KEY),
    redis.get<Reservation[]>(OVERRIDE_BLACKOUTS_CACHE_KEY),
  ]);

  const raw = Object.values(cacheRaw ?? {});
  const grouped = mergeGroupedBookings(raw.filter((b) => !isCancelledStatus(b)));
  const byRef = reviewsRaw?.byRef ?? {};
  const cancelledRaw = raw.filter(isCancelledStatus);

  const expected = new Map<string, BookingsMirrorInsert>();
  for (const b of grouped) {
    const base = mapToReservation(b);
    const rating = b.apiReference ? byRef[String(b.apiReference)] : undefined;
    const r = rating ? { ...base, syncedRating: rating } : base;
    expected.set(
      r.reservationNumber,
      toBookingsMirrorRow(r, {
        source: 'beds24-booking',
        apiReference: b.apiReference ? String(b.apiReference) : null,
      }),
    );
  }
  for (const b of cancelledRaw) {
    const r = mapToReservation(b);
    expected.set(
      r.reservationNumber,
      toBookingsMirrorRow(r, {
        source: 'beds24-booking',
        apiReference: b.apiReference ? String(b.apiReference) : null,
      }),
    );
  }

  const haveBlackoutCache = Array.isArray(blackoutsRaw);
  if (haveBlackoutCache) {
    for (const r of blackoutsRaw!) {
      expected.set(r.reservationNumber, toBookingsMirrorRow(r, { source: 'inventory-override' }));
    }
  }

  const { listBookingsMirrorPg } = await import('../../data-access/bookingsMirror');
  const rows = await listBookingsMirrorPg();
  const actual = new Map(rows.map((r) => [r.reservationNumber, r]));

  const mismatches: { reservationNumber: string; field: string; expected: unknown; actual: unknown }[] = [];
  const staleCleaningStatus: string[] = [];
  const missingInPg: string[] = [];
  const archivedBeyondCache: string[] = [];

  // Archive bookkeeping, not projected data — excluded from the field diff.
  const SKIP_FIELDS = new Set<keyof BookingsMirrorInsert>(['syncedAt', 'firstSeenAt', 'raw']);

  for (const [rn, exp] of expected) {
    const act = actual.get(rn);
    if (!act) {
      missingInPg.push(rn);
      continue;
    }
    for (const field of Object.keys(exp) as (keyof BookingsMirrorInsert)[]) {
      if (SKIP_FIELDS.has(field)) continue;
      if (same(exp[field], (act as Record<string, unknown>)[field])) continue;
      if (field === 'cleaningStatus') {
        staleCleaningStatus.push(rn);
        continue;
      }
      mismatches.push({ reservationNumber: rn, field: String(field), expected: exp[field], actual: (act as Record<string, unknown>)[field] });
    }
  }

  for (const rn of actual.keys()) {
    // Rows the cache no longer holds are the archive doing its job. Blackout rows
    // are only comparable at all when their short-TTL cache is present.
    if (!expected.has(rn) && (haveBlackoutCache || actual.get(rn)!.source !== 'inventory-override')) {
      archivedBeyondCache.push(rn);
    }
  }

  // `archivedBeyondCache` is expected under archive semantics and never a failure.
  const ok = mismatches.length === 0 && missingInPg.length === 0;
  console.log(
    JSON.stringify(
      {
        expectedRows: expected.size,
        pgRows: rows.length,
        blackoutCachePresent: haveBlackoutCache,
        mismatches: mismatches.length,
        missingInPg: missingInPg.length,
        archivedBeyondCache: archivedBeyondCache.length,
        staleCleaningStatus: staleCleaningStatus.length,
        // Which columns drifted — a bare count can hide a single field failing
        // across every row (e.g. a comparator bug) behind a scary total.
        mismatchesByField: mismatches.reduce<Record<string, number>>((acc, m) => {
          acc[m.field] = (acc[m.field] ?? 0) + 1;
          return acc;
        }, {}),
        sampleMismatches: mismatches.slice(0, 10),
        sampleMissing: missingInPg.slice(0, 10),
        sampleArchived: archivedBeyondCache.slice(0, 10),
        verdict: ok ? '✅ parity' : '❌ drift',
      },
      null,
      2,
    ),
  );
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error('❌ verify failed:', e);
  process.exit(1);
});

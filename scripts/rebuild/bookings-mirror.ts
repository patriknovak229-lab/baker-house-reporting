/**
 * Refresh `bookings_mirror` from the raw Beds24 cache in Redis. No Beds24 calls.
 *
 *   npx tsx scripts/rebuild/bookings-mirror.ts
 *
 * This TOPS UP the archive — it upserts whatever the cache currently holds and
 * deletes nothing, so bookings that have already aged out of the cache keep their
 * archived rows. It is NOT a from-scratch rebuild: since the archive is meant to
 * outlive the cache, a wipe-and-reinsert would destroy exactly the history it
 * exists to protect. To re-project the whole archive after a normalizer change,
 * use the stored `raw` booking on each row instead of this script.
 *
 * Runs regardless of WRITE_BOOKINGS_MIRROR (that flag gates the /api/bookings
 * side effect, not this deliberate action). Projects rows through the SAME
 * normalize pipeline + row mapper the route uses, so this and a live sync cannot
 * drift apart.
 */
import '../_loadEnv';

import { Redis } from '@upstash/redis';
import { mergeGroupedBookings, mapToReservation, type Beds24Booking } from '../../utils/beds24Reservations';
import { publishBookingsMirror } from '../../utils/bookingsMirror';
import type { GuestRating, Reservation } from '../../types/reservation';

const BOOKINGS_CACHE_KEY = 'baker:beds24-bookings-cache';
const REVIEWS_CACHE_KEY = 'baker:beds24-reviews-cache';
const OVERRIDE_BLACKOUTS_CACHE_KEY = 'baker:override-blackouts-cache';

const isCancelledStatus = (b: Beds24Booking) => b.status === 'cancelled' || b.status === 'canceled';

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
  if (raw.length === 0) {
    console.error('❌ bookings cache is empty — load /api/bookings once, then re-run.');
    process.exit(1);
  }

  // Same shape as the route's GET: group active bookings, map cancelled ones
  // individually, attach synced reviews by apiReference over the grouped index.
  const grouped = mergeGroupedBookings(raw.filter((b) => !isCancelledStatus(b)));
  const byRef = reviewsRaw?.byRef ?? {};
  const active = grouped.map((b) => {
    const r = mapToReservation(b);
    const rating = b.apiReference ? byRef[String(b.apiReference)] : undefined;
    return rating ? { ...r, syncedRating: rating } : r;
  });
  const cancelledRaw = raw.filter(isCancelledStatus);
  const reservations = [...active, ...cancelledRaw.map(mapToReservation)];

  const apiReferenceByReservation: Record<string, string> = {};
  const rawByReservation: Record<string, Beds24Booking> = {};
  for (const b of [...grouped, ...cancelledRaw]) {
    if (b.apiReference) apiReferenceByReservation[`BH-${b.id}`] = String(b.apiReference);
    rawByReservation[`BH-${b.id}`] = b;
  }

  // Blackouts are only upserted here, never pruned: this script doesn't know the
  // window the cached rows were fetched for, and pruning against an unknown window
  // could delete a blackout on no evidence. Pruning is the live route's job.
  const cachedBlackouts = Array.isArray(blackoutsRaw) ? blackoutsRaw : null;

  const result = await publishBookingsMirror({
    reservations,
    apiReferenceByReservation,
    rawByReservation,
    overrideBlackouts: cachedBlackouts ? { rows: cachedBlackouts } : null,
  });

  const { summarizeBookingsMirrorPg } = await import('../../data-access/bookingsMirror');
  console.log(
    JSON.stringify(
      {
        cachedBookings: raw.length,
        rowsUpserted: result.bookings,
        skippedInvalid: result.skipped,
        activeGrouped: active.length,
        cancelled: cancelledRaw.length,
        withApiReference: Object.keys(apiReferenceByReservation).length,
        blackouts:
          cachedBlackouts == null
            ? 'cache absent — existing rows preserved'
            : `${result.overrides} upserted (never pruned here)`,
        table: await summarizeBookingsMirrorPg(),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error('❌ rebuild failed:', e);
  process.exit(1);
});

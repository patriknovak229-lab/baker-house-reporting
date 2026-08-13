/**
 * Health check for the bookings archive in Postgres.
 *
 * The archive is written as a best-effort side effect of the /api/bookings sync,
 * which means it can stop working completely — a bad deploy, a revoked Postgres
 * URL, an unset flag — without anything in the UI changing. Nothing would tell
 * you. That makes an unmonitored archive a belief rather than a backup, so this
 * runs daily off the 09:00 cron and alerts on Telegram.
 *
 * Four questions, in the order they can go wrong:
 *   1. Is archiving even switched on? (no flag → nothing is being written)
 *   2. Is it recent? (a stale `synced_at` means syncs stopped reaching Postgres)
 *   3. Did it SHRINK? The booking scope is upsert-only and must never lose rows,
 *      so a negative delta is the single loudest signal available.
 *   4. Does it cover everything Redis has? This is the "is Postgres keeping up
 *      with Redis" check. It is deliberately one-directional: Postgres holding
 *      MORE than the cache is the whole point of the archive, so extra rows are
 *      never a fault — only cache rows missing from Postgres are.
 */
import { Redis } from '@upstash/redis';
import { bookingsMirrorWriteEnabled } from '@/utils/bookingsMirror';
import { mergeGroupedBookings, type Beds24Booking } from '@/utils/beds24Reservations';

const BOOKINGS_CACHE_KEY = 'baker:beds24-bookings-cache';
const HEALTH_SETTING = 'bookings-mirror-health';

/**
 * How stale `synced_at` may get before it's a problem. The archive is written by
 * the dashboard's own sync, so this is really "nobody has loaded the app and no
 * sync has reached Postgres in this long" — 36h tolerates a quiet weekend day
 * without crying wolf, while still catching a genuine stop within a day.
 */
const DEFAULT_MAX_AGE_HOURS = 36;

export type BookingsMirrorHealth = {
  /** `disabled` = flag off (nothing to alert about); `warn` = at least one problem. */
  status: 'ok' | 'warn' | 'disabled';
  writeEnabled: boolean;
  rows: number;
  lastSyncedAt: string | null;
  ageHours: number | null;
  oldestCheckIn: string | null;
  newestCheckIn: string | null;
  blackoutRows: number;
  /** Row count at the previous check, for the shrink test. */
  previousRows: number | null;
  rowDelta: number | null;
  /** Raw bookings currently in the Redis cache (includes merged sub-bookings). */
  cacheBookings: number | null;
  /** Reservations the cache implies AFTER group-merging — the archive's expected count. */
  expectedReservations: number | null;
  /** Expected reservations with no archived row — should always be 0. */
  missingFromArchive: number | null;
  missingSamples: string[];
  problems: string[];
  checkedAt: string;
};

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

/**
 * Run the check. `persist: true` stores this run's row count so the NEXT run can
 * detect a shrink — pass false for ad-hoc inspection so a manual look doesn't
 * move the baseline the cron compares against.
 */
export async function checkBookingsMirrorHealth(
  opts: { maxAgeHours?: number; persist?: boolean } = {},
): Promise<BookingsMirrorHealth> {
  const maxAgeHours = opts.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  const now = new Date();
  const problems: string[] = [];

  const { summarizeBookingsMirrorPg } = await import('@/data-access/bookingsMirror');
  const { readMirrorHealthSnapshot, writeMirrorHealthSnapshot, listArchivedReservationNumbers } =
    await import('@/data-access/bookingsMirrorHealth');

  const summary = await summarizeBookingsMirrorPg();
  const bookings = summary['beds24-booking'];
  const rows = bookings.rows;
  const lastSyncedAt = bookings.lastSyncedAt;

  const ageHours =
    lastSyncedAt != null
      ? (now.getTime() - new Date(lastSyncedAt).getTime()) / 3_600_000
      : null;

  const writeEnabled = bookingsMirrorWriteEnabled();

  // ── 2. freshness ──
  if (writeEnabled) {
    if (lastSyncedAt == null) {
      problems.push('Archive is empty — no booking has ever been mirrored.');
    } else if (ageHours != null && ageHours > maxAgeHours) {
      problems.push(
        `Archive last updated ${ageHours.toFixed(1)}h ago (limit ${maxAgeHours}h) — bookings syncs are not reaching Postgres.`,
      );
    } else if (ageHours != null && ageHours < -0.25) {
      // synced_at is stamped by the DB clock, so this should be impossible.
      problems.push(`Archive timestamp is ${Math.abs(ageHours).toFixed(1)}h in the FUTURE — check the database clock.`);
    }
  }

  // ── 3. shrink test ──
  const previous = await readMirrorHealthSnapshot();
  const previousRows = previous?.rows ?? null;
  const rowDelta = previousRows != null ? rows - previousRows : null;
  if (rowDelta != null && rowDelta < 0) {
    problems.push(
      `Archive SHRANK by ${Math.abs(rowDelta)} rows (${previousRows} → ${rows}). It is upsert-only and must never lose bookings — investigate before the next sync.`,
    );
  }

  // ── 4. does Postgres cover the live cache? ──
  let cacheBookings: number | null = null;
  let expectedReservations: number | null = null;
  let missingFromArchive: number | null = null;
  let missingSamples: string[] = [];
  const redis = getRedis();
  if (redis) {
    const cache = await redis.get<Record<string, Beds24Booking>>(BOOKINGS_CACHE_KEY);
    if (cache && typeof cache === 'object') {
      const raw = Object.values(cache);
      cacheBookings = raw.length;

      // Raw cache ids are NOT the expected archive keys: `mergeGroupedBookings`
      // folds sub-bookings (virtual-room allocations, Booking.com multi-unit,
      // multi-row packages) into their master, so those ids intentionally never
      // get a row of their own. Comparing raw ids would report every merged
      // sub-booking as missing and alert daily. Run the real grouping — same
      // pipeline the sync and the archive use — to get the true expected set.
      const isCancelled = (b: Beds24Booking) => b.status === 'cancelled' || b.status === 'canceled';
      const expected = [
        ...mergeGroupedBookings(raw.filter((b) => !isCancelled(b))),
        ...raw.filter(isCancelled),
      ].map((b) => `BH-${b.id}`);
      expectedReservations = expected.length;

      if (writeEnabled && expected.length > 0) {
        const archived = new Set(await listArchivedReservationNumbers());
        const missing = expected.filter((rn) => !archived.has(rn));
        missingFromArchive = missing.length;
        missingSamples = missing.slice(0, 10);
        if (missing.length > 0) {
          problems.push(
            `${missing.length} reservation(s) in the Redis cache have no archived row (e.g. ${missingSamples.slice(0, 3).join(', ')}).`,
          );
        }
      }
    }
  }

  const health: BookingsMirrorHealth = {
    status: !writeEnabled ? 'disabled' : problems.length > 0 ? 'warn' : 'ok',
    writeEnabled,
    rows,
    lastSyncedAt,
    ageHours: ageHours != null ? Number(ageHours.toFixed(2)) : null,
    oldestCheckIn: bookings.oldestCheckIn,
    newestCheckIn: bookings.newestCheckIn,
    blackoutRows: summary['inventory-override'].rows,
    previousRows,
    rowDelta,
    cacheBookings,
    expectedReservations,
    missingFromArchive,
    missingSamples,
    problems,
    checkedAt: now.toISOString(),
  };

  // Only move the shrink baseline when asked, and never on a disabled flag —
  // otherwise a day with the flag off would bake a low count into the baseline.
  if (opts.persist && writeEnabled) {
    await writeMirrorHealthSnapshot({ rows, checkedAt: health.checkedAt });
  }

  return health;
}

/** One-line Telegram body. Returns null when there is nothing worth sending. */
export function bookingsMirrorAlert(health: BookingsMirrorHealth): string | null {
  if (health.status !== 'warn') return null;
  const lines = [
    '⚠️ Bookings archive (Postgres) health check failed:',
    ...health.problems.map((p) => `• ${p}`),
    '',
    `Rows: ${health.rows}${health.rowDelta != null ? ` (${health.rowDelta >= 0 ? '+' : ''}${health.rowDelta} since last check)` : ''}`,
    `Last write: ${health.lastSyncedAt ?? 'never'}`,
  ];
  return lines.join('\n');
}

export { HEALTH_SETTING };

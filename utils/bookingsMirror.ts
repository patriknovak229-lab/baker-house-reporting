/**
 * Writer for the bookings mirror — the durable archive of every booking the app
 * has ever seen, in Postgres.
 *
 * This is NOT one of the `STORE_*` redis|dual|postgres domains. Redis stays the
 * live working set the app reads; this is the long-term record. The existing
 * single sync writer (`app/api/bookings/route.ts` GET) publishes to it as a
 * best-effort side effect, exactly like `persistRateTypeMap` — a failure is
 * logged and never touches the API response.
 *
 * THE DURABILITY GUARANTEE (operator's requirement, 2026-08-12): the app should
 * hold the entire history of the business, and the Redis cache actively discards
 * it (a full sync wipes the cache and refetches only arrival ±1 year). So:
 *   - bookings are UPSERT-ONLY here and never deleted by this path;
 *   - an emptied, partial or corrupted Redis cache therefore cannot remove
 *     anything from Postgres — at worst a sync updates fewer rows than usual;
 *   - rows failing a validity gate are skipped rather than allowed to overwrite
 *     good archived data;
 *   - the raw (group-merged) Beds24 booking is stored alongside the projection so
 *     the archive can be re-projected after a normalizer change, long after the
 *     cache and Beds24's own window have moved on.
 *
 * Gate: `WRITE_BOOKINGS_MIRROR=true`. Off by default, so deploying this changes
 * nothing — no Postgres writes on the /api/bookings path until it's set.
 */
import type { Reservation } from '@/types/reservation';
import type { BookingsMirrorInsert, BookingsMirrorSource } from '@/lib/db/schema/bookingsMirror';

/** Is mirror publishing switched on? Off unless explicitly enabled. */
export function bookingsMirrorWriteEnabled(): boolean {
  const raw = process.env.WRITE_BOOKINGS_MIRROR?.trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

/** `BH-12345` → 12345; anything else (e.g. an `OV-…` blackout row) → null. */
function beds24IdFrom(reservationNumber: string): number | null {
  const m = /^BH-(\d+)$/.exec(reservationNumber);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/** The normalizer emits "" for absent Beds24 dates; a date column needs null. */
function ymdOrNull(value: string | undefined | null): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/** Parse an ISO timestamp defensively — an unparseable value must not abort the batch. */
function tsOrNull(value: string | undefined | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Money → unbounded numeric as a string (the Wave-2 precision rule). */
function num(value: number | undefined | null): string {
  return String(typeof value === 'number' && Number.isFinite(value) ? value : 0);
}

function int(value: number | undefined | null): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/**
 * Is this row safe to write over an archived one?
 *
 * `mapToReservation` defaults every missing Beds24 field to ""/0, so a truncated
 * or malformed upstream record still produces a structurally valid Reservation —
 * one that would silently overwrite good history with blanks. Both stay dates are
 * the discriminator: every real booking, cancellation and blackout has an arrival
 * and a departure, so a row missing either is not trustworthy input.
 */
export function isMirrorRowWritable(row: BookingsMirrorInsert): boolean {
  return Boolean(row.reservationNumber) && Boolean(row.checkInDate) && Boolean(row.checkOutDate);
}

/**
 * Project one normalized `Reservation` onto a mirror row.
 *
 * Expects the reservation as `mapToReservation` produced it (plus `syncedRating`):
 * read-time overlays — reservation overrides, the Stripe-fee roll-up, overlap
 * flags — are intentionally not persisted. Exported so the rebuild and verify
 * scripts project rows through this exact function rather than a second copy
 * that could drift.
 *
 * `raw` should be the (group-merged) Beds24 booking this reservation came from,
 * so the row can be re-projected later; omit it for synthetic blackout rows.
 *
 * Note there is no `syncedAt` here: freshness is stamped by the database clock
 * (column default on insert, `now()` on update), never by the caller.
 */
export function toBookingsMirrorRow(
  r: Reservation,
  opts: {
    source: BookingsMirrorSource;
    apiReference?: string | null;
    raw?: unknown;
  },
): BookingsMirrorInsert {
  return {
    reservationNumber: r.reservationNumber,
    source: opts.source,
    beds24Id: beds24IdFrom(r.reservationNumber),
    apiReference: opts.apiReference ?? null,
    channel: r.channel,
    room: r.room,
    linkedRooms: r.linkedRooms && r.linkedRooms.length > 0 ? r.linkedRooms : null,
    checkInDate: ymdOrNull(r.checkInDate),
    checkOutDate: ymdOrNull(r.checkOutDate),
    reservationDate: ymdOrNull(r.reservationDate),
    bookingTimestamp: tsOrNull(r.bookingTimestamp),
    modifiedAt: tsOrNull(r.modifiedAt),
    numberOfNights: int(r.numberOfNights),
    numberOfGuests: int(r.numberOfGuests),
    firstName: r.firstName ?? '',
    lastName: r.lastName ?? '',
    email: r.email ?? '',
    phone: r.phone ?? '',
    nationality: r.nationality ?? '',
    price: num(r.price),
    amountPaid: num(r.amountPaid),
    commissionAmount: num(r.commissionAmount),
    paymentChargeAmount: num(r.paymentChargeAmount),
    paymentStatus: r.paymentStatus,
    cleaningStatus: r.cleaningStatus,
    rateType: r.rateType ?? null,
    status: r.status ?? null,
    isCancelled: r.isCancelled === true,
    isBlackout: r.isBlackout === true,
    isUnallocatedVr: r.isUnallocatedVR === true,
    blackoutCreatedBy: r.blackoutCreatedBy ?? null,
    blackoutReason: r.blackoutReason ?? null,
    syncedRating: r.syncedRating ?? null,
    raw: opts.raw ?? null,
    // synced_at and first_seen_at are both column-defaulted on insert; the upsert
    // advances synced_at with the DB clock and never touches first_seen_at, so a
    // row's original discovery time survives every later sync.
  };
}

export type PublishBookingsMirrorResult = {
  /** Rows upserted into the archive. */
  bookings: number;
  /** Rows rejected by the validity gate (never written). */
  skipped: number;
  /** Blackout rows written, or null when the calendar wasn't fetched this sync. */
  overrides: number | null;
};

/**
 * Archive the reservation set from this sync.
 *
 * `reservations` must be the Beds24-booking-derived set (active + cancelled)
 * BEFORE the read-time overlays. Nothing here deletes a booking.
 *
 * `overrideBlackouts` controls the blackout scope, in three modes:
 *   - `null` / omitted   → blackout rows are not touched at all.
 *   - `{ rows }`         → upsert only; nothing is pruned. For callers holding
 *                          blackouts whose fetch window they don't know (e.g. the
 *                          refresh script reading the 5-minute cache).
 *   - `{ rows, window }` → windowed replace: inside the window the calendar was
 *                          actually fetched for, absent blackouts are REMOVED.
 *                          They're re-derivable from Beds24, and a deleted one
 *                          must not linger as a phantom that would corrupt
 *                          historical occupancy. Only pass a window you have
 *                          fresh evidence for.
 */
export async function publishBookingsMirror(input: {
  reservations: Reservation[];
  apiReferenceByReservation?: Record<string, string>;
  rawByReservation?: Record<string, unknown>;
  overrideBlackouts?: { rows: Reservation[]; window?: { from: string; to: string } | null } | null;
}): Promise<PublishBookingsMirrorResult> {
  const refs = input.apiReferenceByReservation ?? {};
  const raws = input.rawByReservation ?? {};

  const projected = input.reservations.map((r) =>
    toBookingsMirrorRow(r, {
      source: 'beds24-booking',
      apiReference: refs[r.reservationNumber] ?? null,
      raw: raws[r.reservationNumber],
    }),
  );
  const writable = projected.filter(isMirrorRowWritable);
  const skipped = projected.length - writable.length;

  const pg = await import('@/data-access/bookingsMirror');
  const bookings = await pg.upsertBookingsMirrorPg(writable);

  let overrides: number | null = null;
  if (input.overrideBlackouts != null) {
    const ovRows = input.overrideBlackouts.rows
      .map((r) => toBookingsMirrorRow(r, { source: 'inventory-override' }))
      .filter(isMirrorRowWritable);
    const window = input.overrideBlackouts.window;
    overrides = window
      ? await pg.replaceBookingsMirrorOverridesPg(ovRows, window)
      : await pg.upsertBookingsMirrorPg(ovRows);
  }

  return { bookings, skipped, overrides };
}

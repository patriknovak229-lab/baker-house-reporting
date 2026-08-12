/**
 * Writer for the bookings mirror — the derived Beds24 read-model in Postgres.
 *
 * This is NOT one of the `STORE_*` redis|dual|postgres domains: nothing
 * authoritative lives here, so there is no dual-write or fallback to reason
 * about. The mirror is a projection of `baker:beds24-bookings-cache` that the
 * existing single sync writer (`app/api/bookings/route.ts` GET) publishes as a
 * best-effort side effect, exactly like `persistRateTypeMap` — a failure is
 * logged and never touches the API response.
 *
 * Nothing reads the mirror yet. Wiring readers is a separate, sign-off-gated
 * step behind a `READ_BOOKINGS_FROM=compute|mirror` dual-read parity gate;
 * until then this is pure write-side groundwork.
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
 * Project one normalized `Reservation` onto a mirror row.
 *
 * Expects the reservation as `mapToReservation` produced it (plus `syncedRating`):
 * read-time overlays — reservation overrides, the Stripe-fee roll-up, overlap
 * flags — are intentionally not persisted. Exported so
 * `scripts/rebuild/bookings-mirror.ts` projects rows through this exact function
 * rather than a second copy that could drift.
 */
export function toBookingsMirrorRow(
  r: Reservation,
  opts: { source: BookingsMirrorSource; apiReference?: string | null; syncedAt: Date },
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
    syncedAt: opts.syncedAt,
  };
}

/**
 * Replace the mirror with the reservation set from this sync.
 *
 * `reservations` must be the Beds24-booking-derived set (active + cancelled)
 * BEFORE the read-time overlays. `overrideBlackouts` carries the synthetic rows
 * from the inventory calendar — pass `null` when that fetch FAILED so the
 * previously mirrored blackouts are preserved rather than deleted (the two
 * sources are replaced in independent scopes for exactly this reason).
 */
export async function publishBookingsMirror(input: {
  reservations: Reservation[];
  apiReferenceByReservation?: Record<string, string>;
  overrideBlackouts?: Reservation[] | null;
  syncedAt?: Date;
}): Promise<{ bookings: number; overrides: number | null }> {
  const syncedAt = input.syncedAt ?? new Date();
  const refs = input.apiReferenceByReservation ?? {};

  const scopes: { source: BookingsMirrorSource; rows: BookingsMirrorInsert[] }[] = [
    {
      source: 'beds24-booking',
      rows: input.reservations.map((r) =>
        toBookingsMirrorRow(r, {
          source: 'beds24-booking',
          apiReference: refs[r.reservationNumber] ?? null,
          syncedAt,
        }),
      ),
    },
  ];

  if (input.overrideBlackouts != null) {
    scopes.push({
      source: 'inventory-override',
      rows: input.overrideBlackouts.map((r) =>
        toBookingsMirrorRow(r, { source: 'inventory-override', syncedAt }),
      ),
    });
  }

  const { replaceBookingsMirrorScopesPg } = await import('@/data-access/bookingsMirror');
  await replaceBookingsMirrorScopesPg(scopes);

  return {
    bookings: scopes[0].rows.length,
    overrides: input.overrideBlackouts != null ? scopes[1].rows.length : null,
  };
}

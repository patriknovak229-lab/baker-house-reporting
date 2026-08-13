/**
 * Postgres repository for the bookings mirror — the durable archive of every
 * booking the app has ever seen (see lib/db/schema/bookingsMirror.ts).
 *
 * Unlike every other repo here this is NOT a Redis-key cutover: there is no
 * `STORE_*` redis|dual|postgres flag. Redis stays the live working set; this is
 * the long-term record, and the two scopes have deliberately DIFFERENT write
 * semantics:
 *
 *  - `beds24-booking` → UPSERT-ONLY, never deleted. A booking that has aged out
 *    of the Redis cache (a full sync wipes it and refetches only arrival ±1 year)
 *    must survive here, and an emptied or partially-fetched Redis must not be
 *    able to delete anything. `first_seen_at` is preserved across updates;
 *    `synced_at` advances so staleness is visible.
 *
 *  - `inventory-override` → WINDOWED REPLACE. Blackout rows carry their date
 *    range in the id (`OV-<room>-<from>-<to>`), so an edited or deleted blackout
 *    would otherwise linger forever as a phantom and corrupt historical
 *    occupancy. They are re-derivable from Beds24 on demand, so within the window
 *    the calendar was actually fetched for, absent rows are removed — and only
 *    within it, so blackouts older than the fetch window are still preserved.
 */
import type { BatchItem } from 'drizzle-orm/batch';
import { and, eq, gte, lte, notInArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { bookingsMirror } from '@/lib/db/schema';
import type { BookingsMirrorInsert, BookingsMirrorRow, BookingsMirrorSource } from '@/lib/db/schema/bookingsMirror';

/** Rows per statement — 36 columns, so this stays far inside Postgres' 65535-param cap. */
const CHUNK = 300;

function chunk<T>(rows: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** Last-wins dedupe; the PK would otherwise abort the whole statement. */
function dedupe(rows: BookingsMirrorInsert[]): BookingsMirrorInsert[] {
  const byId = new Map<string, BookingsMirrorInsert>();
  for (const row of rows) if (row.reservationNumber) byId.set(row.reservationNumber, row);
  return [...byId.values()];
}

/**
 * Build the upsert. Four protections live in here:
 *
 *  1. `first_seen_at` is NOT in the update set, so it keeps the original value.
 *  2. `synced_at` uses the DATABASE clock, not the caller's.
 *  3. Four columns update through `COALESCE(excluded.x, existing.x)` — a NULL
 *     from a sync must never erase a value the archive already holds, because
 *     for these the incoming NULL means "this sync couldn't see it", not
 *     "it's gone":
 *       - `synced_rating`: reviews come from a rolling window (Beds24's
 *         Booking.com endpoint caps at 100 oldest-first) held in a Redis cache
 *         that merges forward. If that cache is cold or the fetch fails,
 *         `getReviews` legitimately returns {} and every rating older than the
 *         window would be nulled — permanently, since nothing else stores them.
 *       - `rate_type`: detection is deliberately scope-gated to current+future
 *         OTA stays (`isRateTypeInScope`), so re-syncing a past booking always
 *         yields undefined. Without COALESCE, history loses its rate plans.
 *       - `api_reference` / `raw`: never legitimately removed; a NULL is a
 *         degraded read.
 *     Consequence to accept: these four can be corrected to a NEW non-null
 *     value but never cleared back to NULL through this path.
 *  4. `setWhere` refuses to apply an update carrying an OLDER Beds24
 *     `modified_at` than the row already has. Two syncs racing (or a retried
 *     request arriving late) can otherwise write a stale snapshot over a fresh
 *     one. Rows where either side has no `modified_at` fall through to a normal
 *     update — Beds24 omits the field on plenty of bookings, and `>=` keeps
 *     same-timestamp updates flowing so a newly-arrived review or a recomputed
 *     cleaning status still lands.
 */
function upsertStatement(rows: BookingsMirrorInsert[]) {
  return db
    .insert(bookingsMirror)
    .values(rows)
    .onConflictDoUpdate({
      target: bookingsMirror.reservationNumber,
      set: {
        source: sql`excluded.source`,
        beds24Id: sql`excluded.beds24_id`,
        apiReference: sql`coalesce(excluded.api_reference, ${bookingsMirror.apiReference})`,
        channel: sql`excluded.channel`,
        room: sql`excluded.room`,
        linkedRooms: sql`excluded.linked_rooms`,
        checkInDate: sql`excluded.check_in_date`,
        checkOutDate: sql`excluded.check_out_date`,
        reservationDate: sql`excluded.reservation_date`,
        bookingTimestamp: sql`excluded.booking_timestamp`,
        modifiedAt: sql`excluded.modified_at`,
        numberOfNights: sql`excluded.number_of_nights`,
        numberOfGuests: sql`excluded.number_of_guests`,
        firstName: sql`excluded.first_name`,
        lastName: sql`excluded.last_name`,
        email: sql`excluded.email`,
        phone: sql`excluded.phone`,
        nationality: sql`excluded.nationality`,
        price: sql`excluded.price`,
        amountPaid: sql`excluded.amount_paid`,
        commissionAmount: sql`excluded.commission_amount`,
        paymentChargeAmount: sql`excluded.payment_charge_amount`,
        paymentStatus: sql`excluded.payment_status`,
        cleaningStatus: sql`excluded.cleaning_status`,
        rateType: sql`coalesce(excluded.rate_type, ${bookingsMirror.rateType})`,
        status: sql`excluded.status`,
        isCancelled: sql`excluded.is_cancelled`,
        isBlackout: sql`excluded.is_blackout`,
        isUnallocatedVr: sql`excluded.is_unallocated_vr`,
        blackoutCreatedBy: sql`excluded.blackout_created_by`,
        blackoutReason: sql`excluded.blackout_reason`,
        syncedRating: sql`coalesce(excluded.synced_rating, ${bookingsMirror.syncedRating})`,
        raw: sql`coalesce(excluded.raw, ${bookingsMirror.raw})`,
        syncedAt: sql`now()`,
      },
      setWhere: sql`
        ${bookingsMirror.modifiedAt} IS NULL
        OR excluded.modified_at IS NULL
        OR excluded.modified_at >= ${bookingsMirror.modifiedAt}
      `,
    });
}

/**
 * Archive the booking scope. Never deletes. Safe to call with a partial set —
 * rows it doesn't mention are simply left as they were.
 */
export async function upsertBookingsMirrorPg(rows: BookingsMirrorInsert[]): Promise<number> {
  const deduped = dedupe(rows);
  if (deduped.length === 0) return 0;
  const chunks = chunk(deduped);
  if (chunks.length === 1) {
    await upsertStatement(chunks[0]);
    return deduped.length;
  }
  const statements: BatchItem<'pg'>[] = chunks.map(upsertStatement);
  // db.batch's signature is a non-empty tuple; the chunk count is dynamic.
  await db.batch(statements as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);
  return deduped.length;
}

/**
 * Replace the inventory-override rows that fall INSIDE the window the calendar
 * was fetched for, leaving everything outside it untouched.
 *
 * `window` must be the actual fetched range — pass the same bounds the Beds24
 * calendar request used, or a deleted blackout outside it would be dropped from
 * the archive on no evidence.
 */
export async function replaceBookingsMirrorOverridesPg(
  rows: BookingsMirrorInsert[],
  window: { from: string; to: string },
): Promise<number> {
  const deduped = dedupe(rows);
  const keep = deduped.map((r) => r.reservationNumber);

  const inWindow = and(
    eq(bookingsMirror.source, 'inventory-override' satisfies BookingsMirrorSource),
    gte(bookingsMirror.checkInDate, window.from),
    lte(bookingsMirror.checkInDate, window.to),
  );

  const prune = db
    .delete(bookingsMirror)
    .where(keep.length > 0 ? and(inWindow, notInArray(bookingsMirror.reservationNumber, keep)) : inWindow);

  if (deduped.length === 0) {
    await prune;
    return 0;
  }
  const statements: BatchItem<'pg'>[] = [prune, ...chunk(deduped).map(upsertStatement)];
  await db.batch(statements as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);
  return deduped.length;
}

/** Every mirrored row. Ordered by check-in for stable, human-readable output. */
export async function listBookingsMirrorPg(): Promise<BookingsMirrorRow[]> {
  return db.select().from(bookingsMirror).orderBy(bookingsMirror.checkInDate, bookingsMirror.reservationNumber);
}

/**
 * Row counts + coverage per source. `oldestCheckIn` / `newestCheckIn` show how
 * far the archive actually reaches; `lastSyncedAt` is the staleness signal — if
 * it stops advancing, the backup has silently stopped updating.
 */
export async function summarizeBookingsMirrorPg(): Promise<
  Record<BookingsMirrorSource, { rows: number; lastSyncedAt: string | null; oldestCheckIn: string | null; newestCheckIn: string | null }>
> {
  const rows = await db
    .select({
      source: bookingsMirror.source,
      syncedAt: bookingsMirror.syncedAt,
      checkInDate: bookingsMirror.checkInDate,
    })
    .from(bookingsMirror);

  const blank = () => ({
    rows: 0,
    lastSyncedAt: null as string | null,
    oldestCheckIn: null as string | null,
    newestCheckIn: null as string | null,
  });
  const summary = {
    'beds24-booking': blank(),
    'inventory-override': blank(),
  } satisfies Record<BookingsMirrorSource, ReturnType<typeof blank>>;

  for (const r of rows) {
    const bucket = summary[r.source];
    if (!bucket) continue;
    bucket.rows += 1;
    const at = r.syncedAt?.toISOString() ?? null;
    if (at && (!bucket.lastSyncedAt || at > bucket.lastSyncedAt)) bucket.lastSyncedAt = at;
    if (r.checkInDate) {
      if (!bucket.oldestCheckIn || r.checkInDate < bucket.oldestCheckIn) bucket.oldestCheckIn = r.checkInDate;
      if (!bucket.newestCheckIn || r.checkInDate > bucket.newestCheckIn) bucket.newestCheckIn = r.checkInDate;
    }
  }
  return summary;
}

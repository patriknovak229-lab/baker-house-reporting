/**
 * Postgres repository for the bookings mirror — the derived Beds24 read-model
 * (see lib/db/schema/bookingsMirror.ts for what is and isn't stored).
 *
 * Unlike every other repo here this is NOT a Redis-key cutover: there is no
 * `STORE_*` redis|dual|postgres flag and no authoritative data to lose. The
 * mirror is a projection — writes fully replace a `source` scope, and the whole
 * table can be rebuilt from `baker:beds24-bookings-cache` by
 * `scripts/rebuild/bookings-mirror.ts`.
 *
 * Replace is SCOPED BY SOURCE (delete-then-insert within one batch) because the
 * two sources arrive from different Beds24 endpoints and can fail independently:
 * a failed inventory-calendar fetch must not wipe mirrored blackouts, and it must
 * not block mirroring the bookings that did sync.
 */
import type { BatchItem } from 'drizzle-orm/batch';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { bookingsMirror } from '@/lib/db/schema';
import type { BookingsMirrorInsert, BookingsMirrorRow, BookingsMirrorSource } from '@/lib/db/schema/bookingsMirror';

/** Rows per INSERT — 28 columns, so this stays far inside Postgres' 65535-param cap. */
const INSERT_CHUNK = 400;

export type BookingsMirrorScope = {
  source: BookingsMirrorSource;
  rows: BookingsMirrorInsert[];
};

/**
 * Atomically replace the given `source` scopes. Scopes not passed are left
 * untouched (that's how a partial sync preserves the other source's rows).
 * Duplicate reservation numbers within a scope are collapsed last-wins — the
 * PK would otherwise abort the whole batch.
 */
export async function replaceBookingsMirrorScopesPg(scopes: BookingsMirrorScope[]): Promise<void> {
  const statements: BatchItem<'pg'>[] = [];

  for (const { source, rows } of scopes) {
    statements.push(db.delete(bookingsMirror).where(eq(bookingsMirror.source, source)));

    const byId = new Map<string, BookingsMirrorInsert>();
    for (const row of rows) {
      if (row.reservationNumber) byId.set(row.reservationNumber, row);
    }
    const deduped = [...byId.values()];
    for (let i = 0; i < deduped.length; i += INSERT_CHUNK) {
      statements.push(db.insert(bookingsMirror).values(deduped.slice(i, i + INSERT_CHUNK)));
    }
  }

  if (statements.length === 0) return;
  // db.batch's signature is a non-empty tuple; the scope list is dynamic.
  await db.batch(statements as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);
}

/** Every mirrored row. Ordered by check-in for stable, human-readable output. */
export async function listBookingsMirrorPg(): Promise<BookingsMirrorRow[]> {
  return db.select().from(bookingsMirror).orderBy(bookingsMirror.checkInDate, bookingsMirror.reservationNumber);
}

/** Row counts + freshness per source — used by the rebuild script and parity checks. */
export async function summarizeBookingsMirrorPg(): Promise<
  Record<BookingsMirrorSource, { rows: number; lastSyncedAt: string | null }>
> {
  const rows = await db
    .select({ source: bookingsMirror.source, syncedAt: bookingsMirror.syncedAt })
    .from(bookingsMirror);
  const empty = { rows: 0, lastSyncedAt: null as string | null };
  const summary: Record<BookingsMirrorSource, { rows: number; lastSyncedAt: string | null }> = {
    'beds24-booking': { ...empty },
    'inventory-override': { ...empty },
  };
  for (const r of rows) {
    const bucket = summary[r.source];
    if (!bucket) continue;
    bucket.rows += 1;
    const at = r.syncedAt?.toISOString() ?? null;
    if (at && (!bucket.lastSyncedAt || at > bucket.lastSyncedAt)) bucket.lastSyncedAt = at;
  }
  return summary;
}

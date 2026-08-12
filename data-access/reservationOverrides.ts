/**
 * Postgres repository for the reservation-override overlay (Redis→Postgres
 * cutover). The Redis value is a MAP `Record<reservationNumber, fields>`; here
 * it's one jsonb row per reservation (reservation_number PK, data jsonb). The
 * override object is free-form (the local-state route writes an arbitrary
 * `fields` object), stored verbatim as jsonb — exactly the shape the app merges
 * onto bookings.
 *
 * HARD-RULE domain — storage swap only. The routes do whole-map read-modify-
 * write (read all → mutate one reservation's entry → write all), so listPg +
 * replaceAll mirror `redis.get`/`redis.set` on the single map key: replaceAll is
 * delete-all + insert-all (NOT per-row upsert) so a reservation removed from the
 * map is removed from the table too, byte-identical to a whole-map `set`.
 * Skips null / non-object entries (mirrors scripts/backfill/reservation-overrides.ts).
 */
import { db } from '@/lib/db';
import { reservationOverrides } from '@/lib/db/schema';

export async function listReservationOverridesPg<T = unknown>(): Promise<Record<string, T>> {
  const rows = await db.select().from(reservationOverrides);
  const map: Record<string, T> = {};
  for (const r of rows) map[r.reservationNumber] = r.data as T;
  return map;
}

export async function replaceAllReservationOverridesPg(map: Record<string, unknown>): Promise<void> {
  const rows = Object.entries(map)
    .filter(([rn, data]) => rn && data != null && typeof data === 'object')
    .map(([reservationNumber, data]) => ({ reservationNumber, data }));
  if (rows.length === 0) {
    await db.delete(reservationOverrides);
    return;
  }
  await db.batch([db.delete(reservationOverrides), db.insert(reservationOverrides).values(rows)]);
}

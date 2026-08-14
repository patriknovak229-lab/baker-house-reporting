/**
 * Read the CLEANING APP's data from Postgres (`cleaning.*` schema).
 *
 * baker-house-cleaning has migrated these three domains out of Redis. While it
 * runs in `dual` mode both stores hold identical data and this app can read
 * either; once it flips to `postgres` the Redis keys freeze and this becomes
 * the only correct source. Reading Redis after that point would silently serve
 * stale cost data into the P&L — the same failure that hit reservation
 * overrides, except the symptom would be wrong numbers rather than a missing
 * icon.
 *
 * Both apps share one Neon database and are separated by schema:
 *   public.*    → this app          cleaning.*  → baker-house-cleaning
 *
 * WHY RAW SQL, NOT DRIZZLE TABLES: `lib/db/schema/index.ts` is drizzle-kit's
 * desired-state input and `drizzle.config.ts` pins `schemaFilter: ['public']`.
 * Declaring cleaning's tables there would make `db:generate` emit DDL against
 * tables another app owns and migrates. Fully-qualified raw SQL reads them
 * without ever entering drizzle-kit's model — the mirror image of how the
 * cleaning app reads `public.reservation_overrides`.
 *
 * READ-ONLY. The cleaning app owns these tables' shape and lifecycle.
 *
 * The returned shapes are byte-identical to what the Redis keys held, so
 * /api/variable-costs consumes them without any change to its cost logic.
 */
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

/** Nested: date → roomId → cleanerId (was `baker:cleaning-assignments`). */
export type CleaningAssignmentsNested = Record<string, Record<string, string>>;
/** Flat: "date|roomId" → providerId | null (was `baker:laundry-assignments`). */
export type LaundryAssignmentsFlat = Record<string, string | null>;

export interface CleaningConsumableEntry {
  id: string;
  date: string;
  roomId: string;
  amount: number;
  reservationNumber?: string;
}

function rowsOf<T>(result: unknown): T[] {
  // neon-http returns { rows, fields, ... }; tolerate a bare array too.
  if (Array.isArray(result)) return result as T[];
  return (((result as { rows?: unknown[] })?.rows ?? []) as T[]);
}

/** Who cleans which room on which day. Unassigned cells are simply absent. */
export async function readCleaningAssignmentsPg(): Promise<CleaningAssignmentsNested> {
  const res = await db.execute(
    sql`SELECT date::text AS date, room_id, cleaner_id FROM cleaning.cleaning_assignments`,
  );
  const nested: CleaningAssignmentsNested = {};
  for (const r of rowsOf<{ date: string; room_id: string; cleaner_id: string }>(res)) {
    if (!r?.date || !r.room_id || !r.cleaner_id) continue;
    if (!nested[r.date]) nested[r.date] = {};
    nested[r.date][r.room_id] = r.cleaner_id;
  }
  return nested;
}

/**
 * Laundry provider per cleaning. Explicit nulls are preserved: a cleared
 * provider is a present key with a null value, distinct from a key never set.
 * The consumer skips falsy values either way, but the shapes must match for
 * parity checking to mean anything.
 */
export async function readLaundryAssignmentsPg(): Promise<LaundryAssignmentsFlat> {
  const res = await db.execute(
    sql`SELECT date::text AS date, room_id, provider_id FROM cleaning.laundry_assignments`,
  );
  const flat: LaundryAssignmentsFlat = {};
  for (const r of rowsOf<{ date: string; room_id: string; provider_id: string | null }>(res)) {
    if (!r?.date || !r.room_id) continue;
    flat[`${r.date}|${r.room_id}`] = r.provider_id ?? null;
  }
  return flat;
}

/**
 * Consumable cost entries. `amount` is unbounded numeric in Postgres and comes
 * back as a string — Number() it here so the cost maths is untouched.
 *
 * NOTE: this app buckets consumables by (date, roomId), NOT by
 * reservationNumber — attributing by reservation silently dropped multi-room
 * bookings (fix f4d1afb). reservationNumber is carried for traceability only.
 */
export async function readConsumableEntriesPg(): Promise<CleaningConsumableEntry[]> {
  const res = await db.execute(
    sql`SELECT id, date::text AS date, room_id, amount, reservation_number
        FROM cleaning.consumable_entries
        ORDER BY created_at, id`,
  );
  const out: CleaningConsumableEntry[] = [];
  for (const r of rowsOf<{
    id: string;
    date: string;
    room_id: string;
    amount: string | number;
    reservation_number: string | null;
  }>(res)) {
    if (!r?.id || !r.date || !r.room_id) continue;
    const entry: CleaningConsumableEntry = {
      id: r.id,
      date: r.date,
      roomId: r.room_id,
      amount: Number(r.amount) || 0,
    };
    if (r.reservation_number != null) entry.reservationNumber = r.reservation_number;
    out.push(entry);
  }
  return out;
}

/**
 * Postgres access for the archive health check (utils/bookingsMirrorHealth.ts).
 *
 * The previous run's row count lives in the generic `app_settings` table rather
 * than anywhere in the archive itself — the check has to survive the archive
 * being empty or broken, which is exactly when it matters.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { appSettings, bookingsMirror } from '@/lib/db/schema';

const SETTING = 'bookings-mirror-health';

export type MirrorHealthSnapshot = { rows: number; checkedAt: string };

export async function readMirrorHealthSnapshot(): Promise<MirrorHealthSnapshot | null> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, SETTING)).limit(1);
  const value = row?.value as Partial<MirrorHealthSnapshot> | undefined;
  return typeof value?.rows === 'number' ? { rows: value.rows, checkedAt: value.checkedAt ?? '' } : null;
}

export async function writeMirrorHealthSnapshot(snapshot: MirrorHealthSnapshot): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key: SETTING, value: snapshot, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: snapshot, updatedAt: new Date() } });
}

/**
 * Just the reservation numbers of archived bookings — used to check the archive
 * covers everything in the Redis cache. Deliberately not `select *`: this runs
 * daily and the row payload (including `raw`) is far larger than the ids.
 */
export async function listArchivedReservationNumbers(): Promise<string[]> {
  const rows = await db
    .select({ reservationNumber: bookingsMirror.reservationNumber })
    .from(bookingsMirror)
    .where(eq(bookingsMirror.source, 'beds24-booking'));
  return rows.map((r) => r.reservationNumber);
}

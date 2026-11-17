/**
 * Check-in dates the operator ticked as boosted on Booking.com — one JSON
 * document in app_settings, keyed by date: { "2026-11-20": { commission: 25, … } }.
 *
 * Why a tick when commission already reveals boosts: a 26 % booking only shows
 * the boosted dates where something SOLD. The boosted dates that stayed empty
 * are the other half of the booster's fill rate, and only the tick records them.
 *
 * Every write is a single SQL statement that merges one date into (or removes it
 * from) the stored object, so two quick ticks can never overwrite each other the
 * way a read-modify-write would.
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { appSettings } from '@/lib/db/schema';
import type { BoostedFlag } from '@/utils/boosterCandidates';

const KEY = 'pricing:boosted-dates';

export type BoostedDates = Record<string, BoostedFlag>;

function sanitize(value: unknown): BoostedDates {
  const out: BoostedDates = {};
  if (!value || typeof value !== 'object') return out;
  for (const [date, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !raw || typeof raw !== 'object') continue;
    const flag = raw as Partial<BoostedFlag>;
    if (typeof flag.commission !== 'number' || !Number.isFinite(flag.commission)) continue;
    out[date] = {
      commission: flag.commission,
      markedAt: typeof flag.markedAt === 'string' ? flag.markedAt : '',
      markedBy: typeof flag.markedBy === 'string' ? flag.markedBy : null,
    };
  }
  return out;
}

export async function readBoostedDates(): Promise<BoostedDates> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, KEY)).limit(1);
  return sanitize(row?.value);
}

/** Tick (commission = slider level) or untick (commission = null) one check-in date. */
export async function setBoostedDate(
  date: string,
  commission: number | null,
  markedBy: string | null,
): Promise<void> {
  if (commission === null) {
    await db.execute(sql`
      UPDATE app_settings
      SET value = value - ${date}::text, updated_at = now()
      WHERE key = ${KEY}
    `);
    return;
  }
  const patch = JSON.stringify({ [date]: { commission, markedAt: new Date().toISOString(), markedBy } });
  await db.execute(sql`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (${KEY}, ${patch}::jsonb, now())
    ON CONFLICT (key) DO UPDATE
      SET value = app_settings.value || EXCLUDED.value, updated_at = now()
  `);
}

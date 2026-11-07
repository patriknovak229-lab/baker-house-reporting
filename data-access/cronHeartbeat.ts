/**
 * Postgres access for cron liveness (utils/cronHeartbeat.ts).
 *
 * Lives in the generic `app_settings` table, same as the archive health
 * snapshot: the heartbeat has to survive the job's own subject matter being
 * broken or empty, which is exactly when it matters.
 */
import { inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { appSettings } from '@/lib/db/schema';
import type { CronHeartbeat } from '@/utils/cronHeartbeat';

const PREFIX = 'cron-heartbeat:';
const keyFor = (job: string) => `${PREFIX}${job}`;

const HISTORY_PREFIX = 'cron-history:';
/** Runs kept per job (~3 months of a daily job). */
export const CRON_HISTORY_LIMIT = 90;

/**
 * Record that `job` completed. Called on EVERY run, including no-op runs.
 * A run's terminal heartbeat (completed / failed) is also appended to the job's
 * history, so "how often does this job miss?" has an answer: the heartbeat
 * itself is overwritten every run.
 */
export async function writeCronHeartbeat(job: string, hb: CronHeartbeat): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key: keyFor(job), value: hb, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: hb, updatedAt: new Date() } });

  const phase = hb.summary?.phase;
  if (!hb.seeded && (phase === 'completed' || phase === 'failed')) {
    await appendCronHistory(job, { ranAt: hb.ranAt, phase, summary: hb.summary }).catch((err) =>
      console.error(`[cron/${job}] history append failed:`, err),
    );
  }
}

export interface CronHistoryEntry {
  ranAt: string;
  phase: string;
  summary?: Record<string, unknown>;
}

/** Atomic append + trim to the newest CRON_HISTORY_LIMIT entries (one statement). */
async function appendCronHistory(job: string, entry: CronHistoryEntry): Promise<void> {
  const key = `${HISTORY_PREFIX}${job}`;
  const item = JSON.stringify([entry]);
  await db.execute(sql`
    insert into app_settings (key, value, updated_at)
    values (${key}, ${item}::jsonb, now())
    on conflict (key) do update set
      value = (
        select coalesce(jsonb_agg(e order by i), '[]'::jsonb)
        from (
          select e, i
          from jsonb_array_elements(
            case when jsonb_typeof(app_settings.value) = 'array' then app_settings.value else '[]'::jsonb end
            || ${item}::jsonb
          ) with ordinality as t(e, i)
          order by i desc
          limit ${CRON_HISTORY_LIMIT}
        ) newest
      ),
      updated_at = now()
  `);
}

/** Recent runs per job, oldest first. Empty for a job with no history yet. */
export async function readCronHistory(jobs: string[]): Promise<Record<string, CronHistoryEntry[]>> {
  const out: Record<string, CronHistoryEntry[]> = Object.fromEntries(jobs.map((j) => [j, []]));
  if (jobs.length === 0) return out;
  const rows = await db
    .select()
    .from(appSettings)
    .where(inArray(appSettings.key, jobs.map((j) => `${HISTORY_PREFIX}${j}`)));
  for (const row of rows) {
    if (Array.isArray(row.value)) out[row.key.slice(HISTORY_PREFIX.length)] = row.value as CronHistoryEntry[];
  }
  return out;
}

/** Heartbeats for the given jobs, `null` for any we have never heard from. */
export async function readCronHeartbeats(
  jobs: string[],
): Promise<Record<string, CronHeartbeat | null>> {
  const out: Record<string, CronHeartbeat | null> = Object.fromEntries(jobs.map((j) => [j, null]));
  if (jobs.length === 0) return out;
  const rows = await db
    .select()
    .from(appSettings)
    .where(inArray(appSettings.key, jobs.map(keyFor)));
  for (const row of rows) {
    const job = row.key.slice(PREFIX.length);
    const value = row.value as Partial<CronHeartbeat> | undefined;
    if (typeof value?.ranAt === 'string') {
      out[job] = { ranAt: value.ranAt, summary: value.summary, seeded: value.seeded };
    }
  }
  return out;
}

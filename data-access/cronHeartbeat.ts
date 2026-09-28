/**
 * Postgres access for cron liveness (utils/cronHeartbeat.ts).
 *
 * Lives in the generic `app_settings` table, same as the archive health
 * snapshot: the heartbeat has to survive the job's own subject matter being
 * broken or empty, which is exactly when it matters.
 */
import { inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import { appSettings } from '@/lib/db/schema';
import type { CronHeartbeat } from '@/utils/cronHeartbeat';

const PREFIX = 'cron-heartbeat:';
const keyFor = (job: string) => `${PREFIX}${job}`;

/** Record that `job` completed. Called on EVERY run, including no-op runs. */
export async function writeCronHeartbeat(job: string, hb: CronHeartbeat): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key: keyFor(job), value: hb, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: hb, updatedAt: new Date() } });
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

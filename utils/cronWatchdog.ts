/**
 * The cron liveness watchdog: alerts when a watched Vercel cron job has gone
 * quiet or stops completing, and fires the daily catch-up as a backup when its
 * own delivery was dropped. See utils/cronHeartbeat and utils/cronCatchUp.
 *
 * Runs from app/api/webhook/watchdog, which cron-job.org calls every 5 minutes
 * — outside Vercel's scheduler, so it keeps ticking through the failure that
 * stops the crons. Self-throttled to one real check an hour (Redis), so being
 * called more often is free. Moved out of the guest-message webhook on
 * 2026-11-25: a safety check inside 3,000 lines of guest auto-reply code went
 * down with any bug in that code.
 */
import type { Redis } from '@upstash/redis';
import { WATCHED_CRON_JOBS, staleCronJobs, unseededCronJobs, staleCronAlert } from '@/utils/cronHeartbeat';
import { catchUpBackupDue } from '@/utils/cronCatchUp';
import { cronBaseUrl, cronDispatchHeaders } from '@/utils/cronAuth';
import { sendTechnicalAlert } from '@/utils/telegram';

/** Throttles the DB read — a 36h threshold does not need a check every 30s. */
const CRON_CHECK_KEY = 'baker:cron-watchdog:checked';
const CRON_CHECK_EVERY_MS = 60 * 60 * 1000; // 1h
/** One alert per job per day: a dead cron stays dead, and hourly nagging about
 *  it would train the operator to ignore the channel. */
const CRON_ALERT_TTL_SECONDS = 24 * 60 * 60;

/**
 * Alert when a watched Vercel cron job has gone quiet. See utils/cronHeartbeat.
 *
 * Jobs we have never heard from are SEEDED rather than alerted on: on first
 * deploy no job has a heartbeat, and firing immediately would be noise. The
 * seed is the baseline the next check measures against, so a job that then
 * fails to run still trips the alarm one window later.
 */
export async function checkCronLiveness(redis: Redis): Promise<void> {
  const last = await redis.get<number>(CRON_CHECK_KEY);
  if (last && Date.now() - last < CRON_CHECK_EVERY_MS) return;
  await redis.set(CRON_CHECK_KEY, Date.now(), { ex: 7200 });

  // Lazily imported so the Postgres client stays off the callers' hot path —
  // the check runs at most hourly and shouldn't weigh on every cold start.
  const { readCronHeartbeats, writeCronHeartbeat } = await import('@/data-access/cronHeartbeat');

  const jobs = WATCHED_CRON_JOBS.map((j) => j.job);
  const heartbeats = await readCronHeartbeats(jobs);

  for (const job of unseededCronJobs(heartbeats)) {
    await writeCronHeartbeat(job, { ranAt: new Date().toISOString(), seeded: true });
    console.log(`[cron watchdog] seeded baseline for ${job}`);
  }

  await fireCatchUpBackupIfDue(redis, heartbeats['catch-up']);

  const stale = staleCronJobs(heartbeats, new Date());
  if (stale.length === 0) return;

  // Drop any we have already shouted about today.
  const fresh: typeof stale = [];
  for (const s of stale) {
    const key = `baker:cron-watchdog:alerted:${s.job}`;
    if (await redis.get(key)) continue;
    await redis.set(key, 1, { ex: CRON_ALERT_TTL_SECONDS });
    fresh.push(s);
  }

  const body = staleCronAlert(fresh);
  if (body) {
    // Technical chat, not the ops group (operator request 2026-11-08).
    await sendTechnicalAlert(body);
    console.warn(`[cron watchdog] ${fresh.map((s) => s.job).join(', ')} silent`);
  }
}

/**
 * Backup trigger for the daily catch-up (app/api/cron/catch-up). That route is
 * a Vercel cron too, so its own delivery can be dropped, the one failure it
 * exists to absorb. This watchdog runs on the cron-job.org 5-minute ping,
 * outside Vercel's scheduler, so from 14:00 UTC it fires the catch-up if it
 * hasn't run today. Once a day at most (Redis NX).
 *
 * Fire-and-forget on purpose: the catch-up can take minutes (it re-runs jobs
 * with 300s budgets) and this route has 60s. The short timeout only drops OUR
 * wait; Vercel keeps the called function running after the caller disconnects
 * unless `supportsCancellation` is configured, which this project doesn't do.
 */
async function fireCatchUpBackupIfDue(
  redis: Redis,
  hb: Parameters<typeof catchUpBackupDue>[0],
): Promise<void> {
  const now = new Date();
  if (!catchUpBackupDue(hb, now)) return;
  const key = `baker:cron-catchup:backup-fired:${now.toISOString().slice(0, 10)}`;
  const first = await redis.set(key, 1, { nx: true, ex: 26 * 60 * 60 });
  if (first === null) return;
  console.warn('[cron watchdog] catch-up has not run today — firing it as a backup');
  await fetch(`${cronBaseUrl()}/api/cron/catch-up`, {
    headers: cronDispatchHeaders(),
    cache: 'no-store',
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {
    // Expected: we stop waiting after 5s while the catch-up keeps running.
  });
}

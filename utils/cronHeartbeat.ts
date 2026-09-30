/**
 * Liveness for the Vercel cron jobs.
 *
 * Every alert these jobs have — Telegram on send failures, the bookings-archive
 * health check, the deferred-mail warning — only fires if the job actually
 * RUNS. Nothing watched for the job not running at all, which is precisely how
 * `send-due-invoices` stayed dead from the day it was written until 2026-09-28:
 * the auth middleware 307'd every cron request to /login, no handler executed,
 * and the only symptom was invoices quietly not arriving. See
 * `proxy.ts`'s matcher comment.
 *
 * So each run records a heartbeat, including a run that found nothing to do —
 * that's the important case, because otherwise "ran, queue empty" and "never
 * ran" leave identical traces (i.e. none).
 *
 * WHO WATCHES: deliberately NOT the cron itself. The bookings-archive check is
 * the cautionary tale — it was parked inside this same cron reasoning that
 * "without this nothing would ever tell us", and so it never fired either. A
 * watchdog inside the thing it watches is not a watchdog. This one is checked
 * from the auto-reply webhook poll, which is driven by the dashboard every ~30s
 * AND by an external cron-job.org ping every 5 minutes — outside Vercel's cron
 * scheduler and outside the middleware, so it survives the exact failure that
 * takes the crons down.
 */

/** A cron job we expect to hear from, and how long silence is tolerable. */
export interface WatchedCronJob {
  job: string;
  /** Human name for the alert. */
  label: string;
  /** Alert once silence passes this. Generous enough to absorb one missed run. */
  maxAgeHours: number;
}

/**
 * Daily jobs get 36h: a full day plus most of another, so a single skipped or
 * late run is not an alert, but two in a row is.
 */
export const WATCHED_CRON_JOBS: WatchedCronJob[] = [
  { job: 'send-due-invoices', label: 'Invoice auto-send (09:00)', maxAgeHours: 36 },
  { job: 'check-reviews', label: 'Review sync (08:00)', maxAgeHours: 36 },
];

export interface CronHeartbeat {
  /** ISO timestamp of the last INVOCATION (not necessarily a successful one). */
  ranAt: string;
  /** Whatever the job wants on the record — counts, mostly. Never load-bearing.
   *  `summary.phase` carries 'started' | 'completed' | 'failed' when the job
   *  reports it; absent means a legacy write and is treated as completed. */
  summary?: Record<string, unknown>;
  /** True when this row was written by the watchdog to establish a baseline
   *  rather than by a real run. Keeps a fresh deploy from alerting instantly. */
  seeded?: boolean;
}

/**
 * A run that dies partway now writes a heartbeat too — otherwise a failure and
 * a no-show leave the same (absent) trace. But that means freshness alone no
 * longer proves health: a job timing out daily would keep stamping `started`
 * and look alive forever. So a heartbeat that has not reached `completed`
 * counts as a failure once this much time has passed. Generous next to a 60s
 * maxDuration, so a genuinely in-flight run is never flagged.
 */
const NOT_COMPLETING_AFTER_HOURS = 2;

export interface StaleCronJob {
  job: string;
  label: string;
  /** null when we have never heard from it at all. */
  lastRanAt: string | null;
  hoursSilent: number | null;
  /** 'silent' = not invoked at all. 'not-completing' = invoked, never finishes. */
  reason: 'silent' | 'not-completing';
  /** Error text from the job, when it reported one. */
  error?: string;
}

/**
 * Which watched jobs have gone quiet. Pure so the thresholds are testable
 * without a database or a clock.
 *
 * A job with no heartbeat at all is NOT reported: the caller seeds a baseline
 * for it instead. That avoids crying wolf the moment this ships (no job has
 * ever written one), while still catching a job that goes on to miss its
 * window — the seed is what the next check measures against.
 */
export function staleCronJobs(
  heartbeats: Record<string, CronHeartbeat | null>,
  now: Date,
  jobs: WatchedCronJob[] = WATCHED_CRON_JOBS,
): StaleCronJob[] {
  const out: StaleCronJob[] = [];
  for (const { job, label, maxAgeHours } of jobs) {
    const hb = heartbeats[job];
    if (!hb?.ranAt) continue; // no baseline yet — caller seeds, doesn't alert
    const ms = now.getTime() - new Date(hb.ranAt).getTime();
    if (!Number.isFinite(ms)) continue; // unparseable timestamp: don't alert on junk
    const hoursSilent = ms / 3_600_000;
    const base = { job, label, lastRanAt: hb.ranAt, hoursSilent: Math.round(hoursSilent) };

    if (hoursSilent > maxAgeHours) {
      out.push({ ...base, reason: 'silent' });
      continue;
    }

    // Invoked recently, but never got to the end. A missing phase is a legacy
    // write from before phases existed — treat as healthy rather than alarm on
    // old rows.
    const phase = hb.summary?.phase;
    if (phase != null && phase !== 'completed' && hoursSilent > NOT_COMPLETING_AFTER_HOURS) {
      const error = hb.summary?.error;
      out.push({
        ...base,
        reason: 'not-completing',
        ...(typeof error === 'string' ? { error } : {}),
      });
    }
  }
  return out;
}

/** Watched jobs we have never heard from — the caller seeds these. */
export function unseededCronJobs(
  heartbeats: Record<string, CronHeartbeat | null>,
  jobs: WatchedCronJob[] = WATCHED_CRON_JOBS,
): string[] {
  return jobs.filter(({ job }) => !heartbeats[job]?.ranAt).map(({ job }) => job);
}

/** Telegram body for a set of unhealthy jobs. Null when there is nothing to say. */
export function staleCronAlert(stale: StaleCronJob[]): string | null {
  if (stale.length === 0) return null;
  const lines = [
    '⚠️ A scheduled job is not doing its work:',
    ...stale.map((s) => {
      const when = `${s.lastRanAt?.slice(0, 16).replace('T', ' ')} UTC`;
      return s.reason === 'silent'
        ? `• ${s.label} — not invoked for ${s.hoursSilent}h (last ${when})`
        : `• ${s.label} — invoked ${s.hoursSilent}h ago but never finished${s.error ? `: ${s.error}` : ''} (${when})`;
    }),
    '',
    // The diagnosis that took two days and three separate causes to find.
    'If it is not being invoked, probe the path with a plain GET:',
    '  401 = healthy · 405 = route is POST-only, Vercel cron sends GET',
    '  307 = the auth middleware is eating it again (see proxy.ts)',
    'Note this project is on Vercel Hobby: cron timing is ±59 min, so allow the',
    'full hour past the schedule before calling a run missing.',
  ];
  return lines.join('\n');
}

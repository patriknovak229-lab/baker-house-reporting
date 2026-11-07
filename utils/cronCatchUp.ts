/**
 * Daily catch-up for missed or failed cron runs — the pure half (no I/O).
 *
 * Why: Vercel cron delivery is "best effort". A dropped delivery leaves no log,
 * the function never executes, and Vercel never retries ("Cron job delivery and
 * idempotency" in the cron docs). On Hobby every job runs once a day, so one
 * dropped delivery used to cost a whole day — 6 Nov 2026, invoice auto-send:
 * nothing recorded at all, noticed only by the 36h watchdog that evening.
 *
 * How: once a day (app/api/cron/catch-up, 12:00 UTC, with a backup trigger
 * from the webhook watchdog) every job's most recent window is checked. A job
 * with no completed run in it is re-run per its CatchUpPolicy, and one Telegram
 * says what was missed and how it ended.
 */

import type { CronHeartbeat, WatchedCronJob } from '@/utils/cronHeartbeat';

/** Hobby invokes a job anywhere in the scheduled hour ("±59 min" in the docs). */
export const HOBBY_WINDOW_MINUTES = 60;
/** Allowance for a run that starts late in the window to finish (max 300s jobs). */
export const RUN_GRACE_MINUTES = 15;

/** The catch-up's own schedule hour (UTC) and when the backup trigger may fire it. */
export const CATCH_UP_HOUR_UTC = 12;
export const CATCH_UP_BACKUP_HOUR_UTC = 14;

/** Parse a daily "M H * * *" expression. Null for anything else. */
export function parseDailySchedule(expr: string | undefined): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec((expr ?? '').trim());
  if (!m) return null;
  const minute = Number(m[1]);
  const hour = Number(m[2]);
  if (minute > 59 || hour > 23) return null;
  return { hour, minute };
}

/**
 * Start of the most recent scheduled window that has fully closed (window +
 * grace) by `now`. Today's if it's over, otherwise yesterday's.
 */
export function latestClosedWindowStart(
  schedule: { hour: number; minute: number },
  now: Date,
): Date {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), schedule.hour, schedule.minute),
  );
  const closesAt = start.getTime() + (HOBBY_WINDOW_MINUTES + RUN_GRACE_MINUTES) * 60_000;
  if (closesAt > now.getTime()) start.setUTCDate(start.getUTCDate() - 1);
  return start;
}

export type CatchUpAction =
  /** Completed in its window. */
  | 'ok'
  /** No heartbeat ever: nothing to measure against yet (the watchdog seeds one). */
  | 'no-baseline'
  /** Never invoked in its window → re-run. */
  | 'rerun-missed'
  /** Invoked but didn't complete, and the policy allows a retry → re-run. */
  | 'rerun-failed'
  /** Invoked but didn't complete, and a blind retry could duplicate side effects. */
  | 'needs-human';

export interface CatchUpItem {
  job: string;
  label: string;
  path: string;
  action: CatchUpAction;
  windowStart: string;
  lastRanAt: string | null;
  lastPhase: string | null;
  error?: string;
}

function phaseOf(hb: CronHeartbeat): string {
  if (hb.seeded) return 'seeded';
  const p = hb.summary?.phase;
  return typeof p === 'string' ? p : 'completed'; // legacy writes had no phase
}

/**
 * Which jobs need re-running right now, and why. Jobs with policy 'never' (the
 * catch-up itself) are left out: they're the watchdog's to watch.
 */
export function planCatchUp(
  heartbeats: Record<string, CronHeartbeat | null>,
  now: Date,
  jobs: WatchedCronJob[],
): CatchUpItem[] {
  const out: CatchUpItem[] = [];
  for (const j of jobs) {
    const schedule = parseDailySchedule(j.schedule);
    const policy = j.catchUp ?? 'never';
    if (!j.path || !schedule || policy === 'never') continue;
    const windowStart = latestClosedWindowStart(schedule, now);
    const hb = heartbeats[j.job] ?? null;
    const base = {
      job: j.job,
      label: j.label,
      path: j.path,
      windowStart: windowStart.toISOString(),
      lastRanAt: hb?.ranAt ?? null,
      lastPhase: hb ? phaseOf(hb) : null,
    };
    if (!hb?.ranAt) {
      out.push({ ...base, action: 'no-baseline' });
      continue;
    }
    const ranAt = new Date(hb.ranAt).getTime();
    if (!Number.isFinite(ranAt)) {
      out.push({ ...base, action: 'no-baseline' });
      continue;
    }
    const phase = phaseOf(hb);

    if (ranAt < windowStart.getTime()) {
      // Nothing at all since the window opened. A seed written before the
      // window is a baseline, not a run, so it counts as missed too.
      out.push({ ...base, action: 'rerun-missed' });
      continue;
    }
    if (phase === 'completed' || phase === 'seeded') {
      out.push({ ...base, action: 'ok' });
      continue;
    }
    const error = typeof hb.summary?.error === 'string' ? hb.summary.error : undefined;
    const action: CatchUpAction = policy === 'missed-or-failed' ? 'rerun-failed' : 'needs-human';
    out.push({ ...base, action, ...(error ? { error } : {}) });
  }
  return out;
}

export const isRerun = (a: CatchUpAction) => a === 'rerun-missed' || a === 'rerun-failed';

/**
 * Backup trigger for the catch-up itself (it is a Vercel cron too, so its own
 * delivery can be dropped): due from 14:00 UTC when the catch-up hasn't run
 * since today's 12:00 window opened. The webhook watchdog checks this hourly
 * and fires at most once a day.
 */
export function catchUpBackupDue(hb: CronHeartbeat | null | undefined, now: Date): boolean {
  if (now.getUTCHours() < CATCH_UP_BACKUP_HOUR_UTC) return false;
  const todaysWindow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), CATCH_UP_HOUR_UTC);
  if (!hb?.ranAt) return true;
  const ranAt = new Date(hb.ranAt).getTime();
  return !Number.isFinite(ranAt) || ranAt < todaysWindow;
}

/** How a re-run ended, as observed from the job's heartbeat afterwards. */
export interface CatchUpOutcome extends CatchUpItem {
  /** Set for re-run jobs only. */
  result?: 'recovered' | 'still-failing';
  httpStatus?: number | null;
  detail?: string;
}

const hhmm = (iso: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : 'never');

/**
 * Telegram body (HTML parse mode) — null when every job was fine, so a normal
 * day sends nothing. `escape` is injected to keep this module import-free.
 */
export function catchUpReport(items: CatchUpOutcome[], escape: (s: string) => string): string | null {
  const notable = items.filter((i) => i.action !== 'ok' && i.action !== 'no-baseline');
  if (notable.length === 0) return null;
  const lines = ['🔁 <b>Daily cron catch-up</b>'];
  for (const i of notable) {
    const label = escape(i.label);
    if (isRerun(i.action)) {
      const why = i.action === 'rerun-missed' ? `missed its run (last ${hhmm(i.lastRanAt)})` : `failed${i.error ? `: ${escape(i.error)}` : ''}`;
      if (i.result === 'recovered') {
        lines.push(`✅ ${label} ${why} → re-ran, completed${i.detail ? ` (${escape(i.detail)})` : ''}.`);
      } else {
        lines.push(
          `❌ ${label} ${why} → re-run did not complete${i.httpStatus ? ` (HTTP ${i.httpStatus})` : ''}${i.detail ? `: ${escape(i.detail)}` : ''}. Needs a look.`,
        );
      }
    } else {
      lines.push(
        `⚠️ ${label} started ${hhmm(i.lastRanAt)} but never finished${i.error ? `: ${escape(i.error)}` : ''}. ` +
          'Not re-run automatically: part of its work may already be done (e.g. invoices emailed but not marked Sent). Check before running it by hand.',
      );
    }
  }
  return lines.join('\n');
}

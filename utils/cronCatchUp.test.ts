import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { WATCHED_CRON_JOBS, type CronHeartbeat, type WatchedCronJob } from './cronHeartbeat';
import {
  catchUpBackupDue,
  catchUpReport,
  latestClosedWindowStart,
  parseDailySchedule,
  planCatchUp,
  type CatchUpOutcome,
} from './cronCatchUp';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const at = (iso: string) => new Date(iso);
const hb = (ranAt: string, phase?: string, extra: Record<string, unknown> = {}): CronHeartbeat => ({
  ranAt,
  summary: phase ? { phase, ...extra } : undefined,
});

const INVOICES: WatchedCronJob = {
  job: 'send-due-invoices', label: 'Invoice auto-send', maxAgeHours: 36,
  path: '/api/cron/send-due-invoices', schedule: '0 9 * * *', catchUp: 'missed-only',
};
const REVIEWS: WatchedCronJob = {
  job: 'check-reviews', label: 'Review sync', maxAgeHours: 36,
  path: '/api/cron/check-reviews', schedule: '0 8 * * *', catchUp: 'missed-or-failed',
};
const SELF: WatchedCronJob = {
  job: 'catch-up', label: 'Catch-up', maxAgeHours: 36,
  path: '/api/cron/catch-up', schedule: '0 12 * * *', catchUp: 'never',
};
const JOBS = [INVOICES, REVIEWS, SELF];

describe('schedule windows', () => {
  it('parses daily expressions only', () => {
    expect(parseDailySchedule('0 9 * * *')).toEqual({ hour: 9, minute: 0 });
    expect(parseDailySchedule('15 1 * * *')).toEqual({ hour: 1, minute: 15 });
    expect(parseDailySchedule('*/5 * * * *')).toBeNull();
    expect(parseDailySchedule('0 9 * * 1')).toBeNull();
    expect(parseDailySchedule(undefined)).toBeNull();
  });

  it('a window counts only once the Hobby hour plus grace is over', () => {
    const nine = { hour: 9, minute: 0 };
    // 10:10 — window 09:00–10:15 still open → yesterday's is the latest closed one
    expect(latestClosedWindowStart(nine, at('2026-11-06T10:10:00Z')).toISOString()).toBe('2026-11-05T09:00:00.000Z');
    expect(latestClosedWindowStart(nine, at('2026-11-06T10:15:00Z')).toISOString()).toBe('2026-11-06T09:00:00.000Z');
    expect(latestClosedWindowStart(nine, at('2026-11-06T12:00:00Z')).toISOString()).toBe('2026-11-06T09:00:00.000Z');
  });
});

describe('planCatchUp', () => {
  const noon = at('2026-11-06T12:05:00Z');
  const action = (heartbeats: Record<string, CronHeartbeat | null>, job = 'send-due-invoices') =>
    planCatchUp(heartbeats, noon, JOBS).find((i) => i.job === job)?.action;

  it('the 6 Nov case: last run 5 Nov 09:44, nothing since → re-run', () => {
    expect(action({ 'send-due-invoices': hb('2026-11-05T09:44:39Z', 'completed') })).toBe('rerun-missed');
  });

  it('completed inside today\'s window → nothing to do', () => {
    expect(action({ 'send-due-invoices': hb('2026-11-06T09:44:00Z', 'completed') })).toBe('ok');
  });

  it('invoice run that started but never finished is a human call, not a re-run', () => {
    expect(action({ 'send-due-invoices': hb('2026-11-06T09:12:00Z', 'started') })).toBe('needs-human');
    expect(action({ 'send-due-invoices': hb('2026-11-06T09:12:00Z', 'failed', { error: 'x' }) })).toBe('needs-human');
  });

  it('a failed sync job is retried', () => {
    expect(action({ 'check-reviews': hb('2026-11-06T08:20:00Z', 'failed', { error: 'Beds24 503' }) }, 'check-reviews')).toBe('rerun-failed');
  });

  it('legacy heartbeat without a phase counts as completed', () => {
    expect(action({ 'check-reviews': hb('2026-11-06T08:20:00Z') }, 'check-reviews')).toBe('ok');
  });

  it('no heartbeat ever → no baseline, never a blind run', () => {
    expect(action({})).toBe('no-baseline');
  });

  it('a seed is a baseline, not a run', () => {
    expect(action({ 'send-due-invoices': { ranAt: '2026-11-05T15:00:00Z', seeded: true } })).toBe('rerun-missed');
    expect(action({ 'send-due-invoices': { ranAt: '2026-11-06T09:30:00Z', seeded: true } })).toBe('ok');
  });

  it('never plans the catch-up job itself', () => {
    expect(planCatchUp({ 'catch-up': hb('2026-11-06T12:01:00Z', 'started') }, noon, JOBS).map((i) => i.job)).not.toContain('catch-up');
  });
});

describe('catchUpBackupDue', () => {
  it('only from 14:00 UTC, and only when the catch-up has not run since 12:00', () => {
    expect(catchUpBackupDue(null, at('2026-11-07T13:59:00Z'))).toBe(false);
    expect(catchUpBackupDue(null, at('2026-11-07T14:00:00Z'))).toBe(true);
    expect(catchUpBackupDue(hb('2026-11-06T12:30:00Z', 'completed'), at('2026-11-07T15:00:00Z'))).toBe(true);
    expect(catchUpBackupDue(hb('2026-11-07T12:30:00Z', 'completed'), at('2026-11-07T15:00:00Z'))).toBe(false);
  });
});

describe('catchUpReport', () => {
  const base = { job: 'send-due-invoices', label: 'Invoice <auto-send>', path: '/x', windowStart: '', lastRanAt: '2026-11-05T09:44:39Z', lastPhase: 'completed' };

  it('says nothing on a normal day', () => {
    expect(catchUpReport([{ ...base, action: 'ok' }, { ...base, action: 'no-baseline' }], esc)).toBeNull();
  });

  it('reports a recovered miss with what the re-run did', () => {
    const text = catchUpReport([{ ...base, action: 'rerun-missed', result: 'recovered', httpStatus: 200, detail: 'sent 1' } as CatchUpOutcome], esc)!;
    expect(text).toContain('Invoice &lt;auto-send&gt; missed its run (last 2026-11-05 09:44 UTC)');
    expect(text).toContain('re-ran, completed (sent 1)');
  });

  it('reports a re-run that failed, and a run left for a human', () => {
    const failed = catchUpReport([{ ...base, action: 'rerun-missed', result: 'still-failing', httpStatus: 307, detail: 'HTTP 307' } as CatchUpOutcome], esc)!;
    expect(failed).toContain('re-run did not complete (HTTP 307)');
    const human = catchUpReport([{ ...base, action: 'needs-human', lastPhase: 'started' }], esc)!;
    expect(human).toContain('Not re-run automatically');
  });
});

// ── The registry must match what is actually deployed ──
// Each mismatch below is a cron that silently never runs: a job missing from
// vercel.json, a path the auth middleware 307s, or a route without GET.
describe('WATCHED_CRON_JOBS matches vercel.json, proxy.ts and the routes', () => {
  const root = path.resolve(__dirname, '..');
  const vercel = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8')) as {
    crons: { path: string; schedule: string }[];
  };
  const proxy = readFileSync(path.join(root, 'proxy.ts'), 'utf8');
  const matcher = /matcher:\s*\[\s*'([^']+)'/.exec(proxy)?.[1] ?? '';
  // Deliberately not running (charges guests; business decision pending) — see proxy.ts.
  const DISABLED = new Set(['/api/cron/send-scheduled-payments']);

  it('every scheduled job is registered with the same schedule', () => {
    for (const c of vercel.crons.filter((c) => !DISABLED.has(c.path))) {
      const job = WATCHED_CRON_JOBS.find((j) => j.path === c.path);
      expect(job, `${c.path} is in vercel.json but not in WATCHED_CRON_JOBS`).toBeDefined();
      expect(job!.schedule, c.path).toBe(c.schedule);
    }
  });

  it('every registered job is scheduled, parses, and is exempt from the auth middleware', () => {
    expect(matcher).not.toBe('');
    for (const j of WATCHED_CRON_JOBS) {
      expect(vercel.crons.some((c) => c.path === j.path), `${j.job} not in vercel.json`).toBe(true);
      expect(parseDailySchedule(j.schedule), `${j.job} schedule`).not.toBeNull();
      expect(matcher.includes(`|${j.path!.slice(1)}`), `${j.path} is not exempt in proxy.ts`).toBe(true);
    }
  });

  it('every registered route exists and exports GET (Vercel cron sends GET)', () => {
    for (const j of WATCHED_CRON_JOBS) {
      const file = path.join(root, 'app', j.path!, 'route.ts');
      expect(existsSync(file), file).toBe(true);
      expect(readFileSync(file, 'utf8'), `${j.path} has no GET export`).toMatch(/export (const|async function) GET\b/);
    }
  });
});

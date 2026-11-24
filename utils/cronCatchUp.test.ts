import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { WATCHED_CRON_JOBS, type CronHeartbeat, type WatchedCronJob } from './cronHeartbeat';
import {
  catchUpBackupDue,
  catchUpReport,
  catchUpTaskText,
  latestClosedWindowStart,
  parseSchedule,
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
  it('parses daily and weekly expressions only', () => {
    expect(parseSchedule('0 9 * * *')).toEqual({ hour: 9, minute: 0, weekday: null });
    expect(parseSchedule('15 1 * * *')).toEqual({ hour: 1, minute: 15, weekday: null });
    expect(parseSchedule('30 6 * * 1')).toEqual({ hour: 6, minute: 30, weekday: 1 });
    expect(parseSchedule('0 9 * * 7')).toEqual({ hour: 9, minute: 0, weekday: 0 }); // 7 = Sunday
    expect(parseSchedule('*/5 * * * *')).toBeNull();
    expect(parseSchedule('0 9 1 * *')).toBeNull();
    expect(parseSchedule('0 9 * * 1-5')).toBeNull();
    expect(parseSchedule(undefined)).toBeNull();
  });

  it('a weekly window is the latest matching weekday that has closed', () => {
    const monday = { hour: 6, minute: 30, weekday: 1 };
    // Mon 23 Nov 2026, 07:30 — today's window (06:30–07:45) still open → the previous Monday
    expect(latestClosedWindowStart(monday, at('2026-11-23T07:30:00Z')).toISOString()).toBe('2026-11-16T06:30:00.000Z');
    expect(latestClosedWindowStart(monday, at('2026-11-23T12:00:00Z')).toISOString()).toBe('2026-11-23T06:30:00.000Z');
    // Saturday → back to Monday of that week
    expect(latestClosedWindowStart(monday, at('2026-11-28T12:00:00Z')).toISOString()).toBe('2026-11-23T06:30:00.000Z');
  });

  it('a window counts only once the Hobby hour plus grace is over', () => {
    const nine = { hour: 9, minute: 0, weekday: null };
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

  it('a completed run with an upstream gap is retried quietly — only where retries are allowed', () => {
    const gap = hb('2026-11-06T08:20:00Z', 'completed', { degraded: ['urban-1kk'] });
    expect(action({ 'check-reviews': gap }, 'check-reviews')).toBe('rerun-degraded');
    expect(action({ 'send-due-invoices': hb('2026-11-06T09:44:00Z', 'completed', { degraded: ['x'] }) })).toBe('ok');
    expect(action({ 'check-reviews': hb('2026-11-06T08:20:00Z', 'completed', { degraded: [] }) }, 'check-reviews')).toBe('ok');
  });

  it('weekly market refresh: a missed Monday is re-run, and a degraded one is retried daily until clean', () => {
    const MARKET: WatchedCronJob = {
      job: 'market-refresh', label: 'Market', maxAgeHours: 192,
      path: '/api/analytics/market/refresh', schedule: '30 6 * * 1', catchUp: 'missed-or-failed',
    };
    const plan = (h: CronHeartbeat, nowIso: string) => planCatchUp({ 'market-refresh': h }, at(nowIso), [MARKET])[0].action;
    // Mon 23 Nov 12:05: last run the previous Monday → this Monday was missed
    expect(plan(hb('2026-11-16T06:53:00Z', 'completed'), '2026-11-23T12:05:00Z')).toBe('rerun-missed');
    // Wed: Monday ran clean → nothing to do all week
    expect(plan(hb('2026-11-23T06:53:00Z', 'completed'), '2026-11-25T12:05:00Z')).toBe('ok');
    // Tue: Monday's retry still had a PriceLabs gap → retry again
    expect(plan(hb('2026-11-23T12:44:00Z', 'completed', { degraded: ['k201'] }), '2026-11-24T12:05:00Z')).toBe('rerun-degraded');
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

  it('turns only the outcomes a human must settle into dashboard tasks', () => {
    const human = catchUpTaskText({ ...base, action: 'needs-human', lastPhase: 'started', lastRanAt: '2026-11-06T09:12:00Z' })!;
    expect(human).toContain('Invoice <auto-send>: started 2026-11-06 09:12 UTC but never finished');
    expect(human).toContain('Check what went out');
    const broke = catchUpTaskText({ ...base, action: 'rerun-missed', result: 'still-failing', httpStatus: 500, detail: 'DB down' })!;
    expect(broke).toContain('re-run did not complete (HTTP 500): DB down');
    expect(catchUpTaskText({ ...base, action: 'rerun-degraded', result: 'still-failing' })).not.toBeNull();
    // Fixed itself, or nothing to do → no task
    expect(catchUpTaskText({ ...base, action: 'rerun-missed', result: 'recovered' })).toBeNull();
    expect(catchUpTaskText({ ...base, action: 'rerun-degraded', result: 'still-degraded' })).toBeNull();
    expect(catchUpTaskText({ ...base, action: 'ok' })).toBeNull();
  });

  it('a degraded re-run says nothing unless the re-run itself broke', () => {
    const degraded = { ...base, action: 'rerun-degraded' as const };
    expect(catchUpReport([{ ...degraded, result: 'recovered' }], esc)).toBeNull();
    expect(catchUpReport([{ ...degraded, result: 'still-degraded' }], esc)).toBeNull();
    const broke = catchUpReport([{ ...degraded, result: 'still-failing', httpStatus: 500, detail: 'DB down' }], esc)!;
    expect(broke).toContain('was missing upstream data → re-run did not complete (HTTP 500): DB down');
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
  // Scheduled paths deliberately left out of the registry. Empty since
  // send-scheduled-payments was switched on (45daecd, 2026-11-18).
  const DISABLED = new Set<string>();

  it('every scheduled job is registered with the same schedule', () => {
    for (const c of vercel.crons.filter((c) => !DISABLED.has(c.path))) {
      const job = WATCHED_CRON_JOBS.find((j) => j.path === c.path);
      expect(job, `${c.path} is in vercel.json but not in WATCHED_CRON_JOBS`).toBeDefined();
      expect([job!.schedule, ...(job!.extraSchedules ?? [])], c.path).toContain(c.schedule);
    }
  });

  it('every registered job is scheduled, parses, and is exempt from the auth middleware', () => {
    expect(matcher).not.toBe('');
    for (const j of WATCHED_CRON_JOBS) {
      expect(vercel.crons.some((c) => c.path === j.path), `${j.job} not in vercel.json`).toBe(true);
      expect(parseSchedule(j.schedule), `${j.job} schedule`).not.toBeNull();
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

/**
 * GET|POST /api/cron/catch-up[?dryRun=1]
 *
 * Once a day (vercel.json, 12:00 UTC): re-runs any scheduled job whose window
 * closed without a completed run, then sends ONE Telegram saying what was
 * missed and how the re-run ended. A normal day sends nothing.
 *
 * Why it exists: Vercel cron delivery is best effort, a dropped delivery leaves
 * no trace, and nothing retries it. On 6 Nov 2026 the 09:00 invoice run simply
 * never happened, and the only signal was the 36h watchdog that evening. Every
 * daily job here tolerates a late run, so "once a day, re-run what was missed"
 * turns a lost day into a few hours' delay. Decisions are in utils/cronCatchUp.
 *
 * Each re-run is a real HTTP call to the job's own route with the CRON_SECRET
 * bearer, so it runs in its own function with its own maxDuration, its own
 * overlap lock and its own heartbeat — exactly like a scheduled run. Afterwards
 * the job's heartbeat is re-read: "completed since we called it" is the only
 * thing that counts as recovered.
 *
 * Its own delivery can be dropped too, so the webhook watchdog (driven every
 * 5 minutes by cron-job.org, outside Vercel's scheduler) fires this route as a
 * backup from 14:00 UTC if it hasn't run today. `?dryRun=1` returns the plan
 * plus recent run history without re-running or notifying anything.
 *
 * Auth: platform cron via utils/cronAuth (exempted in proxy.ts); manual = admin/super.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { cronAuth, cronBaseUrl, cronDispatchHeaders } from '@/utils/cronAuth';
import { readCronHeartbeats, readCronHistory, writeCronHeartbeat } from '@/data-access/cronHeartbeat';
import { WATCHED_CRON_JOBS } from '@/utils/cronHeartbeat';
import { catchUpReport, isRerun, planCatchUp, type CatchUpOutcome } from '@/utils/cronCatchUp';
import { withCronLock } from '@/utils/cronLock';
import { escapeHtml, sendTechnicalAlert } from '@/utils/telegram';

// Re-runs happen in parallel; the slowest jobs (reviews, market refresh) allow
// 300s, so this waits up to just under that for each.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const JOB = 'catch-up';
const RERUN_TIMEOUT_MS = 285_000;

async function run(req: NextRequest) {
  const { isCron } = cronAuth(req, JOB);
  if (!isCron) {
    const guard = await requireRole(['admin', 'super']);
    if ('error' in guard) return guard.error;
  }

  const jobs = WATCHED_CRON_JOBS;
  if (req.nextUrl.searchParams.get('dryRun') === '1') {
    const names = jobs.map((j) => j.job);
    const [heartbeats, history] = await Promise.all([readCronHeartbeats(names), readCronHistory(names)]);
    return NextResponse.json({ plan: planCatchUp(heartbeats, new Date(), jobs), heartbeats, history });
  }

  return withCronLock(JOB, maxDuration + 30, () => catchUp());
}

async function catchUp(): Promise<Response> {
  await beat({ phase: 'started' });
  try {
    const jobs = WATCHED_CRON_JOBS;
    const names = jobs.map((j) => j.job);
    const plan = planCatchUp(await readCronHeartbeats(names), new Date(), jobs);
    const reruns = plan.filter((i) => isRerun(i.action));

    const dispatchedAt = Date.now();
    const http = await Promise.all(reruns.map((i) => rerun(i.path)));
    const after = reruns.length > 0 ? await readCronHeartbeats(reruns.map((i) => i.job)) : {};

    const outcomes: CatchUpOutcome[] = plan.map((item) => {
      const idx = reruns.indexOf(item);
      if (idx < 0) return item;
      const hb = after[item.job];
      const ranAt = hb?.ranAt ? new Date(hb.ranAt).getTime() : 0;
      const phase = hb?.summary?.phase;
      const recovered = ranAt >= dispatchedAt - 5_000 && (phase === 'completed' || phase == null);
      return {
        ...item,
        result: recovered ? 'recovered' : 'still-failing',
        httpStatus: http[idx].status,
        detail: recovered ? summarize(hb?.summary) : (stringOr(hb?.summary?.error) ?? http[idx].error),
      };
    });

    const report = catchUpReport(outcomes, escapeHtml);
    if (report) await sendTechnicalAlert(report);

    const pick = (pred: (o: CatchUpOutcome) => boolean) => outcomes.filter(pred).map((o) => o.job);
    const summary = {
      phase: 'completed',
      checked: plan.length,
      recovered: pick((o) => o.result === 'recovered'),
      stillFailing: pick((o) => o.result === 'still-failing'),
      needsHuman: pick((o) => o.action === 'needs-human'),
      noBaseline: pick((o) => o.action === 'no-baseline'),
    };
    await beat(summary);
    return NextResponse.json({ ok: true, ...summary, outcomes });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[cron/${JOB}]`, err);
    await beat({ phase: 'failed', error: message });
    await sendTechnicalAlert(`⚠️ Daily cron catch-up crashed: ${escapeHtml(message)}`).catch(() => {});
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Call a job's own route the way Vercel would. Never throws. */
async function rerun(path: string): Promise<{ status: number | null; error?: string }> {
  try {
    const res = await fetch(`${cronBaseUrl()}${path}`, {
      method: 'GET',
      headers: cronDispatchHeaders(),
      cache: 'no-store',
      redirect: 'manual', // a 307 to /login means the middleware ate it — report, don't follow
      signal: AbortSignal.timeout(RERUN_TIMEOUT_MS),
    });
    if (!res.ok) return { status: res.status, error: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => null)) as { skipped?: unknown } | null;
    if (body?.skipped === 'already running') {
      return { status: res.status, error: 'another run of it was already in progress' };
    }
    return { status: res.status };
  } catch (err) {
    return { status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

const stringOr = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** Short human summary of a job's completed heartbeat, e.g. "sent 1". */
function summarize(summary: Record<string, unknown> | undefined): string | undefined {
  if (!summary) return undefined;
  const parts = Object.entries(summary)
    .filter(([k, v]) => k !== 'phase' && (typeof v === 'number' || typeof v === 'string') && v !== 0)
    .slice(0, 4)
    .map(([k, v]) => `${k} ${v}`);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/** Liveness — see utils/cronHeartbeat.ts. Swallowed so it can never fail the run. */
function beat(summary: Record<string, unknown>): Promise<void> {
  return writeCronHeartbeat(JOB, { ranAt: new Date().toISOString(), summary }).catch((err) =>
    console.error(`[cron/${JOB}] heartbeat write failed:`, err),
  );
}

// Vercel invokes cron paths with GET (see utils/cronAuth).
export const GET = run;
export const POST = run;

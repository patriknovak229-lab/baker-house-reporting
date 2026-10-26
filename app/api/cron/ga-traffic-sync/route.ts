/**
 * GET|POST /api/cron/ga-traffic-sync?from&to
 *
 * GA4 Data API (property 529936917) → web_traffic_daily: sessions, users and purchases
 * per day × default channel group × source/medium. Traffic sources ONLY — GA sees just
 * the visitors who accepted cookies, so funnel volumes come from the site's own counts.
 *
 * Answers 503 until GA4_SERVICE_ACCOUNT_JSON is set in Vercel (setup steps in
 * docs/analytics.md §10). Default window: the 4 days up to yesterday — GA keeps
 * revising recent days for ~48 h, so each night re-pulls them. Backfill with
 * `?from=2026-03-28&to=…` (GA data starts 28 Mar 2026). Read-only towards Google.
 *
 * Auth: platform cron via utils/cronAuth (exempted in proxy.ts); manual = admin.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { cronAuth } from '@/utils/cronAuth';
import { writeCronHeartbeat } from '@/data-access/cronHeartbeat';
import { syncGaTraffic } from '@/data-access/analytics/webFunnelSync';
import { pragueToday } from '@/utils/periodUtils';
import { resolveSyncRange } from '@/utils/webFunnel';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const JOB = 'ga-traffic-sync';

async function run(req: NextRequest) {
  const { isCron } = cronAuth(req, JOB);
  if (!isCron) {
    const guard = await requireRole(['admin']);
    if ('error' in guard) return guard.error;
  }

  const range = resolveSyncRange(
    { from: req.nextUrl.searchParams.get('from'), to: req.nextUrl.searchParams.get('to') },
    { todayIso: pragueToday(), defaultBackDays: 4, defaultEndBackDays: 1, maxDays: 800 },
  );
  if ('error' in range) return NextResponse.json({ error: range.error }, { status: 400 });

  await beat({ phase: 'started', ...range });
  try {
    const result = await syncGaTraffic(range.from, range.to);
    if (!result.configured) {
      // Optional integration, not a broken job: record a completed no-op so the
      // watchdog stays quiet until the key is added.
      await beat({ phase: 'completed', skipped: 'GA4_SERVICE_ACCOUNT_JSON not set' });
      return NextResponse.json(
        {
          error:
            'GA4 is not connected: GA4_SERVICE_ACCOUNT_JSON is not set. Create a service account, add it as ' +
            'Viewer on GA property 529936917 and put its JSON key in Vercel (docs/analytics.md §10).',
        },
        { status: 503 },
      );
    }
    await beat({ phase: 'completed', ...range, rows: result.rows });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[cron/${JOB}]`, err);
    await beat({ phase: 'failed', error: message });
    return NextResponse.json({ error: message }, { status: 502 });
  }
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

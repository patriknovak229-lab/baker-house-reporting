/**
 * GET|POST /api/cron/web-funnel-sync?from&to
 *
 * Copies the rental site's anonymous funnel counters (its own Upstash Redis) into
 * web_funnel_daily / web_funnel_searches. Nightly via vercel.json; an admin can also
 * run it (the Web funnel tab's "Copy now"), or backfill any window still in Redis
 * (`?from=YYYY-MM-DD&to=YYYY-MM-DD`, up to 180 days — the site's key TTL).
 *
 * Default window: the last 3 days through today. Re-copying finished days every
 * night absorbs a missed run; today's partial row is overwritten by tomorrow's copy.
 * Every write is an upsert, so overlap is free.
 *
 * Read-only towards the rental site — see `data-access/analytics/webFunnelSync.ts`.
 * Auth: platform cron via utils/cronAuth (exempted in proxy.ts); manual = admin.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { cronAuth } from '@/utils/cronAuth';
import { writeCronHeartbeat } from '@/data-access/cronHeartbeat';
import { copyFunnelDays } from '@/data-access/analytics/webFunnelSync';
import { pragueToday } from '@/utils/periodUtils';
import { dayList, resolveSyncRange } from '@/utils/webFunnel';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const JOB = 'web-funnel-sync';

async function run(req: NextRequest) {
  const { isCron } = cronAuth(req, JOB);
  if (!isCron) {
    const guard = await requireRole(['admin']);
    if ('error' in guard) return guard.error;
  }

  const range = resolveSyncRange(
    { from: req.nextUrl.searchParams.get('from'), to: req.nextUrl.searchParams.get('to') },
    { todayIso: pragueToday(), defaultBackDays: 3, maxDays: 180 },
  );
  if ('error' in range) return NextResponse.json({ error: range.error }, { status: 400 });

  await beat({ phase: 'started', ...range });
  try {
    const result = await copyFunnelDays(dayList(range.from, range.to));
    if (!result.configured) {
      // Not a failure of the job: the read-only token simply isn't in Vercel yet.
      // The tab says so; the watchdog stays quiet.
      await beat({ phase: 'completed', skipped: 'RENTAL_SITE_REDIS_REST_URL / _TOKEN not set' });
      return NextResponse.json(
        {
          error:
            'RENTAL_SITE_REDIS_REST_URL and RENTAL_SITE_REDIS_REST_TOKEN are not set — nothing to copy from. ' +
            'Add the rental site’s Upstash REST URL and READ-ONLY token in Vercel (docs/analytics.md §10).',
        },
        { status: 503 },
      );
    }
    await beat({ phase: 'completed', ...range, metricRows: result.metricRows, searchRows: result.searchRows });
    return NextResponse.json({ ok: true, ...range, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[cron/${JOB}]`, err);
    await beat({ phase: 'failed', error: message });
    return NextResponse.json({ error: message }, { status: 500 });
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

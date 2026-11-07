/**
 * POST /api/analytics/market/refresh
 *
 * Pulls the PriceLabs market benchmark into the local `market_*` tables. The only
 * route in the app that talks to PriceLabs.
 *
 * READ-ONLY UPSTREAM. This calls PriceLabs' read endpoints and writes nothing back
 * to them. PriceLabs is the property's live pricing engine — it decides what guests
 * are charged — so no rate-changing endpoint is reachable from this app at all (see
 * the scope note in `utils/priceLabs.ts`). The only writes here are into our own
 * snapshot tables, all upserts on natural keys, so re-running is always safe.
 *
 * Auth: Vercel cron sends `x-vercel-cron: 1`. A manual trigger needs admin/super —
 * deliberately narrower than the analytics read roles, because this one spends
 * money (PriceLabs bills per synced listing) and takes tens of seconds.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { pragueToday } from '@/utils/periodUtils';
import { marketSnapshotAgeHours, refreshMarketSnapshot } from '@/data-access/analytics/marketRefresh';
import { buildRadarDigest } from '@/data-access/pricing/radar';
import { pricingChatId, sendTelegram } from '@/utils/telegram';
import { cronAuth } from '@/utils/cronAuth';
import { withCronLock } from '@/utils/cronLock';
import { writeCronHeartbeat } from '@/data-access/cronHeartbeat';

// Four listings × three calls each, one of which returns ~540 KB. Comfortably
// inside Vercel Pro's ceiling, nowhere near a default 10s budget.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/** A cron pull is a no-op while the snapshot is younger than this. */
const CRON_MIN_AGE_HOURS = 6;

/** Heartbeat / lock name — matches the cronAuth log tag and WATCHED_CRON_JOBS. */
const JOB = 'market-refresh';

async function run(req: NextRequest) {
  // cronAuth logs which signal matched, so a silent failure stays diagnosable
  // from the Vercel logs alone: a line naming the signal, or no line at all
  // = never invoked.
  const { isCron } = cronAuth(req, JOB);
  if (!isCron) {
    const guard = await requireRole(['admin', 'super']);
    if ('error' in guard) return guard.error;
  }

  // One pull at a time: a duplicate delivery, the daily catch-up and the
  // Refresh button could otherwise bill PriceLabs twice (utils/cronLock).
  return withCronLock(JOB, maxDuration + 30, () => runLocked(req, isCron));
}

async function runLocked(req: NextRequest, isCron: boolean): Promise<Response> {
  // Heartbeat on every outcome, like the other scheduled jobs: until
  // 2026-11-07 this one wrote none, so a missed 06:30 run went unnoticed.
  await beat({ phase: 'started' });

  // Cron invocations are cheap to ignore when the data is already fresh: the
  // parity work-order path also refreshes this snapshot, so a duplicate pull
  // buys nothing and PriceLabs bills per synced listing. This also caps the
  // cost of the header-only cron signal being forgeable from outside (proven
  // 2026-09-07) — an attacker gets a no-op. Operators pressing Refresh in the
  // UI authenticate as admin/super and always get a real pull.
  if (isCron) {
    const age = await marketSnapshotAgeHours();
    if (age !== null && age < CRON_MIN_AGE_HOURS) {
      console.log(`[market-refresh] skipped — snapshot is only ${age.toFixed(1)} h old`);
      await beat({ phase: 'completed', skipped: 'snapshot fresh' });
      return NextResponse.json({ skipped: true, ageHours: Math.round(age * 10) / 10 });
    }
  }

  try {
    const result = await refreshMarketSnapshot(pragueToday());
    if (!result.configured) {
      await beat({ phase: 'completed', skipped: 'PRICELABS_API_KEY not set' });
      return NextResponse.json(
        { error: 'PRICELABS_API_KEY is not set — no market data to refresh.' },
        { status: 503 },
      );
    }
    // A partial failure is reported, not swallowed: the listings that succeeded
    // have fresh rows and the ones that failed kept their previous vintage.
    const failed = result.listings.filter((l) => l.error);

    // Monday radar digest: pricing flags over the fresh snapshot, pushed to the
    // ops group. Weekly, not daily — the flags move slowly and a daily ping
    // would train everyone to ignore it. `?digest=1` forces one for testing.
    const isMonday = new Date(`${pragueToday()}T00:00:00Z`).getUTCDay() === 1;
    if (isMonday || req.nextUrl.searchParams.get('digest') === '1') {
      try {
        const digest = await buildRadarDigest(120);
        if (digest) await sendTelegram(digest, { chatId: pricingChatId() });
      } catch (err) {
        console.error('[market-refresh] radar digest failed', err);
      }
    }

    const allFailed = failed.length === result.listings.length;
    await beat(
      allFailed
        ? { phase: 'failed', error: `all ${failed.length} listings failed` }
        : { phase: 'completed', listings: result.listings.length, failedListings: failed.length },
    );
    return NextResponse.json(result, { status: allFailed ? 502 : 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[market-refresh]', err);
    await beat({ phase: 'failed', error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Liveness — see utils/cronHeartbeat.ts. Swallowed so it can never fail the run. */
function beat(summary: Record<string, unknown>): Promise<void> {
  return writeCronHeartbeat(JOB, { ranAt: new Date().toISOString(), summary }).catch((err) =>
    console.error(`[${JOB}] heartbeat write failed:`, err),
  );
}

export const POST = run;

/** Vercel cron issues GET; keep both so the schedule and the button share a path. */
export const GET = run;

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
import { requireAccess } from '@/utils/authGuard';
import { pragueToday } from '@/utils/periodUtils';
import { listingAgesHours, refreshMarketSnapshot } from '@/data-access/analytics/marketRefresh';
import {
  readDigestSentDate,
  readGapAlertState,
  writeDigestSentDate,
  writeGapAlertState,
} from '@/data-access/analytics/marketRefreshState';
import { buildRadarDigest } from '@/data-access/pricing/radar';
import { escapeHtml, pricingChatId, sendTechnicalAlert, sendTelegram } from '@/utils/telegram';
import {
  gapAlertText,
  planGapAlerts,
  refreshSummary,
  stalestListingAge,
  type RefreshedListing,
} from '@/utils/marketRefreshHealth';
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
    const guard = await requireAccess('analytics', 'change');
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
  // Measured on the STALEST listing: the newest row overall let one good
  // listing make the snapshot look fresh, so the 8 Nov catch-up "recovered"
  // a run that skipped with three listings still a day old.
  if (isCron) {
    const age = stalestListingAge(await listingAgesHours());
    if (age !== null && age < CRON_MIN_AGE_HOURS) {
      console.log(`[market-refresh] skipped — snapshot is only ${age.toFixed(1)} h old`);
      // The parity work order may have pulled first on a Monday; the digest
      // still goes, over that fresh snapshot.
      await sendMondayDigest(req);
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

    await sendMondayDigest(req);

    // A broken pull fails the run: watchdog alert + 12:00 UTC catch-up retry. A
    // PriceLabs gap (LISTING_NO_DATA…) only marks it degraded: the catch-up
    // retries quietly and the gap is announced once, if it outlasts
    // gapAlertDue. Until 2026-11-09 a gap failed the run, which paged most days
    // for a job that was working — see utils/marketRefreshHealth.
    await announceGaps(result.listings);
    await beat(refreshSummary(result.listings));
    const allFailed = failed.length === result.listings.length;
    return NextResponse.json(result, { status: allFailed ? 502 : 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[market-refresh]', err);
    await beat({ phase: 'failed', error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Monday radar digest: pricing flags over the fresh snapshot, pushed to the
 * pricing chat. Weekly, not daily — the flags move slowly and a daily ping
 * would train everyone to ignore it. At most once per Monday: the catch-up may
 * re-run a Monday refresh (PriceLabs gap) and the operator may press Refresh.
 * `?digest=1` forces one for testing. Never fails the run.
 */
async function sendMondayDigest(req: NextRequest): Promise<void> {
  const today = pragueToday();
  const forced = req.nextUrl.searchParams.get('digest') === '1';
  if (!forced && new Date(`${today}T00:00:00Z`).getUTCDay() !== 1) return;
  try {
    if (!forced && (await readDigestSentDate()) === today) return;
    const digest = await buildRadarDigest(120);
    if (digest) await sendTelegram(digest, { chatId: pricingChatId() });
    if (!forced) await writeDigestSentDate(today);
  } catch (err) {
    console.error('[market-refresh] radar digest failed', err);
  }
}

/** One technical-chat message per PriceLabs gap that outlasts gapAlertDue. Never fails the run. */
async function announceGaps(listings: RefreshedListing[]): Promise<void> {
  try {
    const { alerts, next } = planGapAlerts(await readGapAlertState(), listings, await listingAgesHours(), new Date());
    const text = gapAlertText(alerts, escapeHtml);
    // Alert before saving: if the send throws, the gap stays un-announced and
    // the next run tries again.
    if (text) await sendTechnicalAlert(text);
    await writeGapAlertState(next);
  } catch (err) {
    console.error(`[${JOB}] gap alert check failed:`, err);
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

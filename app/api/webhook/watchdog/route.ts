/**
 * GET|POST /api/webhook/watchdog?secret=<WEBHOOK_SECRET>
 *
 * The safety checks, on their own: called by cron-job.org every 5 minutes —
 * outside Vercel's cron scheduler, so it keeps ticking through the failure
 * that stops the crons. Each call:
 *
 *   1. cron watchdog (utils/cronWatchdog) — jobs gone quiet or not completing,
 *      CRON_SECRET missing, the 14:00 UTC catch-up backup. Hourly at most.
 *   2. pay-later watchdog (utils/webPayments/watchdog) — fires the charge job
 *      when a payment step is 2 h overdue. Every 10 minutes at most.
 *   3. pings healthchecks.io (utils/healthcheckPing), which emails the operator
 *      if these calls ever stop — the one check that lives outside our system.
 *   4. then nudges the guest-message webhook: Beds24 never pings us for guest
 *      messages, so this 5-minute call is what answers them overnight.
 *
 * Why a separate route (2026-11-25): the watchdogs used to run inside the
 * guest-message webhook, after its debounce, so any bug, bad deploy or secret
 * mismatch in 3,000 lines of guest code stopped them without a word. Here the
 * guest code runs only after the checks, in after(), and cannot stop them.
 *
 * Auth: the same WEBHOOK_SECRET as the Beds24 webhook (already in cron-job.org's
 * URL) — deliberately not CRON_SECRET, which unlocks the payment jobs and should
 * not be copied into a third-party service. Exempt from the auth middleware via
 * the `api/webhook` prefix in proxy.ts.
 *
 * Always answers 200 once the secret passes, even when a check failed: failures
 * go to healthchecks.io (`/fail`) and the logs. A non-2xx would make cron-job.org
 * count failures and eventually disable the job — which would also stop the
 * guest-message nudge.
 */
import { after, NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { rejectBadWebhookSecret } from '@/utils/webhookSecret';
import { checkCronLiveness } from '@/utils/cronWatchdog';
import { payLaterWatchdog } from '@/utils/webPayments/watchdog';
import { pingHealthcheck } from '@/utils/healthcheckPing';
import { triggerAutoReplyPoll } from '@/utils/autoReplyNudge';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

async function run(req: NextRequest) {
  const denied = rejectBadWebhookSecret(req, 'watchdog');
  if (denied) return denied;

  const failures: string[] = [];
  const redis = getRedis();
  if (!redis) {
    // Both watchdogs throttle and de-duplicate in Redis; without it they can't run.
    failures.push('Redis is not configured (UPSTASH_REDIS_REST_URL / TOKEN) — no watchdog ran');
  } else {
    const checks: [string, () => Promise<void>][] = [
      ['cron watchdog', () => checkCronLiveness(redis)],
      ['pay-later watchdog', () => payLaterWatchdog(redis)],
    ];
    for (const [name, check] of checks) {
      try {
        await check();
      } catch (err) {
        console.error(`[watchdog] ${name} failed:`, err);
        failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  await pingHealthcheck(failures);

  after(() =>
    triggerAutoReplyPoll().catch((err) => console.error('[watchdog] guest-message nudge failed:', err)),
  );

  return NextResponse.json({ ok: failures.length === 0, failures });
}

export const GET = run;
export const POST = run;

/**
 * GET|POST /api/cron/web-payments[?dryRun=1]
 *
 * The pay-later charge job (utils/webPayments/engine.ts → runWebPaymentsJob):
 * re-checks open schedules against Beds24, recovers bookings the website
 * never registered, sends reminders, runs the two scheduled charges, cancels
 * after two declines (auto mode only), and finishes any pending side effects.
 *
 * Listed FOUR times a day in vercel.json (Hobby allows several entries on one
 * path). Each run catches up on everything that is due and not done, and a
 * run delivered twice changes nothing — so a dropped Vercel delivery costs
 * hours, not a payment. The webhook watchdog fires this route too when a step
 * is 2 h overdue (utils/webPayments/watchdog.ts). Mode off/manual/auto lives
 * in app_settings (Transactions → Pay later); missing = off.
 *
 * Auth: platform cron via utils/cronAuth (exempted in proxy.ts); a manual run
 * is admin only. `?dryRun=1` lists what is due without doing anything.
 */
import { NextRequest, NextResponse } from 'next/server';
import { writeCronHeartbeat } from '@/data-access/cronHeartbeat';
import { webPaymentRepo } from '@/data-access/webPayments';
import { OPEN_WEB_PAYMENT_STATUSES } from '@/types/webPayment';
import { requireRole } from '@/utils/authGuard';
import { cronAuth } from '@/utils/cronAuth';
import { withCronLock } from '@/utils/cronLock';
import { escapeHtml, sendTechnicalAlert } from '@/utils/telegram';
import { readWebPaymentMode, webPaymentsIo } from '@/utils/webPayments/deps';
import { runWebPaymentsJob } from '@/utils/webPayments/engine';
import { dueStep, overdueSchedules } from '@/utils/webPayments/rules';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const JOB = 'web-payments';

async function run(req: NextRequest) {
  const { isCron } = cronAuth(req, JOB);
  let actor = 'job';
  if (!isCron) {
    const guard = await requireRole(['admin']);
    if ('error' in guard) return guard.error;
    actor = guard.email;
  }

  if (req.nextUrl.searchParams.get('dryRun') === '1') {
    const now = new Date();
    const [mode, open] = await Promise.all([readWebPaymentMode(), webPaymentRepo.listByStatus(OPEN_WEB_PAYMENT_STATUSES)]);
    return NextResponse.json({
      mode,
      open: open.map((s) => ({
        id: s.id,
        reservationNumber: s.reservationNumber,
        status: s.status,
        attempt1At: s.attempt1At,
        attempt2At: s.attempt2At,
        due: dueStep(s, now, mode),
        attention: s.attention,
      })),
      overdue: overdueSchedules(open, now, mode),
    });
  }

  return withCronLock(JOB, maxDuration + 30, () => runLocked(actor));
}

async function runLocked(actor: string): Promise<Response> {
  await beat({ phase: 'started' });
  try {
    const summary = await runWebPaymentsJob(webPaymentsIo(), { recoveryDue: true, actor });
    await beat({ phase: 'completed', ...summary });
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[cron/${JOB}]`, err);
    await beat({ phase: 'failed', error: message });
    await sendTechnicalAlert(`🛠 <b>Pay later job crashed</b>: ${escapeHtml(message).slice(0, 500)}`).catch(() => {});
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

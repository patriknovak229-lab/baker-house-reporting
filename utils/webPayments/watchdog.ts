/**
 * Pay-later watchdog — runs in the Beds24 webhook poll (dashboard every ~30 s,
 * cron-job.org every 5 min), i.e. OUTSIDE Vercel's cron scheduler. If a
 * payment step is more than 2 h overdue, the job's scheduled runs were lost:
 * fire the job now and tell the technical chat (once a day per set of bookings).
 *
 * Cheap on the hot path: one Redis NX check, then at most one small query
 * every 10 minutes.
 */
import type { Redis } from '@upstash/redis';
import { webPaymentRepo } from '@/data-access/webPayments';
import { OPEN_WEB_PAYMENT_STATUSES } from '@/types/webPayment';
import { cronBaseUrl, cronDispatchHeaders } from '@/utils/cronAuth';
import { sendTechnicalAlert } from '@/utils/telegram';
import { pragueDateOf } from './dates';
import { readWebPaymentMode } from './deps';
import { msg } from './messages';
import { overdueSchedules } from './rules';

const CHECK_EVERY_S = 10 * 60;
const FIRE_EVERY_S = 30 * 60;

export async function payLaterWatchdog(redis: Redis): Promise<void> {
  const due = await redis.set('baker:paylater:watchdog:checked', 1, { nx: true, ex: CHECK_EVERY_S });
  if (due === null) return;

  const mode = await readWebPaymentMode();
  if (mode === 'off') return;
  const open = await webPaymentRepo.listByStatus(OPEN_WEB_PAYMENT_STATUSES);
  const now = new Date();
  const overdue = overdueSchedules(open, now, mode);
  if (overdue.length === 0) return;

  const byId = new Map(open.map((s) => [s.id, s.reservationNumber]));
  const list = overdue.map((o) => `${byId.get(o.id)} ${o.step} (${Math.round(o.lateMs / 3600_000)} h late)`).join(', ');
  const ids = overdue.map((o) => o.id).sort().join(',');
  const alertKey = `baker:paylater:watchdog:alerted:${pragueDateOf(now)}:${ids}`;
  if ((await redis.set(alertKey, 1, { nx: true, ex: 26 * 3600 })) !== null) {
    await sendTechnicalAlert(msg.overdue(list)).catch(() => {});
  }

  const fire = await redis.set('baker:paylater:watchdog:fired', 1, { nx: true, ex: FIRE_EVERY_S });
  if (fire === null) return;
  console.warn(`[pay-later watchdog] overdue: ${list} — firing the job`);
  // Fire-and-forget: the job may take longer than this poll's budget; Vercel
  // keeps the called function running after we stop waiting.
  await fetch(`${cronBaseUrl()}/api/cron/web-payments`, {
    headers: cronDispatchHeaders(),
    cache: 'no-store',
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {});
}

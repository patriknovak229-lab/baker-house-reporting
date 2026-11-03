/**
 * GET|POST /api/cron/overdue-tasks
 *
 * Daily (vercel.json, 07:00 UTC ≈ 08:00–09:00 Prague): posts ONE Telegram to
 * the Baker House Operations group — the chat new bookings land in — listing
 * every general task whose due date has passed and that hasn't been announced
 * yet, then stamps `overdue_notified_at` so each task alerts exactly once.
 * A failed send stamps nothing, so tomorrow's run retries.
 *
 * Reservation-level tasks are not covered: they live in reservation overrides
 * and keep their red "overdue" badge in the Pending tasks pill.
 *
 * Auth: platform cron via utils/cronAuth (exempted in proxy.ts); manual = admin/super.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { cronAuth } from '@/utils/cronAuth';
import { writeCronHeartbeat } from '@/data-access/cronHeartbeat';
import { listTeamUsers, listUnannouncedOverdueTasks, markOverdueAnnounced } from '@/data-access/team';
import { escapeHtml, sendTelegram } from '@/utils/telegram';
import { pragueToday } from '@/utils/periodUtils';
import { overdueTasksTelegram } from '@/utils/teamItems';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const JOB = 'overdue-tasks';

async function run(req: NextRequest) {
  const { isCron } = cronAuth(req, JOB);
  if (!isCron) {
    const guard = await requireRole(['admin', 'super']);
    if ('error' in guard) return guard.error;
  }

  await beat({ phase: 'started' });
  try {
    const today = pragueToday();
    const overdue = await listUnannouncedOverdueTasks(today);
    if (overdue.length === 0) {
      await beat({ phase: 'completed', announced: 0 });
      return NextResponse.json({ ok: true, announced: 0 });
    }

    const users = await listTeamUsers();
    const sent = await sendTelegram(overdueTasksTelegram(overdue, users, today, escapeHtml));
    if (!sent) throw new Error('Telegram send failed — tasks left unannounced for the next run');

    await markOverdueAnnounced(overdue.map((t) => t.id));
    await beat({ phase: 'completed', announced: overdue.length });
    return NextResponse.json({ ok: true, announced: overdue.length });
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

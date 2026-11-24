/**
 * GET|POST /api/cron/overdue-tasks
 *
 * Daily (vercel.json, 07:00 UTC ≈ 08:00–09:00 Prague): posts ONE Telegram to
 * the Baker House Operations group — the chat new bookings land in — listing
 * every general task whose due date has passed and that hasn't been announced
 * yet, then stamps `overdue_notified_at` so each task alerts exactly once.
 * A failed send stamps nothing, so tomorrow's run retries.
 *
 * Tasks the system raised itself (a cron that needs a human — utils/systemAlerts)
 * are technical, so their nudge goes to the technical chat instead, with the
 * email backup (operator request 2026-11-08: no technical noise in Operations).
 *
 * Reservation-level tasks are not covered: they live in reservation overrides
 * and keep their red "overdue" badge in the Pending tasks pill.
 *
 * Auth: platform cron via utils/cronAuth (exempted in proxy.ts); manual = admin/super.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { cronAuth } from '@/utils/cronAuth';
import { withCronLock } from '@/utils/cronLock';
import { writeCronHeartbeat } from '@/data-access/cronHeartbeat';
import { listTeamUsers, listUnannouncedOverdueTasks, markOverdueAnnounced } from '@/data-access/team';
import { escapeHtml, sendTechnicalAlert, sendTelegram } from '@/utils/telegram';
import { pragueToday } from '@/utils/periodUtils';
import { overdueTasksTelegram } from '@/utils/teamItems';
import { isSystemTask } from '@/utils/systemAlerts';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const JOB = 'overdue-tasks';

async function run(req: NextRequest) {
  const { isCron } = cronAuth(req, JOB);
  if (!isCron) {
    const guard = await requireRole(['admin', 'super']);
    if ('error' in guard) return guard.error;
  }

  // One run at a time (duplicate delivery / daily catch-up) — utils/cronLock.
  return withCronLock(JOB, maxDuration + 30, () => runLocked());
}

async function runLocked(): Promise<Response> {
  await beat({ phase: 'started' });
  try {
    const today = pragueToday();
    const overdue = await listUnannouncedOverdueTasks(today);
    if (overdue.length === 0) {
      await beat({ phase: 'completed', announced: 0 });
      return NextResponse.json({ ok: true, announced: 0 });
    }

    const users = await listTeamUsers();
    const groups = [
      { tasks: overdue.filter((t) => !isSystemTask(t)), send: (m: string) => sendTelegram(m) },
      { tasks: overdue.filter(isSystemTask), send: sendTechnicalAlert },
    ];
    // Stamp each group only once its own message went out.
    const announced: string[] = [];
    for (const g of groups) {
      if (g.tasks.length === 0) continue;
      if (await g.send(overdueTasksTelegram(g.tasks, users, today, escapeHtml))) {
        announced.push(...g.tasks.map((t) => t.id));
      }
    }
    await markOverdueAnnounced(announced);
    if (announced.length < overdue.length) {
      throw new Error(
        `Telegram send failed — ${overdue.length - announced.length} task(s) left unannounced for the next run`,
      );
    }
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

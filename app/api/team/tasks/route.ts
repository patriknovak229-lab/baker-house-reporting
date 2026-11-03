/**
 * General tasks — to-dos that belong to no reservation.
 *
 *   POST  /api/team/tasks  { assignee: email | 'all', text, dueDate: YYYY-MM-DD } → { task }
 *   PATCH /api/team/tasks  { id, done: true }                                    → mark done
 *
 * Shown in the Pending tasks pill next to reservation tasks; the overdue cron
 * (api/cron/overdue-tasks) posts a Telegram once a task's date has passed.
 * admin/super only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { requireRole } from '@/utils/authGuard';
import { createGeneralTask, isKnownOperator, resolveGeneralTask } from '@/data-access/team';
import { TEAM_ALL, isYmd, validateTeamText } from '@/utils/teamItems';

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  let body: { assignee?: unknown; text?: unknown; dueDate?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const assignee = typeof body.assignee === 'string' ? body.assignee : TEAM_ALL;
  if (assignee !== TEAM_ALL && !isKnownOperator(assignee, guard.email)) {
    return NextResponse.json({ error: 'Pick who the task is for.' }, { status: 400 });
  }
  const text = validateTeamText(body.text);
  if ('error' in text) return NextResponse.json({ error: text.error }, { status: 400 });
  if (!isYmd(body.dueDate)) {
    return NextResponse.json({ error: 'Pick the date the task is due.' }, { status: 400 });
  }

  try {
    const session = await auth();
    const task = await createGeneralTask({
      assignee,
      text: text.text,
      dueDate: body.dueDate,
      createdBy: guard.email,
      createdByName: session?.user?.name ?? null,
    });
    return NextResponse.json({ ok: true, task });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to create task' },
      { status: 500 },
    );
  }
}

export async function PATCH(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  let body: { id?: unknown; done?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body.id !== 'string' || !body.id || body.done !== true) {
    return NextResponse.json({ error: 'Provide { id, done: true }' }, { status: 400 });
  }

  try {
    const resolved = await resolveGeneralTask(body.id, guard.email);
    return NextResponse.json({ ok: true, resolved });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to update task' },
      { status: 500 },
    );
  }
}

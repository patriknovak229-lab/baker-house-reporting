/**
 * Tasks the system raises for itself — a cron outcome only a human can settle
 * (utils/systemAlerts). They are ordinary general tasks (data-access/team), so
 * they sit in the dashboard's task list until someone resolves them, and get a
 * second nudge when overdue (app/api/cron/overdue-tasks, technical chat).
 *
 * One open task per problem `key` (e.g. "cron:send-due-invoices"): the general
 * tasks table has no source column, so the key → task id map lives in one
 * app_settings row. Resolving the task re-arms the key.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db';
import { appSettings, generalTasks } from '@/lib/db/schema';
import { createGeneralTask } from '@/data-access/team';
import { pragueToday } from '@/utils/periodUtils';
import { SYSTEM_TASK_AUTHOR, technicalContacts } from '@/utils/systemAlerts';
import { TEAM_ALL } from '@/utils/teamItems';

const SETTING = 'system-task-ids';

async function readIds(): Promise<Record<string, string>> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, SETTING)).limit(1);
  const value = row?.value;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : {};
}

async function isOpen(taskId: string): Promise<boolean> {
  const rows = await db
    .select({ id: generalTasks.id })
    .from(generalTasks)
    .where(and(eq(generalTasks.id, taskId), isNull(generalTasks.resolvedAt)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Raise a task for `key` unless one is still open. Due today, so an unresolved
 * one is announced as overdue tomorrow morning. Assigned to the technical
 * contact (utils/systemAlerts), or to everyone when none is configured.
 */
export async function raiseSystemTask(key: string, text: string): Promise<'created' | 'already-open'> {
  const ids = await readIds();
  if (ids[key] && (await isOpen(ids[key]))) return 'already-open';
  const task = await createGeneralTask({
    assignee: technicalContacts()[0] ?? TEAM_ALL,
    text,
    dueDate: pragueToday(),
    createdBy: SYSTEM_TASK_AUTHOR,
    createdByName: 'System',
  });
  const next = { ...ids, [key]: task.id };
  await db
    .insert(appSettings)
    .values({ key: SETTING, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: next, updatedAt: new Date() } });
  return 'created';
}

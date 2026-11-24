/**
 * Who hears about the system's own problems, and how its tasks are told apart —
 * the pure half (no I/O) shared by the email backup (utils/alertEmail), the
 * system tasks (data-access/systemTasks) and the overdue-tasks job.
 *
 * Why: until 2026-11-24 a "needs a human" cron outcome existed only as one
 * Telegram line in the technical chat. Miss it, or have the bot token break,
 * and the invoice or payment link it was about simply never went out. Now such
 * outcomes also become a task in the dashboard, and a Telegram that cannot be
 * delivered goes out by email.
 */

/** `createdBy` of tasks the system raises itself (not an inbox). */
export const SYSTEM_TASK_AUTHOR = 'system';

export function isSystemTask(task: { createdBy: string }): boolean {
  return task.createdBy === SYSTEM_TASK_AUTHOR;
}

/**
 * Who receives technical problems: ALERT_EMAIL (comma list) when set, else the
 * first ADMIN_EMAILS address — admin is the top role, and the first entry is
 * the owner. Empty when neither is configured.
 */
export function technicalContacts(env: Record<string, string | undefined> = process.env): string[] {
  const list = (v: string | undefined) =>
    (v ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  const explicit = list(env.ALERT_EMAIL);
  if (explicit.length > 0) return [...new Set(explicit)];
  return list(env.ADMIN_EMAILS).slice(0, 1);
}

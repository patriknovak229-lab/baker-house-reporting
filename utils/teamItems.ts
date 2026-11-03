/**
 * Client-safe contract for team notifications and general (non-reservation)
 * tasks — see lib/db/schema/team.ts for storage, /api/team for the routes.
 *
 * Imported by BOTH the browser (TransactionsPage, the two forms) and the server
 * (routes, overdue cron), so it must stay free of server-only imports: nothing
 * here may reach Postgres, Redis, `next/server` or `process.env`
 * (see utils/variableCostsShared.ts for why that rule exists).
 */

/** Addressee meaning "every operator". */
export const TEAM_ALL = "all";

/** Longest message/task text accepted — a note, not a document. */
export const TEAM_TEXT_MAX = 2000;

export interface TeamUser {
  email: string;
  name: string;
}

export interface TeamNotification {
  id: string;
  /** Operator email or TEAM_ALL. */
  recipient: string;
  text: string;
  createdBy: string;
  createdByName: string | null;
  /** ISO timestamp. */
  createdAt: string;
}

export interface GeneralTask {
  id: string;
  /** Operator email or TEAM_ALL. */
  assignee: string;
  text: string;
  /** YYYY-MM-DD. */
  dueDate: string;
  createdBy: string;
  createdByName: string | null;
  /** ISO timestamp. */
  createdAt: string;
  overdueNotifiedAt?: string | null;
}

/** GET /api/team */
export interface TeamFeed {
  me: string;
  users: TeamUser[];
  notifications: TeamNotification[];
  tasks: GeneralTask[];
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Is an item addressed to `email` (directly or via "all")? */
export function isAddressedTo(addressee: string, email: string): boolean {
  return addressee === TEAM_ALL || normalizeEmail(addressee) === normalizeEmail(email);
}

/**
 * Which general tasks an operator sees in Pending tasks: their own, everyone's,
 * and the ones they handed to someone else — so a delegated task doesn't
 * vanish from its author's view until it's done.
 */
export function taskVisibleTo(task: Pick<GeneralTask, "assignee" | "createdBy">, email: string): boolean {
  return isAddressedTo(task.assignee, email) || normalizeEmail(task.createdBy) === normalizeEmail(email);
}

/** "patrik.novak@x.cz" → "Patrik Novak". Used when no Google name is on record. */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  const words = local.split(/[._-]+/).filter(Boolean);
  if (words.length === 0) return email;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Display label for an addressee: "All users", the user's name, or a name derived from the email. */
export function addresseeLabel(addressee: string, users: TeamUser[], me?: string): string {
  if (addressee === TEAM_ALL) return "All users";
  if (me && normalizeEmail(addressee) === normalizeEmail(me)) return "You";
  const u = users.find((x) => normalizeEmail(x.email) === normalizeEmail(addressee));
  return u?.name ?? nameFromEmail(addressee);
}

/** The author as shown on a banner row. */
export function authorLabel(
  item: { createdBy: string; createdByName: string | null },
  users: TeamUser[],
  me?: string,
): string {
  if (me && normalizeEmail(item.createdBy) === normalizeEmail(me)) return "You";
  const u = users.find((x) => normalizeEmail(x.email) === normalizeEmail(item.createdBy));
  return item.createdByName || u?.name || nameFromEmail(item.createdBy);
}

export function isYmd(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
}

/** Trimmed text, or an error message for the form. */
export function validateTeamText(raw: unknown): { text: string } | { error: string } {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { error: "Write something first." };
  if (text.length > TEAM_TEXT_MAX) return { error: `Keep it under ${TEAM_TEXT_MAX} characters.` };
  return { text };
}

/** Open tasks whose due date has passed and that haven't been announced yet. */
export function newlyOverdueTasks<T extends Pick<GeneralTask, "dueDate" | "overdueNotifiedAt">>(
  tasks: T[],
  todayYmd: string,
): T[] {
  return tasks.filter((t) => t.dueDate < todayYmd && !t.overdueNotifiedAt);
}

/** Whole days between a due date and today (0 = due today). */
export function daysOverdue(dueYmd: string, todayYmd: string): number {
  return Math.round((Date.parse(todayYmd + "T00:00:00Z") - Date.parse(dueYmd + "T00:00:00Z")) / 86_400_000);
}

/**
 * One Telegram for every task that just went overdue. `escape` is passed in
 * (utils/telegram's escapeHtml) so this module stays import-free.
 */
export function overdueTasksTelegram(
  tasks: GeneralTask[],
  users: TeamUser[],
  todayYmd: string,
  escape: (s: string) => string,
): string {
  const header =
    tasks.length === 1 ? "⏰ <b>Overdue task</b>" : `⏰ <b>${tasks.length} overdue tasks</b>`;
  const blocks = tasks.map((t) => {
    const late = daysOverdue(t.dueDate, todayYmd);
    const text = t.text.length > 500 ? t.text.slice(0, 500) + "…" : t.text;
    return [
      escape(text),
      `Due ${t.dueDate} (${late}d overdue) · for ${escape(addresseeLabel(t.assignee, users))} · from ${escape(authorLabel(t, users))}`,
    ].join("\n");
  });
  return [header, ...blocks].join("\n\n");
}

/**
 * Postgres repository for team notifications and general tasks
 * (lib/db/schema/team.ts). Pure rules live in utils/teamItems.ts.
 *
 * The operator list is not a table: an operator is anyone on ADMIN_EMAILS or
 * SUPER_EMAILS (the roles that can open Transactions). Display names are
 * learned from Google sign-ins as operators load the dashboard and kept in
 * `app_settings['team-user-names']`; until someone has signed in, their name
 * is derived from the email.
 */
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { appSettings, generalTasks, teamNotifications } from '@/lib/db/schema';
import type { GeneralTaskRow, TeamNotificationRow } from '@/lib/db/schema/team';
import {
  TEAM_ALL,
  nameFromEmail,
  normalizeEmail,
  type GeneralTask,
  type TeamNotification,
  type TeamUser,
} from '@/utils/teamItems';

const NAMES_KEY = 'team-user-names';
/** The banner is an inbox, not an archive. */
const UNREAD_LIMIT = 100;

function newId(prefix: 'NT' | 'GT'): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function operatorEmails(): string[] {
  const list = ['ADMIN_EMAILS', 'SUPER_EMAILS'].flatMap((v) =>
    (process.env[v] ?? '').split(',').map(normalizeEmail).filter(Boolean),
  );
  return [...new Set(list)];
}

async function readNames(): Promise<Record<string, string>> {
  const rows = await db.select().from(appSettings).where(eq(appSettings.key, NAMES_KEY));
  const value = rows[0]?.value;
  return value && typeof value === 'object' ? (value as Record<string, string>) : {};
}

/** Remember an operator's Google display name. Best-effort: never fails a request. */
export async function rememberTeamName(email: string, name: string | null | undefined): Promise<void> {
  const clean = name?.trim();
  if (!clean) return;
  try {
    const names = await readNames();
    const key = normalizeEmail(email);
    if (names[key] === clean) return;
    const value = { ...names, [key]: clean };
    await db
      .insert(appSettings)
      .values({ key: NAMES_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
  } catch (err) {
    console.error('[team] failed to remember operator name:', err);
  }
}

/** Every operator who can receive a notification or task. `me`, when given, is always included. */
export async function listTeamUsers(me?: string): Promise<TeamUser[]> {
  const names = await readNames();
  const emails = operatorEmails();
  if (me && !emails.includes(normalizeEmail(me))) emails.push(normalizeEmail(me));
  return emails
    .map((email) => ({ email, name: names[email] ?? nameFromEmail(email) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Is `email` someone an item may be addressed to? */
export function isKnownOperator(email: string, me: string): boolean {
  const e = normalizeEmail(email);
  return e === normalizeEmail(me) || operatorEmails().includes(e);
}

// ── Notifications ────────────────────────────────────────────────────────────

function toNotification(r: TeamNotificationRow): TeamNotification {
  return {
    id: r.id,
    recipient: r.recipient,
    text: r.text,
    createdBy: r.createdBy,
    createdByName: r.createdByName,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Unread notifications addressed to `email` (directly or to everyone), newest first. */
export async function listUnreadNotifications(email: string): Promise<TeamNotification[]> {
  const me = normalizeEmail(email);
  const rows = await db
    .select()
    .from(teamNotifications)
    .where(
      and(
        or(eq(teamNotifications.recipient, TEAM_ALL), eq(teamNotifications.recipient, me)),
        sql`NOT (${me} = ANY(${teamNotifications.readBy}))`,
      ),
    )
    .orderBy(desc(teamNotifications.createdAt))
    .limit(UNREAD_LIMIT);
  return rows.map(toNotification);
}

export async function createNotification(input: {
  recipient: string;
  text: string;
  createdBy: string;
  createdByName: string | null;
}): Promise<TeamNotification> {
  const [row] = await db
    .insert(teamNotifications)
    .values({
      id: newId('NT'),
      recipient: input.recipient === TEAM_ALL ? TEAM_ALL : normalizeEmail(input.recipient),
      text: input.text,
      createdBy: normalizeEmail(input.createdBy),
      createdByName: input.createdByName,
    })
    .returning();
  return toNotification(row);
}

/** Mark notifications read for one reader. Idempotent; returns how many changed. */
export async function markNotificationsRead(ids: string[], email: string): Promise<number> {
  if (ids.length === 0) return 0;
  const me = normalizeEmail(email);
  const rows = await db
    .update(teamNotifications)
    .set({ readBy: sql`array_append(${teamNotifications.readBy}, ${me})` })
    .where(and(inArray(teamNotifications.id, ids), sql`NOT (${me} = ANY(${teamNotifications.readBy}))`))
    .returning({ id: teamNotifications.id });
  return rows.length;
}

// ── General tasks ────────────────────────────────────────────────────────────

function toTask(r: GeneralTaskRow): GeneralTask {
  return {
    id: r.id,
    assignee: r.assignee,
    text: r.text,
    dueDate: r.dueDate,
    createdBy: r.createdBy,
    createdByName: r.createdByName,
    createdAt: r.createdAt.toISOString(),
    overdueNotifiedAt: r.overdueNotifiedAt?.toISOString() ?? null,
  };
}

/** Every open general task, soonest due first. Visibility is filtered by the caller. */
export async function listOpenGeneralTasks(): Promise<GeneralTask[]> {
  const rows = await db
    .select()
    .from(generalTasks)
    .where(isNull(generalTasks.resolvedAt))
    .orderBy(asc(generalTasks.dueDate), asc(generalTasks.createdAt));
  return rows.map(toTask);
}

export async function createGeneralTask(input: {
  assignee: string;
  text: string;
  dueDate: string;
  createdBy: string;
  createdByName: string | null;
}): Promise<GeneralTask> {
  const [row] = await db
    .insert(generalTasks)
    .values({
      id: newId('GT'),
      assignee: input.assignee === TEAM_ALL ? TEAM_ALL : normalizeEmail(input.assignee),
      text: input.text,
      dueDate: input.dueDate,
      createdBy: normalizeEmail(input.createdBy),
      createdByName: input.createdByName,
    })
    .returning();
  return toTask(row);
}

/** Mark a task done. Returns false when it was already done or doesn't exist. */
export async function resolveGeneralTask(id: string, by: string): Promise<boolean> {
  const rows = await db
    .update(generalTasks)
    .set({ resolvedAt: sql`now()`, resolvedBy: normalizeEmail(by) })
    .where(and(eq(generalTasks.id, id), isNull(generalTasks.resolvedAt)))
    .returning({ id: generalTasks.id });
  return rows.length > 0;
}

/** Open tasks due before `todayYmd` that have not had their overdue Telegram yet. */
export async function listUnannouncedOverdueTasks(todayYmd: string): Promise<GeneralTask[]> {
  const rows = await db
    .select()
    .from(generalTasks)
    .where(
      and(
        isNull(generalTasks.resolvedAt),
        isNull(generalTasks.overdueNotifiedAt),
        lt(generalTasks.dueDate, todayYmd),
      ),
    )
    .orderBy(asc(generalTasks.dueDate));
  return rows.map(toTask);
}

export async function markOverdueAnnounced(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(generalTasks)
    .set({ overdueNotifiedAt: sql`now()` })
    .where(inArray(generalTasks.id, ids));
}

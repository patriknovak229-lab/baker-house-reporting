import { pgTable, text, date, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * Operator-to-operator messages and to-dos that belong to no reservation.
 *
 * Reservation-level tasks live inside `reservation_overrides.issues[]` and are
 * shown to every operator. These two tables add what that model can't express:
 * an addressee (one operator, or everyone) and items with no booking attached
 * ("fire alarm drill on Thursday", "renew the parking permit").
 *
 * Addressee convention for both tables: an operator's account email
 * (lower-cased), or the literal `'all'` (TEAM_ALL in utils/teamItems.ts) for
 * everyone on the Transactions tab.
 *
 * New domain, Postgres-only — no `STORE_*` flag and no Redis path.
 */

export const teamNotifications = pgTable(
  'team_notifications',
  {
    /** `NT-<base36 ms><rand>`. */
    id: text('id').primaryKey(),
    /** Operator email or 'all'. */
    recipient: text('recipient').notNull(),
    text: text('text').notNull(),
    /** Author's account email (from the auth guard, never the client). */
    createdBy: text('created_by').notNull(),
    /** Author's Google display name at send time, so the banner reads without a lookup. */
    createdByName: text('created_by_name'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    /**
     * Emails that have marked it read. Per-reader rather than one flag because
     * an `'all'` notification has to stay unread for everyone who hasn't seen it.
     */
    readBy: text('read_by').array().notNull().default([]),
  },
  (t) => [index('team_notifications_created_idx').on(t.createdAt)],
);

export const generalTasks = pgTable(
  'general_tasks',
  {
    /** `GT-<base36 ms><rand>`. */
    id: text('id').primaryKey(),
    /** Operator email or 'all'. */
    assignee: text('assignee').notNull(),
    text: text('text').notNull(),
    /** YYYY-MM-DD, same meaning as a reservation task's `actionableDate`. */
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    createdBy: text('created_by').notNull(),
    createdByName: text('created_by_name'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    /** null = open. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    resolvedBy: text('resolved_by'),
    /** When the overdue Telegram went out — one alert per task, never repeated. */
    overdueNotifiedAt: timestamp('overdue_notified_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [index('general_tasks_open_idx').on(t.resolvedAt, t.dueDate)],
);

export type TeamNotificationRow = typeof teamNotifications.$inferSelect;
export type TeamNotificationInsert = typeof teamNotifications.$inferInsert;
export type GeneralTaskRow = typeof generalTasks.$inferSelect;
export type GeneralTaskInsert = typeof generalTasks.$inferInsert;

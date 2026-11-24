import { pgTable, text, timestamp, serial, index } from 'drizzle-orm/pg-core';

/**
 * Who may sign in, and with which role (utils/roles.ts). Edited on
 * /admin/users; read on every request through utils/userRoles.ts (60 s cache),
 * so a removal takes effect within a minute.
 *
 * Emails live ONLY here, never in the repo (it is public). The env
 * `ADMIN_EMAILS` stays as a break-glass list that is always admin, so a bad
 * edit here can never lock the owner out.
 */
export const appUsers = pgTable('app_users', {
  /** Lower-cased Google account email. */
  email: text('email').primaryKey(),
  /** 'admin' | 'super' | 'user' | 'occupancy' — validated with isRole(). */
  role: text('role').notNull(),
  /** Free text for the admin ("cleaning lead", "owner of K.201"). */
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  /** Email of the admin who made the last change. */
  updatedBy: text('updated_by').notNull(),
});

/** Every add / role change / removal on /admin/users, newest first on the page. */
export const appUserChanges = pgTable(
  'app_user_changes',
  {
    id: serial('id').primaryKey(),
    email: text('email').notNull(),
    /** Null when the user was added. */
    oldRole: text('old_role'),
    /** Null when the user was removed. */
    newRole: text('new_role'),
    changedBy: text('changed_by').notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [index('app_user_changes_changed_idx').on(t.changedAt)],
);

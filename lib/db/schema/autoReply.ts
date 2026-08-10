import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';

/**
 * Auto-reply audit logs — were Redis JSON arrays `baker:auto-reply:log` and
 * `baker:auto-reply:edit-log` (both append-only, capped at 500). Stored as full
 * JSON blobs so we stay faithful to their loosely-typed shape regardless of
 * field drift, with extracted timestamp columns for ordering.
 */
export const autoReplyLog = pgTable('auto_reply_log', {
  id: text('id').primaryKey(), // AutoReplyLogEntry.id
  decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
  entry: jsonb('entry').notNull(),
});

export const autoReplyEditLog = pgTable('auto_reply_edit_log', {
  // Source entries carry no id — PK is a deterministic content hash (see backfill).
  hash: text('hash').primaryKey(),
  editedAt: timestamp('edited_at', { withTimezone: true, mode: 'date' }),
  entry: jsonb('entry').notNull(),
});

export type AutoReplyLogRow = typeof autoReplyLog.$inferSelect;
export type AutoReplyEditLogRow = typeof autoReplyEditLog.$inferSelect;

import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';

/**
 * Durable single-value app settings / credentials — a generic key→value store.
 * First tenant: the Gmail invoice refresh token (was `baker:gmail-invoice-token`).
 */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export type AppSettingRow = typeof appSettings.$inferSelect;
export type AppSettingInsert = typeof appSettings.$inferInsert;

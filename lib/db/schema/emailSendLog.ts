import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** Guest-facing templated messages sent — was Redis JSON array `baker:email-send-log`. */
export const emailSendLog = pgTable('email_send_log', {
  id: text('id').primaryKey(),
  reservationNumber: text('reservation_number').notNull(),
  templateId: text('template_id').notNull(),
  templateLabel: text('template_label').notNull(),
  // Optional in source (legacy rows predate WhatsApp) — undefined ⇒ treated as 'email'.
  channel: text('channel').$type<'email' | 'whatsapp' | 'sms'>(),
  to: text('to_address').notNull(),
  subject: text('subject').notNull(), // '' for WhatsApp/SMS
  sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }).notNull(),
  sentBy: text('sent_by').notNull(),
});

export type EmailSendLogRow = typeof emailSendLog.$inferSelect;
export type EmailSendLogInsert = typeof emailSendLog.$inferInsert;

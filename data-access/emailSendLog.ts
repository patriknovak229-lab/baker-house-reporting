/**
 * Postgres repository for the guest-message audit log (Redis→Postgres cutover).
 * Row↔domain mapping restores the app's expected shapes (timestamps → ISO
 * strings, absent → undefined). `replaceAll` mirrors the routes' whole-array
 * `set` semantics atomically via db.batch. Append-only in practice, but the
 * routes rewrite the whole array, so the repo does too (byte-identical).
 */
import { db } from '@/lib/db';
import { emailSendLog } from '@/lib/db/schema';
import type { EmailSendLogEntry } from '@/types/emailSendLog';
import type { EmailSendLogInsert, EmailSendLogRow } from '@/lib/db/schema/emailSendLog';

const u = <T>(x: T | null): T | undefined => (x == null ? undefined : x);

function toRow(e: EmailSendLogEntry): EmailSendLogInsert {
  return {
    id: e.id,
    reservationNumber: e.reservationNumber,
    templateId: e.templateId,
    templateLabel: e.templateLabel,
    channel: e.channel ?? null,
    to: e.to,
    subject: e.subject ?? '',
    sentAt: new Date(e.sentAt),
    sentBy: e.sentBy,
  };
}

function fromRow(r: EmailSendLogRow): EmailSendLogEntry {
  return {
    id: r.id,
    reservationNumber: r.reservationNumber,
    templateId: r.templateId,
    templateLabel: r.templateLabel,
    channel: u(r.channel),
    to: r.to,
    subject: r.subject,
    sentAt: r.sentAt.toISOString(),
    sentBy: r.sentBy,
  };
}

export async function listEmailSendLogPg(): Promise<EmailSendLogEntry[]> {
  return (await db.select().from(emailSendLog)).map(fromRow);
}

export async function replaceAllEmailSendLogPg(items: EmailSendLogEntry[]): Promise<void> {
  const rows = items.map(toRow);
  if (rows.length === 0) {
    await db.delete(emailSendLog);
    return;
  }
  await db.batch([db.delete(emailSendLog), db.insert(emailSendLog).values(rows)]);
}

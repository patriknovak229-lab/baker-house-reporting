/**
 * Postgres repository for scheduled payment links (types/scheduledPaymentLink.ts).
 * Row-level writes (never replace-all): the cron and the operator can touch
 * different rows at the same time.
 */
import { asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { scheduledPaymentLinks } from '@/lib/db/schema';
import type { ScheduledPaymentLinkInsert, ScheduledPaymentLinkRow } from '@/lib/db/schema/scheduledPaymentLinks';
import type { ScheduledPaymentLink } from '@/types/scheduledPaymentLink';

const u = <T>(x: T | null): T | undefined => (x == null ? undefined : x);
const iso = (d: Date | null) => (d ? d.toISOString() : undefined);
const dt = (s?: string) => (s ? new Date(s) : null);

function fromRow(r: ScheduledPaymentLinkRow): ScheduledPaymentLink {
  return {
    id: r.id,
    reservationNumber: r.reservationNumber,
    allocations: r.allocations,
    amountCzk: Number(r.amountCzk),
    description: r.description,
    isMainPayment: r.isMainPayment,
    sendDate: r.sendDate,
    guestEmail: r.guestEmail,
    guestName: u(r.guestName),
    guestPhone: u(r.guestPhone),
    status: r.status,
    paymentId: u(r.paymentId),
    sentAt: iso(r.sentAt),
    reminderSentAt: iso(r.reminderSentAt),
    alertReason: u(r.alertReason),
    alertAt: iso(r.alertAt),
    dismissedAt: iso(r.dismissedAt),
    failureCount: r.failureCount,
    createdAt: r.createdAt.toISOString(),
    createdBy: u(r.createdBy),
  };
}

function toRow(l: ScheduledPaymentLink): ScheduledPaymentLinkInsert {
  return {
    id: l.id,
    reservationNumber: l.reservationNumber,
    allocations: l.allocations,
    amountCzk: String(l.amountCzk),
    description: l.description,
    isMainPayment: l.isMainPayment,
    sendDate: l.sendDate,
    guestEmail: l.guestEmail,
    guestName: l.guestName ?? null,
    guestPhone: l.guestPhone ?? null,
    status: l.status,
    paymentId: l.paymentId ?? null,
    sentAt: dt(l.sentAt),
    reminderSentAt: dt(l.reminderSentAt),
    alertReason: l.alertReason ?? null,
    alertAt: dt(l.alertAt),
    dismissedAt: dt(l.dismissedAt),
    failureCount: l.failureCount ?? 0,
    createdAt: new Date(l.createdAt),
    createdBy: l.createdBy ?? null,
  };
}

export async function listScheduledLinks(): Promise<ScheduledPaymentLink[]> {
  const rows = await db.select().from(scheduledPaymentLinks).orderBy(asc(scheduledPaymentLinks.sendDate), asc(scheduledPaymentLinks.createdAt));
  return rows.map(fromRow);
}

export async function getScheduledLink(id: string): Promise<ScheduledPaymentLink | null> {
  const rows = await db.select().from(scheduledPaymentLinks).where(eq(scheduledPaymentLinks.id, id)).limit(1);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function insertScheduledLink(link: ScheduledPaymentLink): Promise<void> {
  await db.insert(scheduledPaymentLinks).values(toRow(link));
}

/** Write the whole row back (callers read → change → save one row). */
export async function saveScheduledLink(link: ScheduledPaymentLink): Promise<void> {
  const { id, ...rest } = toRow(link);
  await db.update(scheduledPaymentLinks).set(rest).where(eq(scheduledPaymentLinks.id, id));
}

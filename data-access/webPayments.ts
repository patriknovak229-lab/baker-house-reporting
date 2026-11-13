/**
 * Postgres access for pay later (web_payment_schedules + web_payment_events).
 * The engine (utils/webPayments/engine.ts) only talks to this through the
 * `WebPaymentRepo` interface, so its tests run against an in-memory twin with
 * the same conditional semantics (utils/webPayments/memoryRepo.ts).
 *
 * The Neon HTTP driver has no interactive transactions, so every write that can
 * race is ONE conditional UPDATE … RETURNING: it either applies as a whole or
 * returns nothing, and the caller treats "nothing" as "someone else got there".
 */
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { webPaymentEvents, webPaymentSchedules, type WebPaymentScheduleRow } from '@/lib/db/schema';
import type { WebPaymentEvent, WebPaymentSchedule, WebPaymentStatus } from '@/types/webPayment';
import type { NewSchedule, SchedulePatch, WebPaymentRepo, WhenClause } from '@/utils/webPayments/repo';

const t = webPaymentSchedules;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const TIMESTAMP_KEYS = new Set(['reminderAt', 'attempt1At', 'attempt2At', 'firstDeclineAt', 'retryNotBefore', 'lockedAt', 'paidAt', 'cancelledAt']);

export function rowToSchedule(r: WebPaymentScheduleRow): WebPaymentSchedule {
  return {
    id: r.id,
    reservationNumber: r.reservationNumber,
    bookingIds: r.bookingIds,
    arrival: r.arrival,
    departure: r.departure,
    roomLabel: r.roomLabel,
    amountMinor: r.amountMinor,
    currency: r.currency,
    guestName: r.guestName,
    guestEmail: r.guestEmail,
    guestPhone: r.guestPhone,
    lang: r.lang,
    voucherCode: r.voucherCode,
    termsVersion: r.termsVersion,
    source: r.source,
    livemode: r.livemode,
    stripeCustomerId: r.stripeCustomerId,
    stripePaymentMethodId: r.stripePaymentMethodId,
    stripeSetupIntentId: r.stripeSetupIntentId,
    stripeCheckoutSessionId: r.stripeCheckoutSessionId,
    cardBrand: r.cardBrand,
    cardLast4: r.cardLast4,
    cardExpMonth: r.cardExpMonth,
    cardExpYear: r.cardExpYear,
    deadlineDate: r.deadlineDate,
    reminderAt: iso(r.reminderAt),
    attempt1At: r.attempt1At.toISOString(),
    attempt2At: r.attempt2At.toISOString(),
    status: r.status,
    attemptCount: r.attemptCount,
    autoDeclines: r.autoDeclines,
    firstDeclineAt: iso(r.firstDeclineAt),
    lastDecline: r.lastDecline ?? null,
    retryNotBefore: iso(r.retryNotBefore),
    retryCount: r.retryCount,
    pendingAttempt: r.pendingAttempt ?? null,
    lockToken: r.lockToken,
    lockedAt: iso(r.lockedAt),
    openLinkSessionId: r.openLinkSessionId,
    payToken: r.payToken,
    noAutoCancel: r.noAutoCancel,
    emails: r.emails ?? {},
    effects: r.effects ?? {},
    alerts: r.alerts ?? {},
    attention: r.attention ?? null,
    attentionDetail: r.attentionDetail ?? null,
    beds24: r.beds24 ?? null,
    paidAt: iso(r.paidAt),
    paidPaymentIntentId: r.paidPaymentIntentId,
    paidAmountMinor: r.paidAmountMinor,
    paidVia: r.paidVia ?? null,
    cancelledAt: iso(r.cancelledAt),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** ISO strings in → Date columns out; only the keys present are written. */
function toColumns(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    out[k] = TIMESTAMP_KEYS.has(k) && v !== null ? new Date(v as string) : v;
  }
  return out;
}

function whereFor(id: string, when: WhenClause | undefined) {
  const conds = [eq(t.id, id)];
  if (when?.statusIn) conds.push(inArray(t.status, when.statusIn as WebPaymentStatus[]));
  if (when?.lockToken !== undefined) conds.push(eq(t.lockToken, when.lockToken));
  if (when?.lockFreeBefore) conds.push(or(isNull(t.lockToken), lt(t.lockedAt, when.lockFreeBefore))!);
  if (when?.openLinkSessionIdIs !== undefined) {
    conds.push(when.openLinkSessionIdIs === null ? isNull(t.openLinkSessionId) : eq(t.openLinkSessionId, when.openLinkSessionIdIs));
  }
  return and(...conds);
}

export const webPaymentRepo: WebPaymentRepo = {
  async insertIfAbsent(row: NewSchedule) {
    const inserted = await db
      .insert(t)
      .values(toColumns(row as unknown as Record<string, unknown>) as typeof t.$inferInsert)
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return { created: true, row: rowToSchedule(inserted[0]) };
    const existing = await db
      .select()
      .from(t)
      .where(
        or(
          eq(t.reservationNumber, row.reservationNumber),
          row.stripeCheckoutSessionId ? eq(t.stripeCheckoutSessionId, row.stripeCheckoutSessionId) : sql`false`,
        ),
      )
      .limit(1);
    if (!existing[0]) throw new Error(`Insert of ${row.reservationNumber} conflicted but no row was found`);
    return { created: false, row: rowToSchedule(existing[0]) };
  },

  async get(id) {
    const r = await db.select().from(t).where(eq(t.id, id)).limit(1);
    return r[0] ? rowToSchedule(r[0]) : null;
  },

  async getByToken(token) {
    const r = await db.select().from(t).where(eq(t.payToken, token)).limit(1);
    return r[0] ? rowToSchedule(r[0]) : null;
  },

  async getByReservation(reservationNumber) {
    const r = await db.select().from(t).where(eq(t.reservationNumber, reservationNumber)).limit(1);
    return r[0] ? rowToSchedule(r[0]) : null;
  },

  async findByBookingId(bookingId) {
    const r = await db
      .select()
      .from(t)
      .where(sql`${t.bookingIds} @> ${JSON.stringify([bookingId])}::jsonb`)
      .limit(1);
    return r[0] ? rowToSchedule(r[0]) : null;
  },

  async listByStatus(statuses) {
    const r = await db.select().from(t).where(inArray(t.status, statuses as WebPaymentStatus[]));
    return r.map(rowToSchedule);
  },

  async listUpdatedSince(since) {
    const r = await db.select().from(t).where(gt(t.updatedAt, since)).orderBy(desc(t.updatedAt));
    return r.map(rowToSchedule);
  },

  async listAll() {
    const r = await db.select().from(t).orderBy(desc(t.createdAt));
    return r.map(rowToSchedule);
  },

  async claim(id, token, staleBefore, statuses) {
    const now = new Date();
    const r = await db
      .update(t)
      .set({ lockToken: token, lockedAt: now, updatedAt: now })
      .where(
        and(
          eq(t.id, id),
          inArray(t.status, statuses as WebPaymentStatus[]),
          or(isNull(t.lockToken), lt(t.lockedAt, staleBefore)),
        ),
      )
      .returning();
    return r[0] ? rowToSchedule(r[0]) : null;
  },

  async release(id, token) {
    await db
      .update(t)
      .set({ lockToken: null, lockedAt: null })
      .where(and(eq(t.id, id), eq(t.lockToken, token)));
  },

  async patch(id, patch: SchedulePatch, when) {
    const r = await db
      .update(t)
      .set({ ...toColumns(patch as Record<string, unknown>), updatedAt: new Date() } as Partial<typeof t.$inferInsert>)
      .where(whereFor(id, when))
      .returning();
    return r[0] ? rowToSchedule(r[0]) : null;
  },

  async markJson(id, column, key, value) {
    const col = column === 'emails' ? t.emails : column === 'effects' ? t.effects : t.alerts;
    const merged = sql`${col} || ${JSON.stringify({ [key]: value })}::jsonb`;
    await db
      .update(t)
      .set({ [column]: merged, updatedAt: new Date() } as Partial<typeof t.$inferInsert>)
      .where(eq(t.id, id));
  },

  async addEvent(scheduleId, type, actor, data) {
    const id = `WE-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(webPaymentEvents).values({ id, scheduleId, type, actor, data: data ?? {} });
  },

  async listEvents(scheduleId) {
    const r = await db
      .select()
      .from(webPaymentEvents)
      .where(eq(webPaymentEvents.scheduleId, scheduleId))
      .orderBy(desc(webPaymentEvents.at))
      .limit(200);
    return r.map(
      (e): WebPaymentEvent => ({
        id: e.id,
        scheduleId: e.scheduleId,
        at: e.at.toISOString(),
        type: e.type,
        actor: e.actor,
        data: e.data ?? {},
      }),
    );
  },
};

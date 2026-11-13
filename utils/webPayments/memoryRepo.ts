/**
 * In-memory twin of data-access/webPayments.ts for engine tests. Same
 * conditional semantics: a claim or a guarded patch either applies whole or
 * returns null. Test-only — never imported by app code.
 */
import type { WebPaymentEvent, WebPaymentSchedule } from '@/types/webPayment';
import type { NewSchedule, SchedulePatch, WebPaymentRepo, WhenClause } from './repo';

export interface MemoryRepo extends WebPaymentRepo {
  rows: Map<string, WebPaymentSchedule>;
  events: WebPaymentEvent[];
}

export function memoryRepo(clock: () => Date = () => new Date()): MemoryRepo {
  const rows = new Map<string, WebPaymentSchedule>();
  const events: WebPaymentEvent[] = [];
  const copy = (s: WebPaymentSchedule | undefined | null) => (s ? structuredClone(s) : null);

  const holds = (s: WebPaymentSchedule, when?: WhenClause) => {
    if (when?.statusIn && !when.statusIn.includes(s.status)) return false;
    if (when?.lockToken !== undefined && s.lockToken !== when.lockToken) return false;
    if (when?.lockFreeBefore && s.lockToken && s.lockedAt && Date.parse(s.lockedAt) >= when.lockFreeBefore.getTime()) {
      return false;
    }
    if (when?.openLinkSessionIdIs !== undefined && s.openLinkSessionId !== when.openLinkSessionIdIs) return false;
    return true;
  };

  return {
    rows,
    events,
    async insertIfAbsent(row: NewSchedule) {
      const existing = [...rows.values()].find(
        (s) =>
          s.reservationNumber === row.reservationNumber ||
          (row.stripeCheckoutSessionId && s.stripeCheckoutSessionId === row.stripeCheckoutSessionId) ||
          s.payToken === row.payToken,
      );
      if (existing) return { created: false, row: copy(existing)! };
      const now = clock().toISOString();
      const full: WebPaymentSchedule = { ...structuredClone(row), createdAt: now, updatedAt: now };
      rows.set(row.id, full);
      return { created: true, row: copy(full)! };
    },
    async get(id) {
      return copy(rows.get(id));
    },
    async getByToken(token) {
      return copy([...rows.values()].find((s) => s.payToken === token));
    },
    async getByReservation(res) {
      return copy([...rows.values()].find((s) => s.reservationNumber === res));
    },
    async findByBookingId(bookingId) {
      return copy([...rows.values()].find((s) => s.bookingIds.includes(bookingId)));
    },
    async listByStatus(statuses) {
      return [...rows.values()].filter((s) => statuses.includes(s.status)).map((s) => copy(s)!);
    },
    async listUpdatedSince(since) {
      return [...rows.values()].filter((s) => Date.parse(s.updatedAt) > since.getTime()).map((s) => copy(s)!);
    },
    async listAll() {
      return [...rows.values()].map((s) => copy(s)!);
    },
    async claim(id, token, staleBefore, statuses) {
      const s = rows.get(id);
      if (!s || !statuses.includes(s.status)) return null;
      if (s.lockToken && s.lockedAt && Date.parse(s.lockedAt) >= staleBefore.getTime()) return null;
      const now = clock().toISOString();
      s.lockToken = token;
      s.lockedAt = now;
      s.updatedAt = now;
      return copy(s);
    },
    async release(id, token) {
      const s = rows.get(id);
      if (s && s.lockToken === token) {
        s.lockToken = null;
        s.lockedAt = null;
      }
    },
    async patch(id, patch: SchedulePatch, when?: WhenClause) {
      const s = rows.get(id);
      if (!s || !holds(s, when)) return null;
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined) (s as unknown as Record<string, unknown>)[k] = structuredClone(v);
      }
      s.updatedAt = clock().toISOString();
      return copy(s);
    },
    async markJson(id, column, key, value) {
      const s = rows.get(id);
      if (!s) return;
      (s[column] as Record<string, string>)[key] = value;
      s.updatedAt = clock().toISOString();
    },
    async addEvent(scheduleId, type, actor, data) {
      events.push({ id: `WE-${events.length + 1}`, scheduleId, at: clock().toISOString(), type, actor, data: data ?? {} });
    },
    async listEvents(scheduleId) {
      return events.filter((e) => e.scheduleId === scheduleId).reverse();
    },
  };
}

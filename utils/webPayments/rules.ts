/**
 * Pay-later decisions — what is due for a schedule right now. Pure; the charge
 * job (engine.ts) and the watchdog both ask these questions.
 */
import type { WebPaymentMode, WebPaymentSchedule } from '@/types/webPayment';
import { effectiveAttempt2At, withinFreeCancellation } from './dates';

export type ScheduleCore = Pick<
  WebPaymentSchedule,
  | 'status'
  | 'reminderAt'
  | 'attempt1At'
  | 'attempt2At'
  | 'firstDeclineAt'
  | 'autoDeclines'
  | 'emails'
  | 'deadlineDate'
  | 'noAutoCancel'
  | 'retryNotBefore'
>;

/**
 * reminder      → send the "we'll charge on …" email
 * attempt1      → first scheduled charge
 * failed_email  → the 1st charge was declined but the guest hasn't been told
 *                 yet (SMTP failed) — nothing else may happen before this
 * attempt2      → second scheduled charge (≥ 20 h after the guest was told)
 * cancel        → two declines, cancellation allowed: cancel for non-payment
 * decide        → two declines (or no failure email by the deadline) and NO
 *                 automatic cancellation (manual mode, the "don't
 *                 auto-cancel" flag, or free cancellation is over): an admin decides
 */
export type DueStep = 'reminder' | 'attempt1' | 'failed_email' | 'attempt2' | 'cancel' | 'decide';

/** No reminder this close to the charge — the charge (or its email) is about to happen. */
export const REMINDER_CUTOFF_MS = 2 * 60 * 60 * 1000;

const ms = (iso: string | null) => (iso ? Date.parse(iso) : NaN);
const HOUR = 3600_000;

export function canAutoCancel(s: ScheduleCore, now: Date, mode: WebPaymentMode): boolean {
  return mode === 'auto' && !s.noAutoCancel && withinFreeCancellation(s.deadlineDate, now);
}

/**
 * When the 2nd attempt runs: as planned, but never sooner than 20 h after the
 * guest was actually TOLD (the failure email) — not merely after the decline.
 */
export function attempt2DueAt(s: ScheduleCore): Date {
  const told = s.emails.failed ?? s.firstDeclineAt;
  return effectiveAttempt2At(new Date(s.attempt2At), told ? new Date(told) : null);
}

/** True while a technical failure's back-off is running. */
export function backedOff(s: Pick<ScheduleCore, 'retryNotBefore'>, now: Date): boolean {
  return !!s.retryNotBefore && Date.parse(s.retryNotBefore) > now.getTime();
}

/** What the job should do with this schedule now, or null when nothing is due. */
export function dueStep(s: ScheduleCore, now: Date, mode: WebPaymentMode): DueStep | null {
  const t = now.getTime();
  if (s.status === 'scheduled') {
    if (ms(s.attempt1At) <= t) return backedOff(s, now) ? null : 'attempt1';
    if (s.reminderAt && ms(s.reminderAt) <= t && !s.emails.reminder && ms(s.attempt1At) - t > REMINDER_CUTOFF_MS) {
      return 'reminder';
    }
    return null;
  }
  if (s.status === 'failed') {
    // The guest must hear about the decline before anything else happens.
    if (!s.emails.failed) return withinFreeCancellation(s.deadlineDate, now) ? 'failed_email' : 'decide';
    if (s.autoDeclines <= 1) {
      if (attempt2DueAt(s).getTime() > t) return null;
      return backedOff(s, now) ? null : 'attempt2';
    }
    if (!canAutoCancel(s, now, mode)) return 'decide';
    return backedOff(s, now) ? null : 'cancel';
  }
  return null;
}

/** When the step became due — the watchdog measures lateness from this. */
export function dueSince(s: ScheduleCore, step: DueStep): Date | null {
  switch (step) {
    case 'reminder':
      return s.reminderAt ? new Date(s.reminderAt) : null;
    case 'attempt1':
      return new Date(s.attempt1At);
    case 'failed_email':
      return s.firstDeclineAt ? new Date(s.firstDeclineAt) : null;
    case 'attempt2':
    case 'cancel':
      return attempt2DueAt(s);
    case 'decide':
      return null;
  }
}

/** A step this late means the job's runs were lost — the watchdog fires the job. */
export const OVERDUE_AFTER_MS = 2 * HOUR;

/**
 * Schedules whose due step should have run by now but hasn't — the job's
 * scheduled deliveries were dropped. Lateness counts from the end of any
 * back-off (a back-off is the job doing its job, not a lost run). In manual
 * mode charges wait for an admin by design, so only reminders count; in off
 * mode nothing runs. A failure email that keeps failing is retried by every
 * run anyway and is not the watchdog's business.
 */
export function overdueSchedules<T extends ScheduleCore & { id: string }>(
  rows: T[],
  now: Date,
  mode: WebPaymentMode,
): Array<{ id: string; step: DueStep; lateMs: number }> {
  if (mode === 'off') return [];
  const out: Array<{ id: string; step: DueStep; lateMs: number }> = [];
  for (const r of rows) {
    const step = dueStep(r, now, mode);
    if (!step || step === 'decide' || step === 'failed_email') continue;
    if (mode === 'manual' && step !== 'reminder') continue;
    const since = dueSince(r, step);
    if (!since) continue;
    const from = Math.max(since.getTime(), r.retryNotBefore ? Date.parse(r.retryNotBefore) : 0);
    const lateMs = now.getTime() - from;
    if (lateMs > OVERDUE_AFTER_MS) out.push({ id: r.id, step, lateMs });
  }
  return out;
}

export type BackoffKind = 'unknown' | 'retry' | 'needs_admin' | 'blocked';

/**
 * How long to wait after a technical failure before the next charge attempt.
 * Card networks penalise merchants that retry declined cards too often, so
 * this grows and caps at 12 h (at most a handful of attempts a day).
 * `count` = technical failures in a row, including this one (≥ 1).
 */
export function retryBackoffMs(kind: BackoffKind, count: number): number {
  if (kind === 'needs_admin') return 12 * HOUR;
  if (kind === 'blocked') return 6 * HOUR;
  const steps = kind === 'unknown' ? [0.5, 2, 4, 8, 12] : [2, 4, 8, 12];
  return steps[Math.min(Math.max(count, 1) - 1, steps.length - 1)] * HOUR;
}

/** Money in Beds24 terms, tolerant of haléř rounding. */
export function sameAmount(aCzk: number, bCzk: number): boolean {
  return Math.abs(aCzk - bCzk) < 0.5;
}

/**
 * Beds24 deposits for a payment: each active row's share of what was actually
 * paid (in proportion to its price), the last row taking the rounding. Paid in
 * full → every row's deposit is exactly its price.
 */
export function depositsFor(rows: Array<{ id: number; price: number }>, paidCzk: number): Array<{ id: number; deposit: number }> {
  const total = rows.reduce((s, r) => s + r.price, 0);
  if (rows.length === 0) return [];
  if (total <= 0) return rows.map((r, i) => ({ id: r.id, deposit: i === 0 ? paidCzk : 0 }));
  if (sameAmount(paidCzk, total) || paidCzk > total) return rows.map((r) => ({ id: r.id, deposit: r.price }));
  let left = Math.round(paidCzk * 100) / 100;
  return rows.map((r, i) => {
    const share = i === rows.length - 1 ? left : Math.round(((r.price / total) * paidCzk) * 100) / 100;
    left = Math.round((left - share) * 100) / 100;
    return { id: r.id, deposit: share };
  });
}

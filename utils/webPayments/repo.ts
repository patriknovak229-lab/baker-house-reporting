/**
 * The storage contract the pay-later engine relies on. Real implementation:
 * data-access/webPayments.ts (Postgres). Test twin: ./memoryRepo.ts.
 *
 * The guarantees that make double charges impossible live HERE, so both
 * implementations must honour them exactly:
 *   - `claim` succeeds for one caller at a time (until the lock goes stale);
 *   - `patch` with a `when` clause applies only if every condition still holds,
 *     and returns null otherwise — never a partial write.
 */
import type { WebPaymentEvent, WebPaymentSchedule, WebPaymentStatus } from '@/types/webPayment';

export type NewSchedule = Omit<WebPaymentSchedule, 'createdAt' | 'updatedAt'>;

/** Scalar / whole-object columns. emails / effects / alerts are merged with `markJson` instead. */
export type SchedulePatch = Partial<
  Omit<WebPaymentSchedule, 'id' | 'createdAt' | 'updatedAt' | 'emails' | 'effects' | 'alerts'>
>;

export interface WhenClause {
  /** Apply only while the status is one of these. */
  statusIn?: readonly WebPaymentStatus[];
  /** Apply only while this caller still holds the claim. */
  lockToken?: string;
  /** Apply only while nobody holds a fresh claim (locks older than this are stale). */
  lockFreeBefore?: Date;
  /** Compare-and-set: apply only while the open pay-link page is still this one (null = none). */
  openLinkSessionIdIs?: string | null;
}

export interface WebPaymentRepo {
  /** Insert unless a schedule for this booking (or this card-saving session) exists. */
  insertIfAbsent(row: NewSchedule): Promise<{ created: boolean; row: WebPaymentSchedule }>;
  get(id: string): Promise<WebPaymentSchedule | null>;
  getByToken(token: string): Promise<WebPaymentSchedule | null>;
  getByReservation(reservationNumber: string): Promise<WebPaymentSchedule | null>;
  /** The schedule whose booking ids include this Beds24 id (master or second studio). */
  findByBookingId(bookingId: number): Promise<WebPaymentSchedule | null>;
  listByStatus(statuses: readonly WebPaymentStatus[]): Promise<WebPaymentSchedule[]>;
  listUpdatedSince(since: Date): Promise<WebPaymentSchedule[]>;
  listAll(): Promise<WebPaymentSchedule[]>;
  /** Take the charge claim: only while the status is allowed and no fresh claim exists. */
  claim(
    id: string,
    token: string,
    staleBefore: Date,
    statuses: readonly WebPaymentStatus[],
  ): Promise<WebPaymentSchedule | null>;
  /** Drop the claim — only if it is still ours. */
  release(id: string, token: string): Promise<void>;
  patch(id: string, patch: SchedulePatch, when?: WhenClause): Promise<WebPaymentSchedule | null>;
  /** Merge one key into emails / effects / alerts without touching the others. */
  markJson(id: string, column: 'emails' | 'effects' | 'alerts', key: string, value: string): Promise<void>;
  addEvent(scheduleId: string, type: string, actor: string, data?: Record<string, unknown>): Promise<void>;
  listEvents(scheduleId: string): Promise<WebPaymentEvent[]>;
}

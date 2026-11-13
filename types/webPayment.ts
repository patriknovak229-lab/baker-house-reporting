/**
 * Pay later for website bookings — shared, client-safe types.
 *
 * A web guest who books far enough ahead pays 0 Kč at checkout: Stripe saves
 * their card, and this app charges the agreed amount before free cancellation
 * ends (utils/webPayments/dates.ts). Contract with the rental site:
 * Projects/PayLater/contract.md (outside the repo).
 */

/**
 * scheduled         → waiting for the 1st charge
 * failed            → at least one automatic charge was declined; waiting for
 *                     the guest (pay link) or the 2nd attempt
 * paid              → money received through Stripe (any path)
 * paid_other        → an admin marked it paid outside Stripe (bank transfer, cash)
 * cancelled_unpaid  → we cancelled the booking because it wasn't paid
 * cancelled         → the booking was cancelled before it was paid (guest or ops)
 * closed            → an admin closed the schedule without charging
 */
export type WebPaymentStatus =
  | 'scheduled'
  | 'failed'
  | 'paid'
  | 'paid_other'
  | 'cancelled_unpaid'
  | 'cancelled'
  | 'closed';

/** Statuses in which money may still be taken. */
export const OPEN_WEB_PAYMENT_STATUSES: readonly WebPaymentStatus[] = ['scheduled', 'failed'];

export type WebPaymentMode = 'off' | 'manual' | 'auto';

export type WebPaymentLang = 'cs' | 'en';

/** What took the money. */
export type WebPaymentPaidVia = 'auto' | 'manual' | 'link' | 'other';

/** Why a charge was attempted. auto1/auto2 are the two scheduled attempts. */
export type WebPaymentTrigger = 'auto1' | 'auto2' | 'manual';

export type WebPaymentEmailKind = 'scheduled' | 'reminder' | 'failed' | 'receipt' | 'cancelled' | 'link';

/** Side effects that must eventually happen after a status change (an outbox). */
export type WebPaymentEffect =
  | 'beds24Paid'        // deposit = price on every Beds24 row
  | 'paymentLogged'     // row in the Stripe payment log (VAT reads it)
  | 'cardDeleted'       // saved card detached from the Stripe customer
  | 'linkExpired'       // any open pay-link Checkout page closed
  | 'cancelRequested'   // a non-payment cancellation was started (survives a crash mid-way)
  | 'beds24Cancelled'   // Beds24 rows cancelled as non-payment
  | 'alertedClosedState' // the paid-then-cancelled / reinstated alert went out
  | 'voucherRestored'   // voucher back to "issued" after a non-payment cancel
  | 'tasksResolved';    // our Pending tasks on the booking resolved

/**
 * Problems shown to ops on the schedule card. One at a time — the most
 * pressing wins (utils/webPayments/rules.ts → attentionFor).
 */
export type WebPaymentAttention =
  | 'amount_mismatch'        // Beds24 price ≠ the agreed amount
  | 'beds24_shows_paid'      // Beds24 says paid but we never took the money
  | 'paid_elsewhere'         // the app's own Paid status or a payment link says paid
  | 'technical_error'        // Stripe / Beds24 / our side failed; retried with back-off
  | 'needs_decision'         // 2nd decline but auto-cancel isn't allowed
  | 'beds24_sync_pending'    // paid or cancelled here, Beds24 not updated yet
  | 'amount_paid_differs'    // the guest paid a different amount than agreed
  | 'paid_booking_cancelled' // paid, then cancelled in Beds24: refund?
  | 'reinstated_unpaid'      // closed here, active again in Beds24, card removed
  | 'after_deadline';        // still unpaid after free cancellation ended

/** The in-flight attempt, kept until Stripe's answer is recorded (crash-safe replay). */
export interface PendingAttempt {
  n: number;
  trigger: WebPaymentTrigger;
  idempotencyKey: string;
  startedAt: string;
  /** What was sent — a replay with other parameters would be an idempotency error. */
  amountMinor?: number;
  description?: string;
}

/** Last Beds24 state we saw for the booking (all rows summed). */
export interface Beds24Snapshot {
  at: string;
  status: string;          // 'cancelled' when every row is cancelled
  arrival: string;
  departure: string;
  priceCzk: number;
  depositCzk: number;
  subStatus?: string;
}

/** One row of web_payment_schedules as the API and UI see it. */
export interface WebPaymentSchedule {
  id: string;
  reservationNumber: string;
  bookingIds: number[];
  arrival: string;
  departure: string;
  roomLabel: string | null;
  amountMinor: number;
  currency: string;
  guestName: string;
  guestEmail: string;
  guestPhone: string | null;
  lang: WebPaymentLang;
  voucherCode: string | null;
  termsVersion: string | null;
  source: 'website' | 'recovered';
  livemode: boolean;
  stripeCustomerId: string;
  stripePaymentMethodId: string | null;
  stripeSetupIntentId: string | null;
  stripeCheckoutSessionId: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  cardExpMonth: number | null;
  cardExpYear: number | null;
  deadlineDate: string;
  reminderAt: string | null;
  attempt1At: string;
  attempt2At: string;
  status: WebPaymentStatus;
  attemptCount: number;
  autoDeclines: number;
  firstDeclineAt: string | null;
  lastDecline: { code: string; message: string; at: string } | null;
  /** Back-off after a technical failure: no charge attempt before this. */
  retryNotBefore: string | null;
  /** Technical failures in a row (back-off grows with it); reset by any real answer. */
  retryCount: number;
  pendingAttempt: PendingAttempt | null;
  lockToken: string | null;
  lockedAt: string | null;
  openLinkSessionId: string | null;
  payToken: string;
  noAutoCancel: boolean;
  emails: Partial<Record<WebPaymentEmailKind, string>>;
  effects: Partial<Record<WebPaymentEffect, string>>;
  alerts: Record<string, string>;
  attention: WebPaymentAttention | null;
  attentionDetail: string | null;
  beds24: Beds24Snapshot | null;
  paidAt: string | null;
  paidPaymentIntentId: string | null;
  paidAmountMinor: number | null;
  paidVia: WebPaymentPaidVia | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What the drawer and the overview need — no Stripe secrets, no lock internals. */
export type WebPaymentView = Omit<WebPaymentSchedule, 'lockToken' | 'alerts' | 'pendingAttempt'> & {
  /** The effective time of the 2nd attempt (never sooner than 20 h after the 1st decline). */
  attempt2EffectiveAt: string;
  /** Full pay link for the guest. */
  payUrl: string;
  /** True while a charge is running. */
  charging: boolean;
};

export interface WebPaymentEvent {
  id: string;
  scheduleId: string;
  at: string;
  type: string;
  actor: string;
  data: Record<string, unknown>;
}

/** Admin actions on one schedule (POST /api/web-payments/[id]). */
export type WebPaymentAction =
  | { action: 'charge_now' }
  | { action: 'send_link' }
  | { action: 'set_amount'; amountCzk: number; reason: string }
  | { action: 'set_no_auto_cancel'; value: boolean }
  | { action: 'mark_paid_other'; note: string }
  | { action: 'cancel_now' }
  | { action: 'close'; reason: string };

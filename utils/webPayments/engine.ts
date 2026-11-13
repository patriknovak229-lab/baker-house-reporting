/**
 * Pay later — the engine. Every way money can move goes through here:
 *   registerSchedule      the website saved a card (or recovery found one)
 *   chargeSchedule        the job's scheduled attempts and the admin "Charge now"
 *   openPayLink           the guest's /pay/<token> page (Stripe Checkout)
 *   settleFromStripe      a payment Stripe reports (webhook, return page, checks)
 *   cancelForNonPayment   two declines (job) or an admin decision
 *   runWebPaymentsJob     the scheduled job: checks, reminders, attempts, outbox
 *   applyAdminAction      the drawer's buttons
 *
 * WHY A DOUBLE CHARGE CAN'T HAPPEN (each layer alone would usually suffice):
 *  1. One schedule per booking (unique index) and one charge path.
 *  2. A charge first CLAIMS the schedule (single conditional UPDATE); a second
 *     run, double click or parallel request finds it taken and stops.
 *  3. Before any attempt we list the customer's PaymentIntents in Stripe; one
 *     that already succeeded for this schedule settles it instead, and one that
 *     answers an earlier unrecorded attempt is recorded rather than re-asked.
 *  4. EVERY open Checkout page of the customer for this schedule — tracked or
 *     not — is expired BEFORE we charge; if the guest finished paying a split
 *     second earlier, the expire fails and we settle instead.
 *  5. The attempt's idempotency key is stored before Stripe is called and
 *     replayed after a crash or a lost answer — Stripe returns the original
 *     result instead of charging again.
 *  6. If a second successful payment still appears (webhook, return page, or
 *     the daily Stripe-vs-table check), it is refunded and the tech chat told.
 *
 * NEVER CHARGED OR CANCELLED WITHOUT A FRESH LOOK: every charge and every
 * cancellation re-reads the booking in Beds24 (cancelled? unknown? paid?) and
 * the app's own "paid another way" signals (drawer status, payment links).
 *
 * Only a decline from the guest's bank counts as a failed attempt
 * (declines.ts); nothing follows a decline until the guest has been emailed;
 * only two scheduled declines can cancel, and only while cancellation is still
 * free, in auto mode, without the ops exception. Technical failures back off
 * (rules.ts → retryBackoffMs) instead of hammering the card.
 */
import type {
  WebPaymentAction,
  WebPaymentAttention,
  WebPaymentEffect,
  WebPaymentEmailKind,
  WebPaymentMode,
  WebPaymentPaidVia,
  WebPaymentSchedule,
  WebPaymentStatus,
  WebPaymentTrigger,
  WebPaymentView,
} from '@/types/webPayment';
import { OPEN_WEB_PAYMENT_STATUSES } from '@/types/webPayment';
import { renderPayLaterEmail, type PayLaterEmailVars } from '@/utils/emailTemplates/payLater';
import { effectiveAttempt2At, formatCzk, payLaterSchedule, pragueDateOf, withinFreeCancellation } from './dates';
import { classifyChargeError, declineReason, type ChargeFailure } from './declines';
import type { Beds24Row, PayLaterIo, PaymentIntentLite } from './io';
import { msg, task } from './messages';
import type { WhenClause } from './repo';
import { attempt2DueAt, dueStep, depositsFor, retryBackoffMs, sameAmount, type BackoffKind } from './rules';

export const LOCK_STALE_MS = 10 * 60_000;
/** An unanswered attempt Stripe shows no PaymentIntent for after this long never charged: re-key it. */
const PENDING_REKEY_AFTER_MS = 15 * 60_000;
const OPEN = OPEN_WEB_PAYMENT_STATUSES;
const SETTLED: readonly WebPaymentStatus[] = ['paid', 'paid_other'];
const CLOSED_WATCHED: readonly WebPaymentStatus[] = ['paid', 'paid_other', 'cancelled', 'cancelled_unpaid'];

// ─── Small helpers ───────────────────────────────────────────────────────────

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const staleBefore = (io: PayLaterIo) => new Date(io.now().getTime() - LOCK_STALE_MS);
const lockIsFresh = (io: PayLaterIo, s: WebPaymentSchedule) =>
  !!s.lockToken && !!s.lockedAt && io.now().getTime() - Date.parse(s.lockedAt) < LOCK_STALE_MS;

export function payUrl(io: Pick<PayLaterIo, 'baseUrl'>, row: Pick<WebPaymentSchedule, 'payToken'>): string {
  return `${io.baseUrl()}/pay/${row.payToken}`;
}

/** Telegram once per key (the key carries the day when it should repeat daily). Never throws. */
async function alertOnce(io: PayLaterIo, row: WebPaymentSchedule, key: string, html: string): Promise<void> {
  try {
    const fresh = await io.repo.get(row.id);
    if (fresh?.alerts[key]) return;
    await io.techAlert(html);
    await io.repo.markJson(row.id, 'alerts', key, io.now().toISOString());
  } catch (err) {
    console.error('[web-payments] alert failed:', err);
  }
}

function emailVars(io: PayLaterIo, row: WebPaymentSchedule, extra: Partial<PayLaterEmailVars> = {}): PayLaterEmailVars {
  return {
    lang: row.lang,
    guestName: row.guestName,
    reservationNumber: row.reservationNumber,
    arrival: row.arrival,
    departure: row.departure,
    amountMinor: row.amountMinor,
    cardBrand: row.cardBrand,
    cardLast4: row.cardLast4,
    chargeAt: new Date(row.attempt1At),
    deadlineDate: row.deadlineDate,
    payUrl: payUrl(io, row),
    reminderPlanned: !!row.reminderAt && !row.emails.reminder,
    ...extra,
  };
}

/** Send a guest email; mark it sent only after SMTP accepted it (at least once). */
async function sendGuestMail(
  io: PayLaterIo,
  row: WebPaymentSchedule,
  kind: WebPaymentEmailKind,
  actor: string,
  extra: Partial<PayLaterEmailVars> = {},
): Promise<boolean> {
  const { subject, html } = renderPayLaterEmail(kind, emailVars(io, row, extra));
  try {
    await io.sendEmail(row.guestEmail, subject, html);
  } catch (err) {
    await io.repo.addEvent(row.id, 'email_failed', actor, { kind, error: errText(err) });
    await alertOnce(io, row, `email-${kind}-${pragueDateOf(io.now())}`, msg.technical(row, `${kind} email failed`, errText(err)));
    return false;
  }
  if (kind !== 'link') await io.repo.markJson(row.id, 'emails', kind, io.now().toISOString());
  await io.repo.addEvent(row.id, 'email_sent', actor, { kind, to: row.guestEmail });
  return true;
}

function paymentDescription(row: Pick<WebPaymentSchedule, 'reservationNumber' | 'arrival' | 'departure'>): string {
  // Payout matching reads the stay dates from this text (utils/stripeSettlement).
  return `Baker House ${row.reservationNumber} · Web booking ${row.arrival} → ${row.departure}`;
}

/** PaymentIntent metadata. NB: never a `reservationNumber` key — that would route
 *  payouts down the payment-link path instead of the web-booking one. */
function paymentMetadata(row: WebPaymentSchedule, trigger: WebPaymentTrigger | 'link', n?: number): Record<string, string> {
  return {
    kind: 'paylater',
    schedule_id: row.id,
    trigger,
    ...(n ? { attempt: String(n) } : {}),
    bh_reservation: row.reservationNumber,
    arrival: row.arrival,
    departure: row.departure,
  };
}

function viaFromMetadata(pi: PaymentIntentLite): WebPaymentPaidVia {
  const t = pi.metadata.trigger;
  return t === 'link' ? 'link' : t === 'manual' ? 'manual' : 'auto';
}

// ─── Registration ────────────────────────────────────────────────────────────

export interface RegistrationInput {
  checkoutSessionId: string | null;
  setupIntentId: string | null;
  customerId: string;
  paymentMethodId: string;
  livemode: boolean;
  bookingIds: number[];
  arrival: string;
  departure: string;
  amountMinor: number;
  currency: string;
  guest: { name: string; email: string; phone: string | null; lang: 'cs' | 'en' };
  roomLabel: string | null;
  voucherCode: string | null;
  termsVersion: string | null;
  attempt1At: string | null;
  deadlineDate: string | null;
}

/** Strict validation of the website's POST (contract §5). */
export function parseRegistration(body: unknown): { ok: true; input: RegistrationInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const isoDate = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  if (b.version !== 1) return { ok: false, error: 'version must be 1' };
  const customerId = str(b.customerId);
  const paymentMethodId = str(b.paymentMethodId);
  if (!customerId?.startsWith('cus_')) return { ok: false, error: 'customerId' };
  if (!paymentMethodId?.startsWith('pm_')) return { ok: false, error: 'paymentMethodId' };
  if (typeof b.livemode !== 'boolean') return { ok: false, error: 'livemode' };
  const ids = Array.isArray(b.bookingIds) ? b.bookingIds.map((x) => Number(x)) : [];
  if (ids.length === 0 || ids.length > 4 || ids.some((n) => !Number.isInteger(n) || n <= 0)) return { ok: false, error: 'bookingIds' };
  const arrival = isoDate(b.arrival);
  const departure = isoDate(b.departure);
  if (!arrival || !departure || departure <= arrival) return { ok: false, error: 'arrival/departure' };
  const amountMinor = Number(b.amountMinor);
  if (!Number.isInteger(amountMinor) || amountMinor < 100 || amountMinor > 100_000_000) return { ok: false, error: 'amountMinor' };
  if (String(b.currency ?? '').toLowerCase() !== 'czk') return { ok: false, error: 'currency must be czk' };
  const g = (b.guest ?? {}) as Record<string, unknown>;
  const name = str(g.name);
  const email = str(g.email);
  if (!name) return { ok: false, error: 'guest.name' };
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'guest.email' };
  const lang = g.lang === 'en' ? 'en' : g.lang === 'cs' ? 'cs' : null;
  if (!lang) return { ok: false, error: 'guest.lang' };
  return {
    ok: true,
    input: {
      checkoutSessionId: str(b.checkoutSessionId),
      setupIntentId: str(b.setupIntentId),
      customerId,
      paymentMethodId,
      livemode: b.livemode,
      bookingIds: ids,
      arrival,
      departure,
      amountMinor,
      currency: 'czk',
      guest: { name: name.slice(0, 200), email: email.slice(0, 200), phone: str(g.phone)?.slice(0, 50) ?? null, lang },
      roomLabel: str(b.roomLabel)?.slice(0, 80) ?? null,
      voucherCode: str(b.voucherCode)?.slice(0, 60) ?? null,
      termsVersion: str(b.termsVersion)?.slice(0, 40) ?? null,
      attempt1At: str(b.attempt1At),
      deadlineDate: isoDate(b.deadlineDate),
    },
  };
}

export type RegisterResult =
  | { ok: true; scheduleId: string; created: boolean; notify?: () => Promise<void> }
  | { ok: false; status: 400 | 409; code: string; error: string };

/**
 * Store the schedule. The confirmation email and the tech-chat lines follow:
 * inline by default, or — `notify: 'defer'` — handed back to run after the
 * HTTP response, so the website's registration call answers in well under its
 * 4 s per-attempt timeout. An email that fails either way is re-sent by the job.
 */
export async function registerSchedule(
  io: PayLaterIo,
  input: RegistrationInput,
  source: 'website' | 'recovered',
  actor: string,
  opts: { notify?: 'inline' | 'defer' } = {},
): Promise<RegisterResult> {
  const now = io.now();
  const timeline = payLaterSchedule(input.arrival, input.departure, now);
  if (!timeline) return { ok: false, status: 400, code: 'dates', error: 'Impossible stay dates' };

  if (input.livemode !== io.stripe.livemode) {
    return { ok: false, status: 409, code: 'livemode_mismatch', error: `Stripe ${input.livemode ? 'live' : 'test'} card, ${io.stripe.livemode ? 'live' : 'test'} key here` };
  }
  let pm;
  try {
    pm = await io.stripe.retrievePaymentMethod(input.paymentMethodId);
  } catch (err) {
    return { ok: false, status: 409, code: 'payment_method_missing', error: errText(err) };
  }
  if (pm.customerId !== input.customerId) {
    return { ok: false, status: 409, code: 'payment_method_not_on_customer', error: 'The card is not saved on that Stripe customer' };
  }
  if (pm.type !== 'card') return { ok: false, status: 409, code: 'not_a_card', error: `Payment method type ${pm.type}` };

  const reservationNumber = `BH-${input.bookingIds[0]}`;
  const { created, row } = await io.repo.insertIfAbsent({
    id: io.newId('WP'),
    reservationNumber,
    bookingIds: input.bookingIds,
    arrival: input.arrival,
    departure: input.departure,
    roomLabel: input.roomLabel,
    amountMinor: input.amountMinor,
    currency: 'czk',
    guestName: input.guest.name,
    guestEmail: input.guest.email,
    guestPhone: input.guest.phone,
    lang: input.guest.lang,
    voucherCode: input.voucherCode,
    termsVersion: input.termsVersion,
    source,
    livemode: input.livemode,
    stripeCustomerId: input.customerId,
    stripePaymentMethodId: input.paymentMethodId,
    stripeSetupIntentId: input.setupIntentId,
    stripeCheckoutSessionId: input.checkoutSessionId,
    cardBrand: pm.card?.brand ?? null,
    cardLast4: pm.card?.last4 ?? null,
    cardExpMonth: pm.card?.expMonth ?? null,
    cardExpYear: pm.card?.expYear ?? null,
    deadlineDate: timeline.deadlineDate,
    reminderAt: timeline.reminderAt?.toISOString() ?? null,
    attempt1At: timeline.attempt1At.toISOString(),
    attempt2At: timeline.attempt2At.toISOString(),
    status: 'scheduled',
    attemptCount: 0,
    autoDeclines: 0,
    firstDeclineAt: null,
    lastDecline: null,
    retryNotBefore: null,
    retryCount: 0,
    pendingAttempt: null,
    lockToken: null,
    lockedAt: null,
    openLinkSessionId: null,
    payToken: io.newToken(),
    noAutoCancel: false,
    emails: {},
    effects: {},
    alerts: {},
    attention: null,
    attentionDetail: null,
    beds24: null,
    paidAt: null,
    paidPaymentIntentId: null,
    paidAmountMinor: null,
    paidVia: null,
    cancelledAt: null,
  });

  if (!created) {
    if (row.stripeCheckoutSessionId && input.checkoutSessionId && row.stripeCheckoutSessionId !== input.checkoutSessionId) {
      await alertOnce(io, row, `second-card-${input.checkoutSessionId}`,
        msg.technical(row, 'second card registered for the same booking', `existing ${row.stripeCheckoutSessionId}, new ${input.checkoutSessionId} — kept the first`));
    }
    return { ok: true, scheduleId: row.id, created: false };
  }

  await io.repo.addEvent(row.id, 'registered', actor, {
    source,
    attempt1At: row.attempt1At,
    deadlineDate: row.deadlineDate,
    amountMinor: row.amountMinor,
    websiteAttempt1At: input.attempt1At,
    websiteDeadline: input.deadlineDate,
  });

  const notify = async () => {
    // The guest was shown the website's dates; ours must match (contract §1).
    if ((input.attempt1At && input.attempt1At !== row.attempt1At) || (input.deadlineDate && input.deadlineDate !== row.deadlineDate)) {
      await alertOnce(io, row, 'dates-mismatch',
        msg.technical(row, 'website and reporting dates differ', `website ${input.attempt1At} / ${input.deadlineDate}, reporting ${row.attempt1At} / ${row.deadlineDate} — reporting's are used`));
    }
    if (!timeline.qualifies) {
      await alertOnce(io, row, 'registered-late',
        msg.technical(row, 'registered after its 1st charge date', 'it is charged on the next run'));
    }
    await alertOnce(io, row, 'registered', source === 'recovered' ? msg.recovered(row, timeline.attempt1At) : msg.registered(row, timeline.attempt1At));
    await sendGuestMail(io, row, 'scheduled', actor, { reminderPlanned: !!row.reminderAt });
  };
  if (opts.notify === 'defer') return { ok: true, scheduleId: row.id, created: true, notify };
  await notify();
  return { ok: true, scheduleId: row.id, created: true };
}

// ─── What Beds24 says about the booking ─────────────────────────────────────

export type BookingView =
  | { kind: 'missing'; missing: number[] }
  | { kind: 'cancelled'; subStatus: string | null }
  | { kind: 'active'; live: Beds24Row[]; master: Beds24Row; priceCzk: number; depositCzk: number };

/** Every row must be there; all cancelled = cancelled; otherwise the active rows summed. */
export function bookingView(s: Pick<WebPaymentSchedule, 'bookingIds'>, rowsById: Map<number, Beds24Row>): BookingView {
  const missing = s.bookingIds.filter((id) => !rowsById.has(id));
  if (missing.length > 0) return { kind: 'missing', missing };
  const rows = s.bookingIds.map((id) => rowsById.get(id)!);
  const master = rows[0];
  const live = rows.filter((r) => r.status !== 'cancelled');
  if (live.length === 0) return { kind: 'cancelled', subStatus: master.subStatus };
  return {
    kind: 'active',
    live,
    master,
    priceCzk: live.reduce((sum, r) => sum + r.price, 0),
    depositCzk: live.reduce((sum, r) => sum + r.deposit, 0),
  };
}

const paidInBeds24 = (v: Extract<BookingView, { kind: 'active' }>) => v.priceCzk > 0 && v.depositCzk >= v.priceCzk - 0.5;

async function readBooking(io: PayLaterIo, s: WebPaymentSchedule): Promise<BookingView | { kind: 'error'; message: string }> {
  try {
    return bookingView(s, await io.beds24.fetchBookings(s.bookingIds));
  } catch (err) {
    return { kind: 'error', message: errText(err) };
  }
}

/**
 * The booking is cancelled in Beds24 but the schedule is still open. Ours (an
 * interrupted non-payment cancellation, or ops choosing "non payment" after a
 * decline) → cancelled_unpaid, with its email and voucher; otherwise the guest
 * or ops cancelled → cancelled, quietly. Either way nothing is charged.
 */
async function closeCancelledBooking(
  io: PayLaterIo,
  s: WebPaymentSchedule,
  subStatus: string | null,
  actor: string,
  when: WhenClause,
): Promise<WebPaymentSchedule | null> {
  const nonPayment = !!s.effects.cancelRequested || (subStatus === 'nonPayment' && s.status === 'failed');
  const closed = await io.repo.patch(
    s.id,
    {
      status: nonPayment ? 'cancelled_unpaid' : 'cancelled',
      cancelledAt: io.now().toISOString(),
      attention: null,
      attentionDetail: null,
      pendingAttempt: null,
      retryNotBefore: null,
    },
    { ...when, statusIn: OPEN },
  );
  if (!closed) return null;
  await io.repo.addEvent(s.id, nonPayment ? 'cancelled' : 'booking_cancelled', actor, { seenInBeds24: true, subStatus });
  if (nonPayment) await io.repo.markJson(s.id, 'effects', 'beds24Cancelled', io.now().toISOString());
  await completeEffects(io, closed, actor);
  return closed;
}

// ─── Settling a payment Stripe reports ──────────────────────────────────────

export type SettleOutcome = 'paid' | 'already' | 'duplicate_refunded' | 'duplicate_refund_failed' | 'not_succeeded' | 'not_ours';

/**
 * A succeeded PaymentIntent for this schedule — from our own charge, the pay
 * link, the webhook or a check. Idempotent; a second, different payment for a
 * schedule that is already settled (or cancelled) is refunded.
 */
export async function settleFromStripe(
  io: PayLaterIo,
  scheduleId: string,
  pi: PaymentIntentLite,
  via: WebPaymentPaidVia,
  actor: string,
): Promise<SettleOutcome> {
  if (pi.status !== 'succeeded') return 'not_succeeded';
  if (pi.metadata.schedule_id && pi.metadata.schedule_id !== scheduleId) return 'not_ours';
  const paid = pi.amountReceived || pi.amount;
  // The tax point is when Stripe took the money, not when we noticed.
  const paidAt = new Date((pi.created || Math.floor(io.now().getTime() / 1000)) * 1000).toISOString();
  const updated = await io.repo.patch(
    scheduleId,
    {
      status: 'paid',
      paidAt,
      paidPaymentIntentId: pi.id,
      paidAmountMinor: paid,
      paidVia: via,
      pendingAttempt: null,
      retryNotBefore: null,
      retryCount: 0,
      attention: null,
      attentionDetail: null,
    },
    { statusIn: OPEN },
  );
  if (updated) {
    await io.repo.addEvent(scheduleId, 'paid', actor, { paymentIntentId: pi.id, via, amountMinor: paid });
    if (paid !== updated.amountMinor) {
      // e.g. paid on a page opened before an admin changed the amount — never silently "fully paid".
      const detail = `paid ${formatCzk(paid)}, agreed ${formatCzk(updated.amountMinor)}`;
      await io.repo.patch(scheduleId, { attention: 'amount_paid_differs', attentionDetail: detail });
      await alertOnce(io, updated, `paid-differs-${pi.id}`, msg.technical(updated, 'paid a different amount than agreed', `${detail}. Beds24 is marked with what was actually paid.`));
      await io.addTask(updated.reservationNumber, 'paylater-paid-differs', `Pay later: the guest ${detail}. Settle the difference with the guest.`);
    }
    await completeEffects(io, (await io.repo.get(scheduleId)) ?? updated, actor);
    return 'paid';
  }

  const cur = await io.repo.get(scheduleId);
  if (!cur) return 'not_ours';
  if (cur.status === 'paid' && cur.paidPaymentIntentId === pi.id) return 'already';
  // Settled another way, or cancelled — this money must go back.
  return refundDuplicate(io, cur, pi, actor);
}

async function refundDuplicate(
  io: PayLaterIo,
  row: WebPaymentSchedule,
  pi: PaymentIntentLite,
  actor: string,
): Promise<SettleOutcome> {
  const why = row.status === 'paid' ? `already paid by ${row.paidPaymentIntentId}` : `schedule is ${row.status}`;
  if (pi.amountRefunded > 0) return 'duplicate_refunded'; // someone already returned it
  try {
    const refund = await io.stripe.refundPaymentIntent(pi.id, `wp_dup_${pi.id}`, {
      source: 'reporting-paylater-duplicate',
      schedule_id: row.id,
      reservation: row.reservationNumber,
    });
    await io.repo.addEvent(row.id, 'duplicate_refunded', actor, { paymentIntentId: pi.id, refundId: refund.id, why });
    await alertOnce(io, row, `dup-${pi.id}`, msg.duplicateRefunded(row, pi.id, pi.amountReceived || pi.amount, why));
    return 'duplicate_refunded';
  } catch (err) {
    await io.repo.addEvent(row.id, 'duplicate_refund_failed', actor, { paymentIntentId: pi.id, error: errText(err) });
    await alertOnce(io, row, `dup-fail-${pi.id}`, msg.duplicateRefundFailed(row, pi.id, errText(err)));
    return 'duplicate_refund_failed';
  }
}

// ─── Before any money moves: Stripe, open pages ─────────────────────────────

type StripeCheck =
  | { kind: 'paid' }
  | { kind: 'in_progress' }
  | { kind: 'clear'; pendingPi: PaymentIntentLite | null }
  | { kind: 'error'; message: string };

/** Guarantee 3: what Stripe already holds for this schedule. */
async function checkStripe(io: PayLaterIo, row: WebPaymentSchedule, actor: string): Promise<StripeCheck> {
  let pis: PaymentIntentLite[];
  try {
    pis = await io.stripe.listPaymentIntents(row.stripeCustomerId);
  } catch (err) {
    return { kind: 'error', message: `Stripe list failed: ${errText(err)}` };
  }
  const mine = pis.filter((p) => p.metadata.schedule_id === row.id);
  const succeeded = mine.find((p) => p.status === 'succeeded');
  if (succeeded) {
    await settleFromStripe(io, row.id, succeeded, viaFromMetadata(succeeded), actor);
    return { kind: 'paid' };
  }
  if (mine.some((p) => p.status === 'processing')) return { kind: 'in_progress' };
  const n = row.pendingAttempt?.n;
  const pendingPi = n ? (mine.find((p) => p.metadata.attempt === String(n)) ?? null) : null;
  return { kind: 'clear', pendingPi };
}

/**
 * Guarantee 4: expire every open Checkout page that would pay this schedule —
 * the tracked one AND any a double click or a mail scanner opened. A page that
 * can't be expired because the guest just paid on it settles the schedule.
 */
async function closeOpenLinkPages(io: PayLaterIo, row: WebPaymentSchedule, actor: string): Promise<'paid' | 'clear' | { error: string }> {
  let sessions;
  try {
    sessions = await io.stripe.listOpenCheckoutSessions(row.stripeCustomerId);
  } catch (err) {
    return { error: `Stripe pages could not be listed: ${errText(err)}` };
  }
  const ids = new Set(sessions.filter((s) => s.metadata.schedule_id === row.id).map((s) => s.id));
  if (row.openLinkSessionId) ids.add(row.openLinkSessionId);
  for (const id of ids) {
    try {
      await io.stripe.expireCheckoutSession(id);
    } catch (err) {
      let s;
      try {
        s = await io.stripe.retrieveCheckoutSession(id);
      } catch (err2) {
        return { error: `Pay-link page check failed: ${errText(err)} / ${errText(err2)}` };
      }
      if (s.status === 'complete' && s.paymentStatus === 'paid' && s.paymentIntentId) {
        const pi = await io.stripe.retrievePaymentIntent(s.paymentIntentId);
        await settleFromStripe(io, row.id, pi, 'link', actor);
        return 'paid';
      }
      if (s.status === 'open') return { error: `Pay-link page could not be closed: ${errText(err)}` };
    }
  }
  if (row.openLinkSessionId) {
    await io.repo.patch(row.id, { openLinkSessionId: null }, { openLinkSessionIdIs: row.openLinkSessionId });
  }
  return 'clear';
}

// ─── Charging ────────────────────────────────────────────────────────────────

export type ChargeOutcome =
  | { outcome: 'paid'; paymentIntentId: string }
  | { outcome: 'already_paid' }
  | { outcome: 'declined'; code: string; message: string }
  | { outcome: 'retry'; code: string; message: string }
  | { outcome: 'needs_admin'; code: string; message: string }
  | { outcome: 'unknown'; message: string }
  | { outcome: 'in_progress' }
  | { outcome: 'blocked'; reason: string }
  | { outcome: 'busy' }
  | { outcome: 'not_chargeable'; status: WebPaymentStatus }
  | { outcome: 'not_found' };

export async function chargeSchedule(
  io: PayLaterIo,
  scheduleId: string,
  trigger: WebPaymentTrigger,
  actor: string,
): Promise<ChargeOutcome> {
  const token = io.newToken();
  const row = await io.repo.claim(scheduleId, token, staleBefore(io), OPEN);
  if (!row) {
    const cur = await io.repo.get(scheduleId);
    if (!cur) return { outcome: 'not_found' };
    if (!OPEN.includes(cur.status)) return { outcome: 'not_chargeable', status: cur.status };
    return { outcome: 'busy' };
  }
  try {
    return await chargeClaimed(io, row, token, trigger, actor);
  } finally {
    await io.repo.release(scheduleId, token).catch(() => {});
  }
}

/** A technical failure: back off (growing), flag it, alert once a day. Nothing was charged. */
async function technicalFailure(
  io: PayLaterIo,
  row: WebPaymentSchedule,
  token: string | null,
  kind: Exclude<BackoffKind, 'blocked'>,
  code: string,
  message: string,
  patchExtra: Parameters<PayLaterIo['repo']['patch']>[1] = {},
): Promise<{ outcome: 'retry' | 'needs_admin' | 'unknown'; code: string; message: string }> {
  const now = io.now();
  const retryCount = row.retryCount + 1;
  await io.repo.patch(
    row.id,
    {
      ...patchExtra,
      retryCount,
      retryNotBefore: new Date(now.getTime() + retryBackoffMs(kind, retryCount)).toISOString(),
      attention: 'technical_error',
      attentionDetail: `${code}: ${message}`.slice(0, 500),
    },
    token ? { lockToken: token } : undefined,
  );
  await io.repo.addEvent(row.id, `attempt_${kind}`, 'job', { code, message, retryCount });
  await alertOnce(io, row, `tech-${code}-${pragueDateOf(now)}`,
    kind === 'unknown' ? msg.unknownOutcome(row, message) : msg.technical(row, kind === 'retry' ? 'charge to retry later' : 'charge needs an admin', `${code}: ${message}`));
  if (kind === 'needs_admin') {
    const tk = task.technical(`${code}: ${message}`);
    await io.addTask(row.reservationNumber, tk.id, tk.text);
  }
  return { outcome: kind, code, message };
}

/** Something says this booking must not be charged (or cancelled) now: flag it, wait for an admin. */
async function blockedFor(
  io: PayLaterIo,
  row: WebPaymentSchedule,
  token: string | null,
  attention: WebPaymentAttention,
  detail: string,
): Promise<{ outcome: 'blocked'; reason: string }> {
  const now = io.now();
  await io.repo.patch(
    row.id,
    {
      attention,
      attentionDetail: detail.slice(0, 500),
      retryNotBefore: new Date(now.getTime() + retryBackoffMs('blocked', 1)).toISOString(),
    },
    token ? { lockToken: token } : undefined,
  );
  if (attention === 'beds24_shows_paid') {
    await alertOnce(io, row, 'beds24-paid', msg.beds24ShowsPaid(row));
    const tk = task.beds24Paid();
    await io.addTask(row.reservationNumber, tk.id, tk.text);
  } else if (attention === 'paid_elsewhere') {
    await alertOnce(io, row, 'paid-elsewhere', msg.technical(row, 'already paid another way', `${detail}. Nothing is charged or cancelled until you check it — "Paid another way" closes it.`));
    await io.addTask(row.reservationNumber, 'paylater-paid-elsewhere', `Pay later: ${detail}. If the guest has paid, use "Paid another way" in the drawer; otherwise reset the payment status.`);
  } else {
    await alertOnce(io, row, `blocked-${attention}-${pragueDateOf(now)}`, msg.technical(row, 'charge blocked', detail));
  }
  return { outcome: 'blocked', reason: detail };
}

async function chargeClaimed(
  io: PayLaterIo,
  row: WebPaymentSchedule,
  token: string,
  trigger: WebPaymentTrigger,
  actor: string,
): Promise<ChargeOutcome> {
  const now = io.now();
  if (!row.stripePaymentMethodId) return { outcome: 'blocked', reason: 'No saved card on this booking' };
  if (row.livemode !== io.stripe.livemode) return { outcome: 'blocked', reason: 'Stripe test/live mismatch' };

  // 1. Already paid in Stripe? (also learns what happened to an unanswered attempt)
  const stripeCheck = await checkStripe(io, row, actor);
  if (stripeCheck.kind === 'paid') return { outcome: 'already_paid' };
  if (stripeCheck.kind === 'in_progress') return { outcome: 'in_progress' };
  if (stripeCheck.kind === 'error') return technicalFailure(io, row, token, 'retry', 'stripe_check', stripeCheck.message);

  // 2. A fresh look at the booking: never charge a cancelled, unknown or already-paid one.
  const view = await readBooking(io, row);
  if (view.kind === 'error') return technicalFailure(io, row, token, 'retry', 'beds24_read', view.message);
  if (view.kind === 'missing') return blockedFor(io, row, token, 'technical_error', `Beds24 doesn't return booking ${view.missing.join(', ')}`);
  if (view.kind === 'cancelled') {
    await closeCancelledBooking(io, row, view.subStatus, actor, { lockToken: token });
    return { outcome: 'not_chargeable', status: 'cancelled' };
  }
  if (paidInBeds24(view)) return blockedFor(io, row, token, 'beds24_shows_paid', `Beds24 deposit ${view.depositCzk} Kč of ${view.priceCzk} Kč`);
  let elsewhere: string | undefined;
  try {
    elsewhere = (await io.paidElsewhere([row.reservationNumber])).get(row.reservationNumber);
  } catch (err) {
    return technicalFailure(io, row, token, 'retry', 'paid_elsewhere_check', errText(err));
  }
  if (elsewhere) return blockedFor(io, row, token, 'paid_elsewhere', elsewhere);

  // 3. An unanswered earlier attempt: record Stripe's answer, or retire it.
  let pending = row.pendingAttempt;
  if (pending) {
    const pi = stripeCheck.pendingPi;
    if (pi && ['requires_payment_method', 'requires_action', 'canceled'].includes(pi.status)) {
      // Stripe answered and we never recorded it: record that decline, don't ask the bank again.
      return recordFailure(io, row, token, pending, {
        kind: 'decline',
        code: pi.lastErrorCode || (pi.status === 'requires_action' ? 'authentication_required' : 'card_declined'),
        message: pi.lastErrorMessage || pi.status,
      }, actor);
    }
    const sameParams =
      (pending.amountMinor ?? row.amountMinor) === row.amountMinor &&
      (pending.description ?? paymentDescription(row)) === paymentDescription(row);
    if (!pi && (now.getTime() - Date.parse(pending.startedAt) > PENDING_REKEY_AFTER_MS || !sameParams)) {
      // Nothing reached Stripe's charge step (a stored 500 would replay for a day, and
      // changed parameters would be an idempotency error): a fresh key is safe.
      await io.repo.addEvent(row.id, 'attempt_retired', actor, { n: pending.n, key: pending.idempotencyKey, sameParams });
      pending = null;
    }
  }

  // 4. Close every open pay-link page — tracked or not — before taking money.
  const pages = await closeOpenLinkPages(io, row, actor);
  if (pages === 'paid') return { outcome: 'already_paid' };
  if (typeof pages === 'object') return technicalFailure(io, row, token, 'retry', 'pay_link_pages', pages.error);

  // 5. The attempt's key is stored before Stripe hears about it.
  if (!pending) {
    const n = Math.max(row.attemptCount, row.pendingAttempt?.n ?? 0) + 1;
    pending = {
      n,
      trigger,
      idempotencyKey: `wp_${row.id}_${n}`,
      startedAt: now.toISOString(),
      amountMinor: row.amountMinor,
      description: paymentDescription(row),
    };
    const saved = await io.repo.patch(row.id, { pendingAttempt: pending }, { lockToken: token });
    if (!saved) return { outcome: 'busy' };
  }
  await io.repo.addEvent(row.id, 'attempt_started', actor, { n: pending.n, trigger: pending.trigger, key: pending.idempotencyKey });

  let failure: ChargeFailure;
  try {
    const pi = await io.stripe.createOffSessionPayment(
      {
        amountMinor: pending.amountMinor ?? row.amountMinor,
        currency: row.currency,
        customerId: row.stripeCustomerId,
        paymentMethodId: row.stripePaymentMethodId,
        description: pending.description ?? paymentDescription(row),
        metadata: paymentMetadata(row, pending.trigger, pending.n),
      },
      pending.idempotencyKey,
    );
    if (pi.status === 'succeeded') {
      await io.repo.patch(row.id, { attemptCount: pending.n }, { lockToken: token });
      await io.repo.addEvent(row.id, 'attempt_succeeded', actor, { n: pending.n, paymentIntentId: pi.id });
      await settleFromStripe(io, row.id, pi, pending.trigger === 'manual' ? 'manual' : 'auto', actor);
      return { outcome: 'paid', paymentIntentId: pi.id };
    }
    if (pi.status === 'processing') {
      await io.repo.addEvent(row.id, 'attempt_processing', actor, { n: pending.n, paymentIntentId: pi.id });
      return { outcome: 'in_progress' };
    }
    // requires_payment_method / requires_action: the bank wants the guest.
    failure = {
      kind: 'decline',
      code: pi.lastErrorCode || (pi.status === 'requires_action' ? 'authentication_required' : 'card_declined'),
      message: pi.lastErrorMessage || pi.status,
    };
  } catch (err) {
    failure = classifyChargeError(err);
  }

  return recordFailure(io, row, token, pending, failure, actor);
}

async function noteTechnical(io: PayLaterIo, row: WebPaymentSchedule, what: string, detail: string): Promise<void> {
  await io.repo.patch(row.id, { attention: 'technical_error', attentionDetail: `${what}: ${detail}`.slice(0, 500) });
  await io.repo.addEvent(row.id, 'technical_error', 'job', { what, detail });
  await alertOnce(io, row, `tech-${what}-${pragueDateOf(io.now())}`, msg.technical(row, what, detail));
}

async function recordFailure(
  io: PayLaterIo,
  row: WebPaymentSchedule,
  token: string,
  pending: NonNullable<WebPaymentSchedule['pendingAttempt']>,
  failure: ChargeFailure,
  actor: string,
): Promise<ChargeOutcome> {
  const now = io.now();
  const nowIso = now.toISOString();
  await io.repo.addEvent(row.id, `attempt_${failure.kind}`, actor, { n: pending.n, trigger: pending.trigger, code: failure.code, message: failure.message });

  if (failure.kind === 'unknown') {
    // Keep pendingAttempt: the next try learns the true answer from Stripe (or re-keys after 15 min).
    const r = await technicalFailure(io, row, token, 'unknown', failure.code, failure.message);
    return { outcome: 'unknown', message: r.message };
  }
  if (failure.kind === 'retry' || failure.kind === 'needs_admin') {
    return technicalFailure(io, row, token, failure.kind, failure.code, failure.message, { pendingAttempt: null, attemptCount: pending.n });
  }

  // A real decline.
  const scheduled = pending.trigger === 'auto1' || pending.trigger === 'auto2';
  const autoDeclines = scheduled ? row.autoDeclines + 1 : row.autoDeclines;
  const updated = await io.repo.patch(
    row.id,
    {
      pendingAttempt: null,
      attemptCount: pending.n,
      lastDecline: { code: failure.code, message: failure.message, at: nowIso },
      retryCount: 0,
      retryNotBefore: null,
      ...(scheduled ? { autoDeclines, status: 'failed' as const, firstDeclineAt: row.firstDeclineAt ?? nowIso } : {}),
      attention: null,
      attentionDetail: null,
    },
    { lockToken: token },
  );
  const fresh = updated ?? row;

  if (!scheduled) {
    await alertOnce(io, row, `manual-decline-${pending.n}`, msg.declinedManual(row, failure.code, actor));
    return { outcome: 'declined', code: failure.code, message: failure.message };
  }

  if (autoDeclines === 1) {
    // The guest must be told; if this email fails the job re-sends it, and nothing
    // else happens until it went out (rules.ts → failed_email).
    await sendFailedEmail(io, fresh, actor);
    const payBy = effectiveAttempt2At(new Date(fresh.attempt2At), io.now());
    await alertOnce(io, fresh, 'declined-1', msg.declined1(fresh, failure.code, payBy));
    const tk = task.declined(failure.code, payBy);
    await io.addTask(fresh.reservationNumber, tk.id, tk.text);
  }
  // autoDeclines === 2: the job cancels (or asks an admin) right after this.
  return { outcome: 'declined', code: failure.code, message: failure.message };
}

/** The "payment failed" email: pay by 20 h from NOW at the earliest (the guest's real window). */
async function sendFailedEmail(io: PayLaterIo, row: WebPaymentSchedule, actor: string): Promise<boolean> {
  const payBy = effectiveAttempt2At(new Date(row.attempt2At), io.now());
  return sendGuestMail(io, row, 'failed', actor, { payBy, reason: declineReason(row.lastDecline?.code ?? 'card_declined', row.lang) });
}

// ─── Cancelling for non-payment ──────────────────────────────────────────────

export type CancelOutcome =
  | { outcome: 'cancelled' }
  | { outcome: 'paid_instead' }
  | { outcome: 'busy' }
  | { outcome: 'blocked'; reason: string }
  | { outcome: 'not_cancellable'; status: WebPaymentStatus }
  | { outcome: 'error'; message: string }
  | { outcome: 'not_found' };

export async function cancelForNonPayment(io: PayLaterIo, scheduleId: string, actor: string): Promise<CancelOutcome> {
  const token = io.newToken();
  const row = await io.repo.claim(scheduleId, token, staleBefore(io), OPEN);
  if (!row) {
    const cur = await io.repo.get(scheduleId);
    if (!cur) return { outcome: 'not_found' };
    if (!OPEN.includes(cur.status)) return { outcome: 'not_cancellable', status: cur.status };
    return { outcome: 'busy' };
  }
  try {
    // Never cancel a booking the guest has just paid.
    const stripeCheck = await checkStripe(io, row, actor);
    if (stripeCheck.kind === 'paid') return { outcome: 'paid_instead' };
    if (stripeCheck.kind === 'in_progress') return { outcome: 'busy' };
    if (stripeCheck.kind === 'error') {
      await technicalFailure(io, row, token, 'retry', 'stripe_check', stripeCheck.message);
      return { outcome: 'error', message: stripeCheck.message };
    }

    // Nor one Beds24 or the app already counts as paid.
    const view = await readBooking(io, row);
    if (view.kind === 'error') {
      await technicalFailure(io, row, token, 'retry', 'beds24_read', view.message);
      return { outcome: 'error', message: view.message };
    }
    if (view.kind === 'missing') return blockedFor(io, row, token, 'technical_error', `Beds24 doesn't return booking ${view.missing.join(', ')}`);
    if (view.kind === 'active' && paidInBeds24(view)) {
      return blockedFor(io, row, token, 'beds24_shows_paid', `Beds24 deposit ${view.depositCzk} Kč of ${view.priceCzk} Kč`);
    }
    let elsewhere: string | undefined;
    try {
      elsewhere = (await io.paidElsewhere([row.reservationNumber])).get(row.reservationNumber);
    } catch (err) {
      await technicalFailure(io, row, token, 'retry', 'paid_elsewhere_check', errText(err));
      return { outcome: 'error', message: errText(err) };
    }
    if (elsewhere) return blockedFor(io, row, token, 'paid_elsewhere', elsewhere);

    const pages = await closeOpenLinkPages(io, row, actor);
    if (pages === 'paid') return { outcome: 'paid_instead' };
    if (typeof pages === 'object') {
      await technicalFailure(io, row, token, 'retry', 'pay_link_pages', pages.error);
      return { outcome: 'error', message: pages.error };
    }

    // Remember the intent before touching Beds24: a crash after Beds24 cancelled is
    // finished by the next job run as THIS cancellation (with its email), not a quiet one.
    await io.repo.markJson(row.id, 'effects', 'cancelRequested', io.now().toISOString());
    if (view.kind === 'active') {
      const note = `Zrušeno ${pragueDateOf(io.now())}: platba ${formatCzk(row.amountMinor)} neproběhla (pay later, ${row.reservationNumber}).`;
      try {
        await io.beds24.cancelNonPayment(row.bookingIds, note);
      } catch (err) {
        await technicalFailure(io, row, token, 'retry', 'beds24_cancel', errText(err));
        return { outcome: 'error', message: errText(err) };
      }
    }

    const nowIso = io.now().toISOString();
    const updated = await io.repo.patch(
      row.id,
      { status: 'cancelled_unpaid', cancelledAt: nowIso, attention: null, attentionDetail: null, pendingAttempt: null, retryNotBefore: null },
      { lockToken: token },
    );
    if (!updated) return { outcome: 'busy' };
    await io.repo.addEvent(row.id, 'cancelled', actor, { reason: 'non_payment', lastDecline: row.lastDecline });
    await io.repo.markJson(row.id, 'effects', 'beds24Cancelled', nowIso);
    await completeEffects(io, updated, actor);
    return { outcome: 'cancelled' };
  } finally {
    await io.repo.release(scheduleId, token).catch(() => {});
  }
}

// ─── The outbox: side effects after a status change ─────────────────────────

/**
 * Everything that must eventually follow a settled or closed schedule. Each
 * step is idempotent and marked when done; the job re-runs this until every
 * step is marked, so a crash or an outage only delays them.
 */
export async function completeEffects(io: PayLaterIo, rowIn: WebPaymentSchedule, actor: string): Promise<void> {
  const row = (await io.repo.get(rowIn.id)) ?? rowIn;
  const done = (k: WebPaymentEffect) => !!row.effects[k];
  const mark = (k: WebPaymentEffect) => io.repo.markJson(row.id, 'effects', k, io.now().toISOString());
  const settled = SETTLED.includes(row.status);
  const viaStripe = row.status === 'paid';
  if (OPEN.includes(row.status)) return;

  // 1. Beds24 shows what was paid (deposits = each row's share of the payment).
  if (settled && !done('beds24Paid')) {
    try {
      const rows = await io.beds24.fetchBookings(row.bookingIds);
      const live = row.bookingIds.map((id) => rows.get(id)).filter((r): r is Beds24Row => !!r && r.status !== 'cancelled');
      if (live.length === 0) {
        // Paid, but the booking is cancelled in Beds24: someone must refund (or reinstate).
        await io.repo.patch(row.id, { attention: 'paid_booking_cancelled', attentionDetail: 'Paid, but every booking row is cancelled in Beds24' });
        await alertOnce(io, row, 'paid-cancelled', msg.technical(row, 'paid booking is cancelled in Beds24', 'Refund the guest (drawer → Refund via Stripe) if the cancellation stands.'));
        await io.addTask(row.reservationNumber, 'paylater-refund', 'Pay later: this booking was paid but is cancelled in Beds24. Refund the guest if the cancellation stands.');
      } else {
        const paidCzk = viaStripe ? (row.paidAmountMinor ?? row.amountMinor) / 100 : live.reduce((s, r) => s + r.price, 0);
        const how = viaStripe ? `kartou přes Stripe (${row.paidPaymentIntentId})` : 'jinak (označil admin)';
        await io.beds24.markPaid(depositsFor(live, paidCzk), `Zaplaceno ${pragueDateOf(io.now())} ${how}, ${paidCzk.toLocaleString('cs-CZ')} Kč`);
        if (row.attention === 'beds24_sync_pending') await io.repo.patch(row.id, { attention: null, attentionDetail: null });
      }
      await mark('beds24Paid');
    } catch (err) {
      if (row.attention !== 'amount_paid_differs') {
        await io.repo.patch(row.id, { attention: 'beds24_sync_pending', attentionDetail: `Beds24 not updated yet: ${errText(err)}`.slice(0, 500) });
      }
      await alertOnce(io, row, `beds24-paid-${pragueDateOf(io.now())}`, msg.technical(row, 'Beds24 not marked paid yet', errText(err)));
    }
  }

  // 2. The Stripe payment log VAT reads — web-booking shaped (no reservation number, stay dates in the text).
  if (viaStripe && !done('paymentLogged') && row.paidPaymentIntentId) {
    try {
      await io.logPayment({
        sessionId: `paylater_${row.livemode ? 'live' : 'test'}_${row.paidPaymentIntentId}`,
        description: `Web booking ${row.arrival} → ${row.departure} · pay later`,
        amountCzk: (row.paidAmountMinor ?? row.amountMinor) / 100,
        guestEmail: row.guestEmail,
        guestPhone: row.guestPhone ?? '',
        guestName: row.guestName,
        paidAt: row.paidAt ?? io.now().toISOString(),
      });
      await mark('paymentLogged');
    } catch (err) {
      await alertOnce(io, row, `log-${pragueDateOf(io.now())}`, msg.technical(row, 'payment log write failed (VAT)', errText(err)));
    }
  }

  // 3. Guest emails.
  if (viaStripe && !row.emails.receipt) {
    await sendGuestMail(io, row, 'receipt', actor, {
      paidAt: row.paidAt ? new Date(row.paidAt) : io.now(),
      amountMinor: row.paidAmountMinor ?? row.amountMinor,
    });
  }
  if (row.status === 'cancelled_unpaid') {
    let restored: string | null = null;
    if (row.voucherCode && !done('voucherRestored')) {
      try {
        const r = await io.restoreVoucher(row.voucherCode, row.reservationNumber);
        await mark('voucherRestored');
        if (r === 'restored') {
          restored = row.voucherCode;
          await io.repo.addEvent(row.id, 'voucher_restored', actor, { code: row.voucherCode });
        }
      } catch (err) {
        await alertOnce(io, row, `voucher-${pragueDateOf(io.now())}`, msg.technical(row, 'voucher not restored', errText(err)));
      }
    }
    // The cancellation email goes out even if the voucher step failed (it is retried on its own).
    if (!row.emails.cancelled) await sendGuestMail(io, row, 'cancelled', actor, { voucherRestored: restored });
  }

  // 4. The saved card goes (Patrik: never keep cards longer than needed).
  if (row.stripePaymentMethodId && !done('cardDeleted')) {
    try {
      await io.stripe.detachPaymentMethod(row.stripePaymentMethodId);
      await io.repo.patch(row.id, { stripePaymentMethodId: null });
      await mark('cardDeleted');
      await io.repo.addEvent(row.id, 'card_deleted', actor, {});
    } catch (err) {
      const m = errText(err);
      if (/no such payment ?method|not attached|resource_missing/i.test(m)) {
        await io.repo.patch(row.id, { stripePaymentMethodId: null });
        await mark('cardDeleted');
      } else {
        await alertOnce(io, row, `card-${pragueDateOf(io.now())}`, msg.technical(row, 'saved card not removed yet', m));
      }
    }
  } else if (!row.stripePaymentMethodId && !done('cardDeleted')) {
    await mark('cardDeleted');
  }

  // 5. No pay-link page left open — tracked or not.
  if (!done('linkExpired')) {
    try {
      const open = await io.stripe.listOpenCheckoutSessions(row.stripeCustomerId);
      const ids = new Set(open.filter((s) => s.metadata.schedule_id === row.id).map((s) => s.id));
      if (row.openLinkSessionId) ids.add(row.openLinkSessionId);
      for (const id of ids) await io.stripe.expireCheckoutSession(id).catch(() => {});
      if (row.openLinkSessionId) await io.repo.patch(row.id, { openLinkSessionId: null });
      await mark('linkExpired');
    } catch (err) {
      await alertOnce(io, row, `link-close-${pragueDateOf(io.now())}`, msg.technical(row, 'pay-link pages not closed yet', errText(err)));
    }
  }

  // 6. Our Pending tasks on the booking are done.
  if (!done('tasksResolved')) {
    try {
      await io.resolveTasks(row.reservationNumber, 'paylater-');
      await mark('tasksResolved');
    } catch (err) {
      await alertOnce(io, row, `tasks-${pragueDateOf(io.now())}`, msg.technical(row, 'tasks not resolved', errText(err)));
    }
  }

  // 7. One line to the tech chat.
  if (row.status === 'paid') await alertOnce(io, row, 'paid', msg.paid(row, row.paidVia ?? 'stripe'));
  if (row.status === 'cancelled_unpaid') await alertOnce(io, row, 'cancelled', msg.cancelled(row, row.lastDecline?.code ?? 'declined'));
  if (row.status === 'cancelled') await alertOnce(io, row, 'booking-cancelled', msg.bookingCancelled(row));
}

/** Effects still missing for a closed schedule (the job's outbox sweep). */
export function missingEffects(row: WebPaymentSchedule): string[] {
  if (OPEN.includes(row.status)) return [];
  const out: string[] = [];
  const settled = SETTLED.includes(row.status);
  if (settled && !row.effects.beds24Paid) out.push('beds24Paid');
  if (row.status === 'paid' && !row.effects.paymentLogged) out.push('paymentLogged');
  if (row.status === 'paid' && !row.emails.receipt) out.push('receipt');
  if (row.status === 'cancelled_unpaid' && !row.emails.cancelled) out.push('cancelledEmail');
  if (row.status === 'cancelled_unpaid' && row.voucherCode && !row.effects.voucherRestored) out.push('voucherRestored');
  if (!row.effects.cardDeleted) out.push('cardDeleted');
  if (!row.effects.linkExpired) out.push('linkExpired');
  if (!row.effects.tasksResolved) out.push('tasksResolved');
  return out;
}

// ─── The guest's pay link ────────────────────────────────────────────────────

export type PayLinkResult =
  | { kind: 'redirect'; url: string }
  | { kind: 'page'; page: 'not_found' | 'paid' | 'paid_now' | 'cancelled' | 'busy' | 'error'; row?: WebPaymentSchedule };

export async function openPayLink(
  io: PayLaterIo,
  token: string,
  query: { sessionId?: string | null; done?: boolean },
): Promise<PayLinkResult> {
  let row = await io.repo.getByToken(token);
  if (!row) return { kind: 'page', page: 'not_found' };

  // Back from Stripe: confirm straight from Stripe, don't wait for the webhook.
  if (query.done && query.sessionId) {
    try {
      const s = await io.stripe.retrieveCheckoutSession(query.sessionId);
      if (s.metadata.schedule_id === row.id && s.status === 'complete' && s.paymentStatus === 'paid' && s.paymentIntentId) {
        const pi = await io.stripe.retrievePaymentIntent(s.paymentIntentId);
        await settleFromStripe(io, row.id, pi, 'link', 'guest');
        return { kind: 'page', page: 'paid_now', row: (await io.repo.get(row.id)) ?? row };
      }
    } catch {
      // Fall through to the normal state check.
    }
    row = (await io.repo.get(row.id)) ?? row;
  }

  if (SETTLED.includes(row.status)) return { kind: 'page', page: 'paid', row };
  if (!OPEN.includes(row.status)) return { kind: 'page', page: 'cancelled', row };
  const now = io.now();
  if (lockIsFresh(io, row)) return { kind: 'page', page: 'busy', row };

  try {
    if (row.openLinkSessionId) {
      const s = await io.stripe.retrieveCheckoutSession(row.openLinkSessionId);
      if (s.status === 'complete' && s.paymentStatus === 'paid' && s.paymentIntentId) {
        const pi = await io.stripe.retrievePaymentIntent(s.paymentIntentId);
        await settleFromStripe(io, row.id, pi, 'link', 'guest');
        return { kind: 'page', page: 'paid_now', row };
      }
      if (s.status === 'open' && s.url && s.expiresAt * 1000 - now.getTime() > 5 * 60_000) {
        return { kind: 'redirect', url: s.url };
      }
    }

    // Never let a guest pay for a booking that was just cancelled in Beds24.
    try {
      const view = bookingView(row, await io.beds24.fetchBookings(row.bookingIds));
      if (view.kind === 'cancelled') {
        await closeCancelledBooking(io, row, view.subStatus, 'guest', { lockFreeBefore: staleBefore(io) });
        return { kind: 'page', page: 'cancelled', row };
      }
    } catch {
      // Beds24 unreachable: let the guest pay; a payment for a cancelled booking is refunded by ops.
    }

    const base = payUrl(io, row);
    const session = await io.stripe.createPayLinkSession({
      customerId: row.stripeCustomerId,
      amountMinor: row.amountMinor,
      currency: row.currency,
      productName: `Baker House Apartments${row.roomLabel ? ` · ${row.roomLabel}` : ''}`,
      productDescription: `${row.reservationNumber} · ${row.arrival} → ${row.departure}`,
      paymentDescription: paymentDescription(row),
      lang: row.lang,
      successUrl: `${base}?done=1&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: base,
      expiresAt: Math.floor(now.getTime() / 1000) + 60 * 60,
      metadata: { kind: 'paylater_link', schedule_id: row.id },
      paymentMetadata: paymentMetadata(row, 'link'),
    });
    // Compare-and-set: only while nobody is charging AND the tracked page is still
    // the one we read. A parallel open (double click, mail scanner) loses here and
    // its page is closed at once, so no untracked page is ever left open.
    const stored = await io.repo.patch(
      row.id,
      { openLinkSessionId: session.id },
      { statusIn: OPEN, lockFreeBefore: staleBefore(io), openLinkSessionIdIs: row.openLinkSessionId },
    );
    if (!stored || !session.url) {
      await io.stripe.expireCheckoutSession(session.id).catch(() => {});
      const cur = await io.repo.get(row.id);
      if (cur?.openLinkSessionId) {
        const s2 = await io.stripe.retrieveCheckoutSession(cur.openLinkSessionId).catch(() => null);
        if (s2?.status === 'open' && s2.url) return { kind: 'redirect', url: s2.url };
      }
      return { kind: 'page', page: 'busy', row };
    }
    if (row.openLinkSessionId && row.openLinkSessionId !== session.id) {
      await io.stripe.expireCheckoutSession(row.openLinkSessionId).catch(() => {});
    }
    await io.repo.addEvent(row.id, 'link_opened', 'guest', { sessionId: session.id });
    return { kind: 'redirect', url: session.url };
  } catch (err) {
    await io.repo.addEvent(row.id, 'link_error', 'guest', { error: errText(err) });
    await alertOnce(io, row, `link-${pragueDateOf(now)}`, msg.technical(row, 'pay link failed to open', errText(err)));
    return { kind: 'page', page: 'error', row };
  }
}

/** checkout.session.completed for a pay-link page (Stripe webhook). */
export async function settleLinkSession(io: PayLaterIo, sessionId: string, actor: string): Promise<SettleOutcome | 'ignored'> {
  const s = await io.stripe.retrieveCheckoutSession(sessionId);
  const scheduleId = s.metadata.schedule_id;
  if (s.metadata.kind !== 'paylater_link' || !scheduleId) return 'ignored';
  if (s.paymentStatus !== 'paid' || !s.paymentIntentId) return 'ignored';
  const pi = await io.stripe.retrievePaymentIntent(s.paymentIntentId);
  return settleFromStripe(io, scheduleId, pi, 'link', actor);
}

/** charge.succeeded for one of our PaymentIntents (Stripe webhook) — a safety net. */
export async function settlePaymentIntent(io: PayLaterIo, paymentIntentId: string, actor: string): Promise<SettleOutcome | 'ignored'> {
  const pi = await io.stripe.retrievePaymentIntent(paymentIntentId);
  if (pi.metadata.kind !== 'paylater' || !pi.metadata.schedule_id) return 'ignored';
  return settleFromStripe(io, pi.metadata.schedule_id, pi, viaFromMetadata(pi), actor);
}

// ─── Admin actions ───────────────────────────────────────────────────────────

export type AdminResult = { ok: true; detail?: unknown } | { ok: false; status: number; error: string };

export async function applyAdminAction(
  io: PayLaterIo,
  scheduleId: string,
  action: WebPaymentAction,
  adminEmail: string,
): Promise<AdminResult> {
  const row = await io.repo.get(scheduleId);
  if (!row) return { ok: false, status: 404, error: 'Schedule not found' };
  const lockFree = { statusIn: OPEN, lockFreeBefore: staleBefore(io) };

  switch (action.action) {
    case 'charge_now': {
      const r = await chargeSchedule(io, scheduleId, 'manual', adminEmail);
      return { ok: true, detail: r };
    }
    case 'send_link': {
      if (!OPEN.includes(row.status)) return { ok: false, status: 409, error: `The booking is ${row.status}` };
      const sent = await sendGuestMail(io, row, 'link', adminEmail);
      return sent ? { ok: true } : { ok: false, status: 502, error: 'The email could not be sent' };
    }
    case 'set_amount': {
      const amountMinor = Math.round(Number(action.amountCzk) * 100);
      const reason = String(action.reason ?? '').trim();
      if (!Number.isFinite(amountMinor) || amountMinor < 100) return { ok: false, status: 400, error: 'Amount must be at least 1 Kč' };
      if (!reason) return { ok: false, status: 400, error: 'A reason is required' };
      const mismatchStillOn =
        row.attention === 'amount_mismatch' && row.beds24 && !sameAmount(row.beds24.priceCzk, amountMinor / 100);
      const updated = await io.repo.patch(
        scheduleId,
        {
          amountMinor,
          ...(row.attention === 'amount_mismatch' && !mismatchStillOn ? { attention: null, attentionDetail: null } : {}),
        },
        lockFree,
      );
      if (!updated) return { ok: false, status: 409, error: 'The schedule is being charged or is closed — try again' };
      await io.repo.addEvent(scheduleId, 'amount_changed', adminEmail, { from: row.amountMinor, to: amountMinor, reason });
      // Any page opened for the old amount is closed (a payment that slipped through is flagged by settle).
      const pages = await closeOpenLinkPages(io, updated, adminEmail);
      if (pages === 'paid') return { ok: true, detail: 'The guest had just paid on an open pay-link page — see the drawer.' };
      if (typeof pages === 'object') return { ok: true, detail: `Amount changed, but an open pay-link page could not be closed: ${pages.error}` };
      return { ok: true };
    }
    case 'set_no_auto_cancel': {
      const updated = await io.repo.patch(scheduleId, { noAutoCancel: !!action.value }, { statusIn: OPEN });
      if (!updated) return { ok: false, status: 409, error: `The booking is ${row.status}` };
      await io.repo.addEvent(scheduleId, 'no_auto_cancel', adminEmail, { value: !!action.value });
      return { ok: true };
    }
    case 'mark_paid_other': {
      const note = String(action.note ?? '').trim();
      if (!note) return { ok: false, status: 400, error: 'Say how it was paid' };
      const updated = await io.repo.patch(
        scheduleId,
        { status: 'paid_other', paidAt: io.now().toISOString(), paidVia: 'other', paidAmountMinor: row.amountMinor, attention: null, attentionDetail: null, retryNotBefore: null },
        lockFree,
      );
      if (!updated) return { ok: false, status: 409, error: 'The schedule is being charged or is closed — try again' };
      await io.repo.addEvent(scheduleId, 'paid_other', adminEmail, { note });
      await completeEffects(io, updated, adminEmail);
      return { ok: true };
    }
    case 'cancel_now': {
      const r = await cancelForNonPayment(io, scheduleId, adminEmail);
      if (r.outcome === 'cancelled') return { ok: true, detail: r };
      const why =
        r.outcome === 'blocked' ? r.reason
          : r.outcome === 'error' ? r.message
            : r.outcome === 'paid_instead' ? 'The guest has paid — nothing was cancelled'
              : r.outcome === 'busy' ? 'A charge is running right now — try again in a minute'
                : `Not cancelled (${r.outcome})`;
      return { ok: false, status: 409, error: why };
    }
    case 'close': {
      const reason = String(action.reason ?? '').trim();
      if (!reason) return { ok: false, status: 400, error: 'A reason is required' };
      const updated = await io.repo.patch(scheduleId, { status: 'closed', cancelledAt: io.now().toISOString(), attention: null, attentionDetail: null, retryNotBefore: null }, lockFree);
      if (!updated) return { ok: false, status: 409, error: 'The schedule is being charged or is closed — try again' };
      await io.repo.addEvent(scheduleId, 'closed', adminEmail, { reason });
      await completeEffects(io, updated, adminEmail);
      return { ok: true };
    }
  }
}

// ─── The job ─────────────────────────────────────────────────────────────────

export interface JobSummary {
  mode: WebPaymentMode;
  open: number;
  beds24Checked: boolean;
  reminders: number;
  charged: number;
  declined: number;
  cancelled: number;
  waitingForAdmin: number;
  technical: number;
  effectsCompleted: number;
  recovered: number;
  unregistered: number;
  reconciled: number;
}

/** How far back recovery and the Stripe-vs-table check look. */
const RECOVERY_LOOKBACK_MS = 72 * 3600_000;
const RECOVERY_MIN_AGE_MS = 15 * 60_000;

/** One booking's failure never stops the others: log, alert once a day, carry on. */
async function isolated(io: PayLaterIo, s: WebPaymentSchedule | null, what: string, summary: JobSummary, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    summary.technical++;
    console.error(`[web-payments] ${what} failed${s ? ` for ${s.reservationNumber}` : ''}:`, err);
    if (s) await alertOnce(io, s, `crash-${what}-${pragueDateOf(io.now())}`, msg.technical(s, `${what} crashed`, errText(err)));
    else await io.techAlert(msg.jobCrashed(`${what}: ${errText(err)}`));
  }
}

export async function runWebPaymentsJob(
  io: PayLaterIo,
  opts: { recoveryDue: boolean; actor?: string },
): Promise<JobSummary> {
  const actor = opts.actor ?? 'job';
  const mode = await io.mode();
  const summary: JobSummary = {
    mode,
    open: 0,
    beds24Checked: false,
    reminders: 0,
    charged: 0,
    declined: 0,
    cancelled: 0,
    waitingForAdmin: 0,
    technical: 0,
    effectsCompleted: 0,
    recovered: 0,
    unregistered: 0,
    reconciled: 0,
  };
  const today = pragueDateOf(io.now());

  // 1. One batched Beds24 read: every open schedule, plus closed ones whose stay
  //    is still ahead (paid-then-cancelled, cancelled-then-reinstated).
  const open = await io.repo.listByStatus(OPEN);
  const watched = (await io.repo.listByStatus(CLOSED_WATCHED)).filter((s) => s.departure >= today);
  summary.open = open.length;
  let beds24: Map<number, Beds24Row> | null = null;
  const ids = [...new Set([...open, ...watched].flatMap((s) => s.bookingIds))];
  if (ids.length > 0) {
    try {
      beds24 = await io.beds24.fetchBookings(ids);
      summary.beds24Checked = true;
    } catch (err) {
      summary.technical++;
      // Without a fresh Beds24 view nothing guest-facing happens this run.
      if (open[0]) await alertOnce(io, open[0], `beds24-read-${today}`, msg.technical(open[0], 'Beds24 could not be read — nothing charged this run', errText(err)));
    }
  }
  let elsewhere = new Map<string, string>();
  let elsewhereOk = true;
  if (open.length > 0) {
    try {
      elsewhere = await io.paidElsewhere(open.map((s) => s.reservationNumber));
    } catch (err) {
      elsewhereOk = false;
      summary.technical++;
      console.error('[web-payments] paid-elsewhere check failed:', err);
    }
  }

  // Only schedules seen ACTIVE in this run's Beds24 read get guest-facing steps.
  const seen = new Set<string>();
  if (beds24) {
    for (const s of open) {
      await isolated(io, s, 'beds24-check', summary, async () => {
        if ((await checkAgainstBeds24(io, s, beds24!, elsewhere, actor)) === 'ok') seen.add(s.id);
      });
    }
    for (const s of watched) {
      await isolated(io, s, 'closed-check', summary, () => checkClosedAgainstBeds24(io, s, beds24!));
    }
  }

  // 2. Bookings the website never registered (contract §6), and Stripe vs our table.
  if (opts.recoveryDue) {
    await isolated(io, null, 'recovery', summary, async () => {
      const r = await recoverUnregistered(io, actor);
      summary.recovered += r.recovered;
      summary.unregistered += r.unregistered;
    });
    await isolated(io, null, 'stripe-reconcile', summary, async () => {
      summary.reconciled += await reconcileWithStripe(io);
    });
  }

  // 3. Guest-facing steps.
  const current = await io.repo.listByStatus(OPEN);
  if (mode === 'off') {
    const due = current.filter((s) => {
      const step = dueStep(s, io.now(), mode);
      return step !== null && step !== 'reminder';
    });
    if (due.length > 0) {
      await alertOnce(io, due[0], `mode-off-${today}`, msg.modeOff(due.length, due.map((s) => s.reservationNumber).join(', ')));
    }
  } else if (elsewhereOk) {
    for (const s of current) {
      if (!seen.has(s.id)) continue;
      await isolated(io, s, 'due-step', summary, async () => {
        // A "payment scheduled" email that failed at registration.
        if (!s.emails.scheduled && s.status === 'scheduled') {
          await sendGuestMail(io, s, 'scheduled', actor, { reminderPlanned: !!s.reminderAt });
        }
        await runDueStep(io, s, mode, summary, actor);
      });
    }
  }

  // 4. The outbox: finish side effects of anything closed in the last 60 days.
  const recent = await io.repo.listUpdatedSince(new Date(io.now().getTime() - 60 * 86_400_000));
  for (const s of recent) {
    if (missingEffects(s).length === 0) continue;
    await isolated(io, s, 'outbox', summary, async () => {
      await completeEffects(io, s, actor);
      summary.effectsCompleted++;
    });
  }

  return summary;
}

async function runDueStep(io: PayLaterIo, s: WebPaymentSchedule, mode: WebPaymentMode, summary: JobSummary, actor: string) {
  const step = dueStep(s, io.now(), mode);
  if (!step) return;

  if (step === 'reminder') {
    if (await sendGuestMail(io, s, 'reminder', actor)) summary.reminders++;
    return;
  }

  if (step === 'failed_email') {
    await sendFailedEmail(io, s, actor);
    return;
  }

  if (step === 'attempt1' || step === 'attempt2') {
    if (mode === 'manual') {
      summary.waitingForAdmin++;
      await alertOnce(io, s, `due-${step}`, msg.dueManual(s, step));
      const tk = task.dueManual(step);
      await io.addTask(s.reservationNumber, tk.id, tk.text);
      return;
    }
    const r = await chargeSchedule(io, s.id, step === 'attempt1' ? 'auto1' : 'auto2', actor);
    if (r.outcome === 'paid' || r.outcome === 'already_paid') summary.charged++;
    else if (r.outcome === 'declined') summary.declined++;
    else if (r.outcome === 'retry' || r.outcome === 'needs_admin' || r.outcome === 'unknown' || r.outcome === 'blocked') summary.technical++;
    if (r.outcome !== 'declined' || step !== 'attempt2') return;
    // Second decline: straight on to the cancellation (or the admin's decision).
    const fresh = await io.repo.get(s.id);
    if (fresh) await runDueStep(io, fresh, mode, summary, actor);
    return;
  }

  if (step === 'cancel') {
    const r = await cancelForNonPayment(io, s.id, actor);
    if (r.outcome === 'cancelled') summary.cancelled++;
    else if (r.outcome === 'paid_instead') summary.charged++;
    else summary.technical++;
    return;
  }

  // 'decide': two declines (or no failure email by the deadline) but no automatic cancellation.
  summary.waitingForAdmin++;
  const why = !s.emails.failed
    ? 'the "payment failed" email never went out before the deadline'
    : mode !== 'auto'
      ? 'manual mode'
      : s.noAutoCancel
        ? '"don\'t auto-cancel" is on'
        : !withinFreeCancellation(s.deadlineDate, io.now())
          ? 'free cancellation is over'
          : 'not allowed';
  await alertOnce(io, s, 'decide', msg.decide(s, why));
  const tk = task.decide(why);
  await io.addTask(s.reservationNumber, tk.id, tk.text);
}

/** 'ok' = seen active (guest-facing steps may run); otherwise skip this booking this run. */
async function checkAgainstBeds24(
  io: PayLaterIo,
  s: WebPaymentSchedule,
  rowsById: Map<number, Beds24Row>,
  elsewhere: Map<string, string>,
  actor: string,
): Promise<'ok' | 'closed' | 'unseen' | 'skip'> {
  const view = bookingView(s, rowsById);
  if (view.kind === 'missing') {
    await noteTechnical(io, s, 'booking not found in Beds24', `ids ${view.missing.join(', ')} — nothing charged until Beds24 returns them`);
    return 'unseen';
  }
  if (view.kind === 'cancelled') {
    if (lockIsFresh(io, s)) return 'skip'; // a charge or our own cancellation is mid-flight
    await closeCancelledBooking(io, s, view.subStatus, actor, { lockFreeBefore: staleBefore(io) });
    return 'closed';
  }

  const nowIso = io.now().toISOString();
  const { master, priceCzk, depositCzk } = view;
  const snapshot = { at: nowIso, status: master.status, arrival: master.arrival, departure: master.departure, priceCzk, depositCzk, subStatus: master.subStatus ?? undefined };

  // Dates moved by ops: new charge dates, same agreed amount.
  let patch: Parameters<typeof io.repo.patch>[1] = { beds24: snapshot };
  if (master.arrival !== s.arrival || master.departure !== s.departure) {
    const tl = payLaterSchedule(master.arrival, master.departure, io.now());
    if (tl) {
      patch = {
        ...patch,
        arrival: master.arrival,
        departure: master.departure,
        deadlineDate: tl.deadlineDate,
        attempt1At: tl.attempt1At.toISOString(),
        attempt2At: tl.attempt2At.toISOString(),
        reminderAt: s.emails.reminder ? s.reminderAt : (tl.reminderAt?.toISOString() ?? null),
        // After a decline, a later free-cancellation deadline must not suddenly
        // allow a cancellation the guest wasn't warned about: an admin decides.
        ...(s.autoDeclines > 0 ? { noAutoCancel: true } : {}),
      };
      await io.repo.addEvent(s.id, 'dates_changed', actor, { from: [s.arrival, s.departure], to: [master.arrival, master.departure], autoCancelOff: s.autoDeclines > 0 });
      await alertOnce(io, s, `dates-${master.arrival}-${master.departure}`,
        msg.datesChanged({ ...s, arrival: master.arrival, departure: master.departure }, tl.attempt1At) +
          (s.autoDeclines > 0 ? '\nThe card was already declined, so auto-cancel is now OFF for this booking — decide in the drawer.' : ''));
    }
  }

  // What ops should look at — the most pressing problem wins.
  const reason = elsewhere.get(s.reservationNumber);
  const mismatch = !sameAmount(priceCzk, s.amountMinor / 100);
  if (paidInBeds24(view)) {
    patch = { ...patch, attention: 'beds24_shows_paid', attentionDetail: `Beds24 deposit ${depositCzk} Kč of ${priceCzk} Kč` };
    await alertOnce(io, s, 'beds24-paid', msg.beds24ShowsPaid(s));
    const tk = task.beds24Paid();
    await io.addTask(s.reservationNumber, tk.id, tk.text);
  } else if (reason) {
    patch = { ...patch, attention: 'paid_elsewhere', attentionDetail: reason };
    await alertOnce(io, s, 'paid-elsewhere', msg.technical(s, 'already paid another way', `${reason}. Nothing is charged or cancelled until you check it.`));
    await io.addTask(s.reservationNumber, 'paylater-paid-elsewhere', `Pay later: ${reason}. If the guest has paid, use "Paid another way" in the drawer; otherwise reset the payment status.`);
  } else if (mismatch) {
    patch = { ...patch, attention: 'amount_mismatch', attentionDetail: `Beds24 ${priceCzk} Kč, agreed ${formatCzk(s.amountMinor)}` };
    await alertOnce(io, s, `mismatch-${priceCzk}`, msg.amountMismatch(s, priceCzk));
    const tk = task.mismatch(priceCzk, formatCzk(s.amountMinor));
    await io.addTask(s.reservationNumber, tk.id, tk.text);
  } else if (s.attention === 'amount_mismatch' || s.attention === 'beds24_shows_paid' || s.attention === 'paid_elsewhere') {
    patch = { ...patch, attention: null, attentionDetail: null };
  }
  await io.repo.patch(s.id, patch, { statusIn: OPEN });
  return 'ok';
}

/** A closed schedule whose stay is still ahead: paid-then-cancelled, or cancelled-then-reinstated. */
async function checkClosedAgainstBeds24(io: PayLaterIo, s: WebPaymentSchedule, rowsById: Map<number, Beds24Row>) {
  const view = bookingView(s, rowsById);
  if (SETTLED.includes(s.status) && view.kind === 'cancelled' && s.attention !== 'paid_booking_cancelled') {
    await io.repo.patch(s.id, { attention: 'paid_booking_cancelled', attentionDetail: 'Paid, but the booking is cancelled in Beds24' });
    await alertOnce(io, s, 'paid-cancelled', msg.technical(s, 'paid booking is cancelled in Beds24', 'Refund the guest (drawer → Refund via Stripe) if the cancellation stands.'));
    await io.addTask(s.reservationNumber, 'paylater-refund', 'Pay later: this booking was paid but is cancelled in Beds24. Refund the guest if the cancellation stands.');
  }
  if ((s.status === 'cancelled' || s.status === 'cancelled_unpaid') && view.kind === 'active' && !paidInBeds24(view) && s.attention !== 'reinstated_unpaid') {
    await io.repo.patch(s.id, { attention: 'reinstated_unpaid', attentionDetail: 'Active again in Beds24, unpaid — the saved card was removed' });
    await alertOnce(io, s, 'reinstated', msg.technical(s, 'cancelled booking is active again in Beds24', 'It is unpaid and the saved card was removed: send a payment link (Manual Payment) or cancel it again.'));
    await io.addTask(s.reservationNumber, 'paylater-reinstated', 'Pay later: this booking was cancelled but is active again in Beds24, unpaid, and the saved card was removed. Send a payment link or cancel it.');
  }
}

/**
 * The daily Stripe-vs-table check: every succeeded pay-later payment of the
 * last 3 days must be the one our table records — anything else (a webhook
 * that never arrived, a page a double click left open) is settled or refunded.
 */
async function reconcileWithStripe(io: PayLaterIo): Promise<number> {
  const since = Math.floor((io.now().getTime() - RECOVERY_LOOKBACK_MS) / 1000);
  const pis = await io.stripe.searchPayLaterIntents(since);
  let n = 0;
  for (const pi of pis) {
    if (pi.status !== 'succeeded' || !pi.metadata.schedule_id) continue;
    const s = await io.repo.get(pi.metadata.schedule_id);
    if (!s) continue;
    if (s.status === 'paid' && s.paidPaymentIntentId === pi.id) continue;
    if (pi.amountRefunded > 0) continue; // already handled by a person or the duplicate refund
    const out = await settleFromStripe(io, s.id, pi, viaFromMetadata(pi), 'stripe-reconcile');
    if (out === 'paid' || out === 'duplicate_refunded') n++;
  }
  return n;
}

async function recoverUnregistered(io: PayLaterIo, actor: string): Promise<{ recovered: number; unregistered: number }> {
  const out = { recovered: 0, unregistered: 0 };
  let rows: Beds24Row[];
  try {
    rows = await io.beds24.recentPayLaterBookings(new Date(io.now().getTime() - RECOVERY_LOOKBACK_MS).toISOString());
  } catch {
    return out; // retried next scan; the open-schedule check already alerts on Beds24 outages
  }
  const today = pragueDateOf(io.now());
  const candidates = rows.filter(
    (r) =>
      r.status !== 'cancelled' &&
      r.arrival >= today &&
      r.deposit < r.price &&
      (!r.bookingTime || io.now().getTime() - Date.parse(r.bookingTime) > RECOVERY_MIN_AGE_MS),
  );
  // Rows of one website order share a WEB-GROUP marker; handle the order once.
  const groups = new Map<string, Beds24Row[]>();
  for (const r of candidates) {
    const key = /WEB-GROUP-[A-Za-z0-9_-]+/.exec(r.notes ?? '')?.[0] ?? `row-${r.id}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  for (const group of groups.values()) {
    const ids = group.map((r) => r.id).sort((a, b) => a - b);
    let known = false;
    for (const id of ids) if (await io.repo.findByBookingId(id)) known = true;
    if (known) continue;

    // The website writes the customer id on the booking (PAYLATER_REF); a Stripe search is the fallback.
    let found: Awaited<ReturnType<typeof io.stripe.retrieveCustomer>> = null;
    const refId = group
      .flatMap((r) => r.infoItems)
      .filter((i) => i.code === 'PAYLATER_REF')
      .map((i) => /cus_[A-Za-z0-9]+/.exec(i.text)?.[0])
      .find((x): x is string => !!x);
    if (refId) found = await io.stripe.retrieveCustomer(refId).catch(() => null);
    for (const id of ids) {
      if (found) break;
      const hits = await io.stripe.findCustomersByReservation(`BH-${id}`).catch(() => []);
      found = hits.find((c) => c.metadata.pay_later === '1') ?? null;
    }
    const cards = found ? await io.stripe.listCustomerCards(found.id).catch(() => []) : [];
    const meta = found?.metadata ?? {};
    const bookingIds = (meta.bh_booking_ids ?? '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);
    const master = group.find((r) => r.id === bookingIds[0]) ?? group[0];
    const amountMinor = Number(meta.amount_minor);

    // Never rebuild a schedule unless Beds24 agrees with the amount the guest saw
    // (a half-created two-studio order must not be charged the full price).
    let amountProblem: string | null = null;
    if (found && cards.length > 0 && amountMinor > 0) {
      const named = bookingIds.length > 0 ? bookingIds : ids;
      const b = await io.beds24.fetchBookings(named).catch(() => null);
      const live = named.map((id) => b?.get(id)).filter((r): r is Beds24Row => !!r && r.status !== 'cancelled');
      const sum = live.reduce((acc, r) => acc + r.price, 0);
      if (!b) amountProblem = 'Beds24 could not be read to check the amount.';
      else if (live.length !== named.length) amountProblem = `Only ${live.length} of ${named.length} booking rows are active in Beds24.`;
      else if (!sameAmount(sum, amountMinor / 100)) amountProblem = `Beds24 says ${sum} Kč, the guest agreed ${formatCzk(amountMinor)}.`;
    }

    if (found && cards.length > 0 && amountMinor > 0 && !amountProblem) {
      const res = await registerSchedule(
        io,
        {
          checkoutSessionId: null,
          setupIntentId: null,
          customerId: found.id,
          paymentMethodId: cards[0].id,
          livemode: io.stripe.livemode,
          bookingIds: bookingIds.length > 0 ? bookingIds : ids,
          arrival: master.arrival,
          departure: master.departure,
          amountMinor,
          currency: 'czk',
          guest: {
            name: found.name ?? `${master.firstName ?? ''} ${master.lastName ?? ''}`.trim(),
            email: found.email ?? master.email ?? '',
            phone: found.phone,
            lang: meta.lang === 'en' ? 'en' : 'cs',
          },
          roomLabel: null,
          voucherCode: meta.voucher_code || null,
          termsVersion: meta.terms_version || null,
          attempt1At: null,
          deadlineDate: null,
        },
        'recovered',
        actor,
      );
      if (res.ok && res.created) out.recovered++;
      continue;
    }

    out.unregistered++;
    const reservationNumber = `BH-${master.id}`;
    const tk = task.unregistered();
    // The task doubles as the de-duplication: alert only when it is new.
    if (await io.addTask(reservationNumber, tk.id, tk.text)) {
      const why = amountProblem
        ? `A saved card exists, but it was NOT scheduled: ${amountProblem}`
        : found
          ? 'A Stripe customer exists but has no saved card or amount.'
          : 'No Stripe customer is tagged with this booking.';
      await io.techAlert(msg.unregistered(reservationNumber, why));
    }
  }
  return out;
}

// ─── Views ───────────────────────────────────────────────────────────────────

export function toView(io: Pick<PayLaterIo, 'baseUrl' | 'now'>, row: WebPaymentSchedule): WebPaymentView {
  const { lockToken, alerts, pendingAttempt, ...rest } = row;
  void alerts;
  void pendingAttempt;
  const charging = !!lockToken && !!row.lockedAt && io.now().getTime() - Date.parse(row.lockedAt) < LOCK_STALE_MS;
  const afterDeadline = OPEN.includes(row.status) && !withinFreeCancellation(row.deadlineDate, io.now());
  return {
    ...rest,
    attention: row.attention ?? (afterDeadline ? 'after_deadline' : null),
    attempt2EffectiveAt: attempt2DueAt(row).toISOString(),
    payUrl: payUrl(io, row),
    charging,
  };
}

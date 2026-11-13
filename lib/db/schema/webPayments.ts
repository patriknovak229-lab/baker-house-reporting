import { pgTable, text, integer, boolean, date, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
// Type-only imports (erased at build) — relative so the drizzle-kit CLI
// bundler needs no tsconfig path-alias resolution.
import type {
  Beds24Snapshot,
  PendingAttempt,
  WebPaymentAttention,
  WebPaymentEffect,
  WebPaymentEmailKind,
  WebPaymentLang,
  WebPaymentPaidVia,
  WebPaymentStatus,
} from '../../../types/webPayment';

/**
 * Pay later for website bookings: one row per booking whose card was saved at
 * checkout and is charged before free cancellation ends. Engine:
 * utils/webPayments/engine.ts. New domain, Postgres-only — no STORE_* flag.
 *
 * Every write that can race goes through a single conditional UPDATE … RETURNING
 * (the Neon HTTP driver has no interactive transactions): the charge "claim"
 * (`lock_token`), and the status changes conditioned on the status they leave.
 */
export const webPaymentSchedules = pgTable(
  'web_payment_schedules',
  {
    /** `WP-<base36 ms><rand>`. */
    id: text('id').primaryKey(),
    /** Master booking, `BH-<Beds24 id>`. One schedule per booking. */
    reservationNumber: text('reservation_number').notNull(),
    /** Every Beds24 row of the booking, master first (two for two studios). */
    bookingIds: jsonb('booking_ids').$type<number[]>().notNull(),
    arrival: date('arrival', { mode: 'string' }).notNull(),
    departure: date('departure', { mode: 'string' }).notNull(),
    roomLabel: text('room_label'),
    /** The amount the guest agreed to at checkout, in haléře. What gets charged. */
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull().default('czk'),
    guestName: text('guest_name').notNull(),
    guestEmail: text('guest_email').notNull(),
    guestPhone: text('guest_phone'),
    lang: text('lang').$type<WebPaymentLang>().notNull(),
    voucherCode: text('voucher_code'),
    termsVersion: text('terms_version'),
    /** 'recovered' = rebuilt from Stripe after the website's registration never arrived. */
    source: text('source').$type<'website' | 'recovered'>().notNull(),
    livemode: boolean('livemode').notNull(),
    stripeCustomerId: text('stripe_customer_id').notNull(),
    /** null once the card has been removed from Stripe. */
    stripePaymentMethodId: text('stripe_payment_method_id'),
    stripeSetupIntentId: text('stripe_setup_intent_id'),
    /** The card-saving Checkout session; unique so a re-sent registration is a no-op. */
    stripeCheckoutSessionId: text('stripe_checkout_session_id'),
    cardBrand: text('card_brand'),
    cardLast4: text('card_last4'),
    cardExpMonth: integer('card_exp_month'),
    cardExpYear: integer('card_exp_year'),
    /** Last free-cancellation day (free until 23:59 Prague). */
    deadlineDate: date('deadline_date', { mode: 'string' }).notNull(),
    reminderAt: timestamp('reminder_at', { withTimezone: true, mode: 'date' }),
    attempt1At: timestamp('attempt1_at', { withTimezone: true, mode: 'date' }).notNull(),
    attempt2At: timestamp('attempt2_at', { withTimezone: true, mode: 'date' }).notNull(),
    status: text('status').$type<WebPaymentStatus>().notNull(),
    /** Charge attempts with a recorded outcome (automatic and manual). */
    attemptCount: integer('attempt_count').notNull().default(0),
    /** Declines of the two scheduled attempts — only these lead to a cancellation. */
    autoDeclines: integer('auto_declines').notNull().default(0),
    firstDeclineAt: timestamp('first_decline_at', { withTimezone: true, mode: 'date' }),
    lastDecline: jsonb('last_decline').$type<{ code: string; message: string; at: string }>(),
    /** Back-off after a technical failure (0024): no charge attempt before this. */
    retryNotBefore: timestamp('retry_not_before', { withTimezone: true, mode: 'date' }),
    retryCount: integer('retry_count').notNull().default(0),
    /** Set before Stripe is called, cleared once its answer is recorded — a crash replays the same key. */
    pendingAttempt: jsonb('pending_attempt').$type<PendingAttempt>(),
    /** The charge claim. Stale after LOCK_STALE_MS (engine). */
    lockToken: text('lock_token'),
    lockedAt: timestamp('locked_at', { withTimezone: true, mode: 'date' }),
    /** The pay-link Checkout page currently open, expired before any other charge. */
    openLinkSessionId: text('open_link_session_id'),
    /** Random token in the guest's pay link (/pay/<token>). */
    payToken: text('pay_token').notNull(),
    noAutoCancel: boolean('no_auto_cancel').notNull().default(false),
    /** Guest emails sent: kind → ISO time. */
    emails: jsonb('emails').$type<Partial<Record<WebPaymentEmailKind, string>>>().notNull().default({}),
    /** Side effects done after a status change: effect → ISO time (an outbox the job completes). */
    effects: jsonb('effects').$type<Partial<Record<WebPaymentEffect, string>>>().notNull().default({}),
    /** Telegram / task de-duplication: key → ISO time. */
    alerts: jsonb('alerts').$type<Record<string, string>>().notNull().default({}),
    attention: text('attention').$type<WebPaymentAttention>(),
    attentionDetail: text('attention_detail'),
    /** Last Beds24 state the job saw. */
    beds24: jsonb('beds24').$type<Beds24Snapshot>(),
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }),
    paidPaymentIntentId: text('paid_payment_intent_id'),
    paidAmountMinor: integer('paid_amount_minor'),
    paidVia: text('paid_via').$type<WebPaymentPaidVia>(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('web_payment_schedules_reservation_uq').on(t.reservationNumber),
    uniqueIndex('web_payment_schedules_setup_session_uq').on(t.stripeCheckoutSessionId),
    uniqueIndex('web_payment_schedules_pay_token_uq').on(t.payToken),
    index('web_payment_schedules_status_idx').on(t.status),
  ],
);

/** Append-only audit log: every attempt, email, alert and admin action. */
export const webPaymentEvents = pgTable(
  'web_payment_events',
  {
    /** `WE-<base36 ms><rand>`. */
    id: text('id').primaryKey(),
    scheduleId: text('schedule_id').notNull(),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    type: text('type').notNull(),
    /** 'job', 'website', 'guest', 'stripe-webhook', or the admin's email. */
    actor: text('actor').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index('web_payment_events_schedule_idx').on(t.scheduleId, t.at)],
);

export type WebPaymentScheduleRow = typeof webPaymentSchedules.$inferSelect;
export type WebPaymentScheduleInsert = typeof webPaymentSchedules.$inferInsert;
export type WebPaymentEventRow = typeof webPaymentEvents.$inferSelect;

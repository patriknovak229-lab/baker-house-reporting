/**
 * Everything the pay-later engine touches outside its own tables, as small
 * interfaces. Real wiring: ./deps.ts. Engine tests pass fakes, so every money
 * path (claims, replays, declines, duplicates, cancellations) is exercised
 * without Stripe, Beds24, SMTP or Telegram.
 */
import type { WebPaymentMode } from '@/types/webPayment';
import type { WebPaymentRepo } from './repo';

export interface PaymentIntentLite {
  id: string;
  status: string;             // succeeded | processing | requires_payment_method | requires_action | canceled | …
  amount: number;             // haléře
  amountReceived: number;     // haléře
  /** Refunded on the latest charge, haléře (0 when not expanded or none). */
  amountRefunded: number;
  currency: string;
  created: number;            // unix seconds
  metadata: Record<string, string>;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

export interface CheckoutSessionLite {
  id: string;
  status: 'open' | 'complete' | 'expired' | string;
  paymentStatus: 'paid' | 'unpaid' | 'no_payment_required' | string;
  url: string | null;
  expiresAt: number;          // unix seconds
  paymentIntentId: string | null;
  metadata: Record<string, string>;
}

export interface CardLite {
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

export interface PayLaterStripe {
  /** Whether the configured key is live (sk_live_…). */
  livemode: boolean;
  retrievePaymentMethod(id: string): Promise<{ id: string; customerId: string | null; type: string; card: CardLite | null }>;
  /** Most recent PaymentIntents of a customer (strongly consistent, unlike Search). */
  listPaymentIntents(customerId: string): Promise<PaymentIntentLite[]>;
  retrievePaymentIntent(id: string): Promise<PaymentIntentLite>;
  /** Off-session, confirmed immediately. Throws Stripe errors as-is (see declines.ts). */
  createOffSessionPayment(
    input: {
      amountMinor: number;
      currency: string;
      customerId: string;
      paymentMethodId: string;
      description: string;
      metadata: Record<string, string>;
    },
    idempotencyKey: string,
  ): Promise<PaymentIntentLite>;
  retrieveCheckoutSession(id: string): Promise<CheckoutSessionLite>;
  /** Every OPEN Checkout page of a customer — tracked or not (two clicks can open two). */
  listOpenCheckoutSessions(customerId: string): Promise<CheckoutSessionLite[]>;
  /** Succeeded pay-later PaymentIntents created since then (the daily Stripe-vs-table check). */
  searchPayLaterIntents(sinceUnix: number): Promise<PaymentIntentLite[]>;
  /** Close an open Checkout page. Throws when it can't be expired (e.g. already complete). */
  expireCheckoutSession(id: string): Promise<CheckoutSessionLite>;
  createPayLinkSession(input: {
    customerId: string;
    amountMinor: number;
    currency: string;
    productName: string;
    productDescription: string;
    paymentDescription: string;
    lang: 'cs' | 'en';
    successUrl: string;
    cancelUrl: string;
    expiresAt: number;
    metadata: Record<string, string>;
    paymentMetadata: Record<string, string>;
  }): Promise<CheckoutSessionLite>;
  detachPaymentMethod(id: string): Promise<void>;
  refundPaymentIntent(id: string, idempotencyKey: string, metadata: Record<string, string>): Promise<{ id: string; status: string }>;
  /** null when it doesn't exist or was deleted. */
  retrieveCustomer(id: string): Promise<{ id: string; name: string | null; email: string | null; phone: string | null; metadata: Record<string, string> } | null>;
  /** Customers the website tagged with this reservation (contract §3). */
  findCustomersByReservation(reservationNumber: string): Promise<
    Array<{ id: string; name: string | null; email: string | null; phone: string | null; metadata: Record<string, string> }>
  >;
  listCustomerCards(customerId: string): Promise<Array<{ id: string; card: CardLite }>>;
}

/** One Beds24 row, as much as the engine needs. */
export interface Beds24Row {
  id: number;
  masterId: number | null;
  status: string;
  subStatus: string | null;
  arrival: string;
  departure: string;
  price: number;
  deposit: number;
  referer: string | null;
  notes: string | null;
  bookingTime: string | null;
  infoCodes: string[];
  /** Beds24 info items; the website writes PAYLATER (the plan) and PAYLATER_REF ("Stripe cus_…"). */
  infoItems: Array<{ code: string; text: string }>;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}

export interface PayLaterBeds24 {
  /** Rows by id, including cancelled ones. Throws when Beds24 can't be read. */
  fetchBookings(ids: number[]): Promise<Map<number, Beds24Row>>;
  /** deposit = price on each row → "Paid" everywhere. Throws unless Beds24 accepted every row. */
  markPaid(rows: Array<{ id: number; deposit: number }>, note: string): Promise<void>;
  /** status cancelled + sub-status nonPayment + auto actions off + info code. Throws unless every row is cancelled. */
  cancelNonPayment(ids: number[], note: string): Promise<void>;
  /** Website pay-later bookings (info code PAYLATER) changed since `sinceIso`. */
  recentPayLaterBookings(sinceIso: string): Promise<Beds24Row[]>;
}

export interface PayLaterIo {
  repo: WebPaymentRepo;
  stripe: PayLaterStripe;
  beds24: PayLaterBeds24;
  sendEmail(to: string, subject: string, html: string): Promise<void>;
  /** The technical Telegram chat (sendTechnicalAlert). Never throws. */
  techAlert(html: string): Promise<void>;
  /** Pending task on the reservation (overrides.issues), idempotent by id. True when newly added. */
  addTask(reservationNumber: string, id: string, text: string): Promise<boolean>;
  /** Resolve every open task on the reservation whose id starts with the prefix. */
  resolveTasks(reservationNumber: string, idPrefix: string): Promise<void>;
  /** Put a used voucher back to "issued". */
  restoreVoucher(code: string, reservationNumber: string): Promise<'restored' | 'not_found' | 'not_used_here'>;
  /** Add the payment to the Stripe payment log VAT reads, unless it's there. */
  logPayment(record: {
    sessionId: string;
    description: string;
    amountCzk: number;
    guestEmail: string;
    guestPhone: string;
    guestName?: string;
    paidAt: string;
  }): Promise<void>;
  /**
   * Bookings the app already counts as paid another way: the drawer's own
   * payment-status override (Paid / Partially Paid) or a paid payment link.
   * reservationNumber → reason. Missing = not paid elsewhere.
   */
  paidElsewhere(reservationNumbers: string[]): Promise<Map<string, string>>;
  mode(): Promise<WebPaymentMode>;
  now(): Date;
  newId(prefix: string): string;
  newToken(): string;
  /** Public origin for guest links, e.g. https://reporting.bakerhouseapartments.cz */
  baseUrl(): string;
}

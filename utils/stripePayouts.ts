/**
 * Stripe I/O for Stripe-payout settlements (pure logic in utils/stripeSettlement):
 * find the payout behind a bank credit, list what it contains, and resolve every
 * charge / refund to its checkout session (metadata = reservation or stay dates).
 * Server-only — needs the live STRIPE_SECRET_KEY (set on Vercel).
 */
import Stripe from 'stripe';
import type { BankTransaction } from '@/types/bankTransaction';
import type { RevenueInvoice } from '@/types/revenueInvoice';
import {
  planStripeSettlement,
  type PayoutLine, type StripePayoutContents, type StripeSettlementPlan, type WebBookingRef,
} from './stripeSettlement';

const czk = (minor: number) => Math.round(minor) / 100;
const ymd = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
const DAY = 86_400;

export function stripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  return key ? new Stripe(key) : null;
}

/** The paid CZK payout equal to the bank credit, arriving up to a week before it. */
export async function findPayoutForCredit(stripe: Stripe, tx: BankTransaction): Promise<Stripe.Payout> {
  const bankDay = Math.floor(Date.parse(`${tx.date}T00:00:00Z`) / 1000);
  const list = await stripe.payouts.list({ arrival_date: { gte: bankDay - 8 * DAY, lte: bankDay + 3 * DAY }, limit: 100 });
  const hits = list.data.filter((p) => p.currency === 'czk' && p.status === 'paid' && p.amount === Math.round(tx.amount * 100));
  if (hits.length === 0) throw new Error(`No Stripe payout of ${tx.amount.toLocaleString('cs-CZ')} Kč arriving around ${tx.date}`);
  if (hits.length > 1) throw new Error(`${hits.length} Stripe payouts of ${tx.amount.toLocaleString('cs-CZ')} Kč around ${tx.date} — ambiguous`);
  return hits[0];
}

async function sessionForPaymentIntent(stripe: Stripe, paymentIntentId: string | null | undefined) {
  if (!paymentIntentId) return undefined;
  const res = await stripe.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 1 });
  return res.data[0];
}

function idOf(x: string | { id: string } | null | undefined): string | undefined {
  return typeof x === 'string' ? x : x?.id;
}

/** Everything a payout contains, resolved to checkout sessions. */
export async function loadPayoutContents(stripe: Stripe, payout: Stripe.Payout): Promise<StripePayoutContents> {
  const bts = await stripe.balanceTransactions
    .list({ payout: payout.id, limit: 100, expand: ['data.source'] })
    .autoPagingToArray({ limit: 2000 });

  const lines: PayoutLine[] = [];
  for (const bt of bts) {
    if (bt.type === 'payout') continue; // the payout itself
    const base = { id: bt.id, date: ymd(bt.created), amount: czk(bt.amount), fee: czk(bt.fee), net: czk(bt.net), description: bt.description ?? undefined };

    if (bt.type === 'charge' || bt.type === 'payment') {
      const charge = typeof bt.source === 'object' && bt.source && 'object' in bt.source && bt.source.object === 'charge'
        ? (bt.source as Stripe.Charge)
        : await stripe.charges.retrieve(idOf(bt.source as string)!);
      const session = await sessionForPaymentIntent(stripe, idOf(charge.payment_intent));
      lines.push({
        ...base, kind: 'charge',
        sessionId: session?.id,
        metadata: { ...(charge.metadata ?? {}), ...(session?.metadata ?? {}) },
        customerName: session?.customer_details?.name ?? charge.billing_details?.name ?? undefined,
        description: base.description ?? charge.description ?? undefined,
      });
    } else if (bt.type === 'refund' || bt.type === 'payment_refund') {
      const refund = typeof bt.source === 'object' && bt.source ? (bt.source as Stripe.Refund) : undefined;
      const chargeId = idOf(refund?.charge ?? undefined);
      const charge = chargeId ? await stripe.charges.retrieve(chargeId) : undefined;
      const session = await sessionForPaymentIntent(stripe, idOf(charge?.payment_intent));
      lines.push({
        ...base, kind: 'refund',
        sessionId: session?.id,
        metadata: { ...(charge?.metadata ?? {}), ...(session?.metadata ?? {}) },
        customerName: session?.customer_details?.name ?? undefined,
      });
    } else if (bt.type.startsWith('stripe_fee') || bt.type === 'stripe_fx_fee' || bt.type === 'tax_fee') {
      lines.push({ ...base, kind: 'fee' });
    } else {
      lines.push({ ...base, kind: 'other' });
    }
  }
  return { payoutId: payout.id, amount: czk(payout.amount), arrivalDate: ymd(payout.arrival_date), lines };
}

/** Direct-Web bookings from the Postgres bookings mirror, in the shape the planner matches on */
export async function loadWebBookings(): Promise<WebBookingRef[]> {
  const { listBookingsMirrorPg } = await import('@/data-access/bookingsMirror');
  return (await listBookingsMirrorPg())
    .filter((b) => b.channel === 'Direct-Web')
    .map((b) => ({
      reservationNumber: b.reservationNumber,
      channel: b.channel,
      checkInDate: b.checkInDate,
      checkOutDate: b.checkOutDate,
      price: Number(b.price),
      isCancelled: b.isCancelled,
      guestName: `${b.firstName} ${b.lastName}`.trim(),
    }));
}

/** Fetch a credit's payout from Stripe and plan its settlement. */
export async function planStripeCredit(
  stripe: Stripe,
  tx: BankTransaction,
  revenueInvoices: RevenueInvoice[],
  bookings: WebBookingRef[],
): Promise<StripeSettlementPlan> {
  const payout = await findPayoutForCredit(stripe, tx);
  const contents = await loadPayoutContents(stripe, payout);
  return planStripeSettlement({ tx, payout: contents, revenueInvoices, bookings });
}

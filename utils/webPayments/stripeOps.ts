/**
 * The real Stripe behind the pay-later engine (io.ts → PayLaterStripe).
 * Server-only. Errors are rethrown untouched so declines.ts can classify them.
 */
import Stripe from 'stripe';
import type { CardLite, CheckoutSessionLite, PayLaterStripe, PaymentIntentLite } from './io';

function client(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
  return new Stripe(key);
}

const idOf = (x: string | { id: string } | null | undefined) => (typeof x === 'string' ? x : (x?.id ?? null));

function pi(p: Stripe.PaymentIntent): PaymentIntentLite {
  const charge = p.latest_charge && typeof p.latest_charge !== 'string' ? p.latest_charge : null;
  return {
    id: p.id,
    status: p.status,
    amount: p.amount,
    amountReceived: p.amount_received ?? 0,
    amountRefunded: charge?.amount_refunded ?? 0,
    currency: p.currency,
    created: p.created,
    metadata: (p.metadata ?? {}) as Record<string, string>,
    lastErrorCode: p.last_payment_error?.decline_code ?? p.last_payment_error?.code ?? null,
    lastErrorMessage: p.last_payment_error?.message ?? null,
  };
}

function session(s: Stripe.Checkout.Session): CheckoutSessionLite {
  return {
    id: s.id,
    status: s.status ?? 'open',
    paymentStatus: s.payment_status,
    url: s.url ?? null,
    expiresAt: s.expires_at,
    paymentIntentId: idOf(s.payment_intent as string | Stripe.PaymentIntent | null),
    metadata: (s.metadata ?? {}) as Record<string, string>,
  };
}

function card(c: Stripe.PaymentMethod.Card | null | undefined): CardLite | null {
  if (!c) return null;
  return { brand: c.brand ?? null, last4: c.last4 ?? null, expMonth: c.exp_month ?? null, expYear: c.exp_year ?? null };
}

/** Only BH-<digits> may reach a Stripe Search query. */
function safeReservation(res: string): string {
  if (!/^BH-\d{5,12}$/.test(res)) throw new Error(`Bad reservation number ${res}`);
  return res;
}

export function realStripe(): PayLaterStripe {
  const stripe = client();
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  return {
    livemode: /^(sk|rk)_live_/.test(key),

    async retrievePaymentMethod(id) {
      const pm = await stripe.paymentMethods.retrieve(id);
      return { id: pm.id, customerId: idOf(pm.customer as string | Stripe.Customer | null), type: pm.type, card: card(pm.card) };
    },

    async listPaymentIntents(customerId) {
      const list = await stripe.paymentIntents.list({ customer: customerId, limit: 100, expand: ['data.latest_charge'] });
      return list.data.map(pi);
    },

    async retrievePaymentIntent(id) {
      return pi(await stripe.paymentIntents.retrieve(id, { expand: ['latest_charge'] }));
    },

    async searchPayLaterIntents(sinceUnix) {
      const out: PaymentIntentLite[] = [];
      let page: string | undefined;
      for (let i = 0; i < 5; i++) {
        const res = await stripe.paymentIntents.search({
          query: `metadata['kind']:'paylater' AND status:'succeeded' AND created>${Math.floor(sinceUnix)}`,
          limit: 100,
          expand: ['data.latest_charge'],
          ...(page ? { page } : {}),
        });
        out.push(...res.data.map(pi));
        if (!res.has_more || !res.next_page) break;
        page = res.next_page;
      }
      return out;
    },

    async createOffSessionPayment(input, idempotencyKey) {
      const p = await stripe.paymentIntents.create(
        {
          amount: input.amountMinor,
          currency: input.currency,
          customer: input.customerId,
          payment_method: input.paymentMethodId,
          payment_method_types: ['card'],
          off_session: true,
          confirm: true,
          description: input.description,
          metadata: input.metadata,
        },
        { idempotencyKey },
      );
      return pi(p);
    },

    async retrieveCheckoutSession(id) {
      return session(await stripe.checkout.sessions.retrieve(id));
    },

    async expireCheckoutSession(id) {
      return session(await stripe.checkout.sessions.expire(id));
    },

    async listOpenCheckoutSessions(customerId) {
      const list = await stripe.checkout.sessions.list({ customer: customerId, status: 'open', limit: 100 });
      return list.data.map(session);
    },

    async createPayLinkSession(input) {
      const s = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer: input.customerId,
        payment_method_types: ['card'],
        locale: input.lang,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: input.currency,
              unit_amount: input.amountMinor,
              product_data: { name: input.productName, description: input.productDescription },
            },
          },
        ],
        payment_intent_data: { description: input.paymentDescription, metadata: input.paymentMetadata },
        metadata: input.metadata,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        expires_at: input.expiresAt,
      });
      return session(s);
    },

    async detachPaymentMethod(id) {
      await stripe.paymentMethods.detach(id);
    },

    async refundPaymentIntent(id, idempotencyKey, metadata) {
      const r = await stripe.refunds.create({ payment_intent: id, reason: 'duplicate', metadata }, { idempotencyKey });
      return { id: r.id, status: r.status ?? 'pending' };
    },

    async retrieveCustomer(id) {
      if (!/^cus_[A-Za-z0-9]+$/.test(id)) return null;
      const c = await stripe.customers.retrieve(id).catch(() => null);
      if (!c || ('deleted' in c && c.deleted)) return null;
      const cust = c as Stripe.Customer;
      return { id: cust.id, name: cust.name ?? null, email: cust.email ?? null, phone: cust.phone ?? null, metadata: (cust.metadata ?? {}) as Record<string, string> };
    },

    async findCustomersByReservation(reservationNumber) {
      const res = await stripe.customers.search({ query: `metadata['bh_reservation']:'${safeReservation(reservationNumber)}'`, limit: 10 });
      return res.data.map((c) => ({
        id: c.id,
        name: c.name ?? null,
        email: c.email ?? null,
        phone: c.phone ?? null,
        metadata: (c.metadata ?? {}) as Record<string, string>,
      }));
    },

    async listCustomerCards(customerId) {
      const res = await stripe.customers.listPaymentMethods(customerId, { type: 'card', limit: 10 });
      return res.data.map((pm) => ({ id: pm.id, card: card(pm.card) ?? { brand: null, last4: null, expMonth: null, expYear: null } }));
    },
  };
}

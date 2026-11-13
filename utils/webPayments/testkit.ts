/**
 * Fakes for engine tests — deliberately as strict as the real systems, so a
 * test can't pass on behaviour production wouldn't have:
 *   - Stripe stores the FIRST answer per idempotency key, 500s included, and
 *     refuses a reused key with different parameters (StripeIdempotencyError);
 *   - Checkout pages can be listed per customer, expired, or completed;
 *   - Beds24 can return partial answers, and throws on an empty one;
 *   - any one email kind can be made to fail.
 * Test-only.
 */
import type { WebPaymentMode } from '@/types/webPayment';
import type { Beds24Row, CheckoutSessionLite, PayLaterIo, PaymentIntentLite } from './io';
import { memoryRepo, type MemoryRepo } from './memoryRepo';

export type ChargeScript =
  | 'succeed'
  | { decline: string }
  | { error: string; code?: string }
  /** Stripe charges, but the answer never reaches us (timeout). */
  | 'succeed_but_lose_answer'
  /** Stripe never received it (timeout before sending). */
  | 'lost_before_stripe';

class FakeStripeError extends Error {
  constructor(public type: string, public code?: string, public decline_code?: string) {
    super(`${type}${code ? `: ${code}` : ''}${decline_code ? ` (${decline_code})` : ''}`);
  }
}

type Session = CheckoutSessionLite & { customer: string; amountMinor: number; paymentMetadata: Record<string, string> };

export function fakeStripe(clock: () => Date) {
  const intents = new Map<string, PaymentIntentLite & { customer: string }>();
  const byKey = new Map<string, { params: string; pi?: PaymentIntentLite; err?: Error }>();
  const sessions = new Map<string, Session>();
  const refunds: Array<{ paymentIntentId: string; key: string }> = [];
  const detached: string[] = [];
  const script: ChargeScript[] = [];
  const customers: Array<{ id: string; name: string; email: string; phone: string | null; metadata: Record<string, string> }> = [];
  const cards = new Map<string, Array<{ id: string; card: { brand: string; last4: string; expMonth: number; expYear: number } }>>();
  let seq = 0;
  const createCalls: string[] = [];
  const expireCalls: string[] = [];

  const newPi = (customer: string, amount: number, status: string, metadata: Record<string, string>, err?: { code: string; message: string }) => {
    const pi = {
      id: `pi_${++seq}`,
      customer,
      status,
      amount,
      amountReceived: status === 'succeeded' ? amount : 0,
      amountRefunded: 0,
      currency: 'czk',
      created: Math.floor(clock().getTime() / 1000),
      metadata,
      lastErrorCode: err?.code ?? null,
      lastErrorMessage: err?.message ?? null,
    };
    intents.set(pi.id, pi);
    return pi;
  };

  const newSession = (customer: string, amountMinor: number, metadata: Record<string, string>, paymentMetadata: Record<string, string>, expiresAt: number): Session => {
    const s: Session = {
      id: `cs_live_${++seq}`,
      status: 'open',
      paymentStatus: 'unpaid',
      url: `https://checkout.stripe.test/${seq}`,
      expiresAt,
      paymentIntentId: null,
      metadata,
      customer,
      amountMinor,
      paymentMetadata,
    };
    sessions.set(s.id, s);
    return s;
  };

  const api = {
    livemode: true,
    async retrievePaymentMethod(id: string) {
      for (const [customerId, list] of cards) {
        const c = list.find((x) => x.id === id);
        if (c) return { id, customerId, type: 'card', card: c.card };
      }
      throw new FakeStripeError('StripeInvalidRequestError', 'resource_missing');
    },
    async listPaymentIntents(customerId: string) {
      return [...intents.values()].filter((p) => p.customer === customerId).map((p) => ({ ...p }));
    },
    async retrievePaymentIntent(id: string) {
      const p = intents.get(id);
      if (!p) throw new FakeStripeError('StripeInvalidRequestError', 'resource_missing');
      return { ...p };
    },
    async searchPayLaterIntents(sinceUnix: number) {
      return [...intents.values()]
        .filter((p) => p.metadata.kind === 'paylater' && p.status === 'succeeded' && p.created > sinceUnix)
        .map((p) => ({ ...p }));
    },
    async createOffSessionPayment(
      input: { amountMinor: number; currency: string; customerId: string; paymentMethodId: string; description: string; metadata: Record<string, string> },
      key: string,
    ) {
      createCalls.push(key);
      const params = JSON.stringify([input.amountMinor, input.customerId, input.paymentMethodId, input.description, input.metadata]);
      const replay = byKey.get(key);
      if (replay) {
        // Real Stripe: same key + different parameters is an error, never a new charge.
        if (replay.params !== params) throw new FakeStripeError('StripeIdempotencyError', 'idempotency_error');
        if (replay.err) throw replay.err;
        return { ...replay.pi! };
      }
      const step = script.shift() ?? 'succeed';
      if (step === 'lost_before_stripe') throw new FakeStripeError('StripeConnectionError');
      if (step === 'succeed' || step === 'succeed_but_lose_answer') {
        const pi = newPi(input.customerId, input.amountMinor, 'succeeded', input.metadata);
        byKey.set(key, { params, pi });
        if (step === 'succeed_but_lose_answer') throw new FakeStripeError('StripeConnectionError');
        return { ...pi };
      }
      if ('decline' in step) {
        newPi(input.customerId, input.amountMinor, 'requires_payment_method', input.metadata, { code: step.decline, message: 'declined' });
        const err = new FakeStripeError('StripeCardError', step.decline === 'authentication_required' ? 'authentication_required' : 'card_declined', step.decline);
        byKey.set(key, { params, err });
        throw err;
      }
      // Real Stripe stores every answer it produced — 500s included — for the key's lifetime.
      const err = new FakeStripeError(step.error, step.code);
      if (step.error !== 'StripeConnectionError') byKey.set(key, { params, err });
      throw err;
    },
    async retrieveCheckoutSession(id: string) {
      const s = sessions.get(id);
      if (!s) throw new FakeStripeError('StripeInvalidRequestError', 'resource_missing');
      return { ...s };
    },
    async listOpenCheckoutSessions(customerId: string) {
      return [...sessions.values()].filter((s) => s.customer === customerId && s.status === 'open').map((s) => ({ ...s }));
    },
    async expireCheckoutSession(id: string) {
      expireCalls.push(id);
      const s = sessions.get(id);
      if (!s) throw new FakeStripeError('StripeInvalidRequestError', 'resource_missing');
      if (s.status !== 'open') throw new FakeStripeError('StripeInvalidRequestError', 'checkout_session_not_expirable');
      s.status = 'expired';
      return { ...s };
    },
    async createPayLinkSession(input: Parameters<PayLaterIo['stripe']['createPayLinkSession']>[0]) {
      return { ...newSession(input.customerId, input.amountMinor, input.metadata, input.paymentMetadata, input.expiresAt) };
    },
    async detachPaymentMethod(id: string) {
      detached.push(id);
    },
    async refundPaymentIntent(id: string, key: string) {
      refunds.push({ paymentIntentId: id, key });
      const p = intents.get(id);
      if (p) p.amountRefunded = p.amountReceived;
      return { id: `re_${refunds.length}`, status: 'succeeded' };
    },
    async retrieveCustomer(id: string) {
      return customers.find((c) => c.id === id) ?? null;
    },
    async findCustomersByReservation(res: string) {
      return customers.filter((c) => c.metadata.bh_reservation === res);
    },
    async listCustomerCards(customerId: string) {
      return cards.get(customerId) ?? [];
    },
  };

  return {
    api,
    intents,
    sessions,
    refunds,
    detached,
    script,
    customers,
    cards,
    createCalls,
    expireCalls,
    /** The guest completes a pay-link page: a succeeded PI, session complete. */
    guestPays(sessionId: string) {
      const s = sessions.get(sessionId)!;
      if (s.status !== 'open') throw new Error('session not open');
      const pi = newPi(s.customer, s.amountMinor, 'succeeded', s.paymentMetadata);
      s.status = 'complete';
      s.paymentStatus = 'paid';
      s.paymentIntentId = pi.id;
      return pi;
    },
    /** A page our table never stored (the losing side of a race). */
    strayPage(customer: string, scheduleId: string, amountMinor: number) {
      return newSession(customer, amountMinor, { kind: 'paylater_link', schedule_id: scheduleId }, { kind: 'paylater', schedule_id: scheduleId, trigger: 'link' }, Math.floor(clock().getTime() / 1000) + 3600);
    },
  };
}

export function fakeBeds24() {
  const rows = new Map<number, Beds24Row>();
  const calls: Array<{ op: string; ids: number[]; note?: string }> = [];
  const hidden = new Set<number>();
  let down = false;
  let recent: Beds24Row[] = [];
  const api = {
    async fetchBookings(ids: number[]) {
      if (down) throw new Error('Beds24 503');
      calls.push({ op: 'fetch', ids });
      const out = new Map<number, Beds24Row>();
      for (const id of ids) if (rows.has(id) && !hidden.has(id)) out.set(id, { ...rows.get(id)! });
      // Same rule as the real adapter: asked for rows and got none → a failed read.
      if (ids.length > 0 && out.size === 0) throw new Error(`Beds24 returned no rows for ${ids.length} booking id(s)`);
      return out;
    },
    async markPaid(updates: Array<{ id: number; deposit: number }>, note: string) {
      if (down) throw new Error('Beds24 503');
      calls.push({ op: 'markPaid', ids: updates.map((u) => u.id), note });
      for (const u of updates) rows.get(u.id)!.deposit = u.deposit;
    },
    async cancelNonPayment(ids: number[], note: string) {
      if (down) throw new Error('Beds24 503');
      calls.push({ op: 'cancel', ids, note });
      for (const id of ids) {
        const r = rows.get(id)!;
        r.status = 'cancelled';
        r.subStatus = 'nonPayment';
      }
    },
    async recentPayLaterBookings() {
      if (down) throw new Error('Beds24 503');
      return recent.map((r) => ({ ...r }));
    },
  };
  return {
    api,
    rows,
    calls,
    setDown(v: boolean) {
      down = v;
    },
    /** Make Beds24 leave these ids out of its answers (a partial read). */
    hide(...ids: number[]) {
      for (const id of ids) hidden.add(id);
    },
    setRecent(r: Beds24Row[]) {
      recent = r;
    },
  };
}

export function beds24Row(id: number, over: Partial<Beds24Row> = {}): Beds24Row {
  return {
    id,
    masterId: null,
    status: 'confirmed',
    subStatus: null,
    arrival: '2026-12-10',
    departure: '2026-12-13',
    price: 12345,
    deposit: 0,
    referer: 'DirectWeb',
    notes: null,
    bookingTime: '2026-11-10T10:00:00Z',
    infoCodes: ['PAYLATER'],
    infoItems: [{ code: 'PAYLATER', text: 'Platba kartou naplánována' }],
    firstName: 'Jan',
    lastName: 'Novák',
    email: 'jan@example.com',
    ...over,
  };
}

export function harness(start = '2026-11-10T10:00:00Z') {
  let now = new Date(start);
  const clock = () => new Date(now);
  const repo: MemoryRepo = memoryRepo(clock);
  const stripe = fakeStripe(clock);
  const beds24 = fakeBeds24();
  const emails: Array<{ to: string; subject: string; html: string }> = [];
  const alerts: string[] = [];
  const tasks = new Map<string, Array<{ id: string; text: string; resolved: boolean }>>();
  const vouchers = new Map<string, { status: 'issued' | 'used'; redeemedOn?: string }>();
  const paymentLog: Array<Record<string, unknown>> = [];
  const paidElsewhere = new Map<string, string>();
  let mode: WebPaymentMode = 'auto';
  let failEmail: RegExp | null = null;
  let n = 0;

  const io: PayLaterIo = {
    repo,
    stripe: stripe.api,
    beds24: beds24.api,
    async sendEmail(to, subject, html) {
      if (failEmail && failEmail.test(subject)) throw new Error('SMTP down');
      emails.push({ to, subject, html });
    },
    async techAlert(html) {
      alerts.push(html);
    },
    async addTask(res, id, text) {
      // Same rule as the real one: one task per id, ever (resolved stays resolved).
      const list = tasks.get(res) ?? [];
      if (list.some((t) => t.id === id)) return false;
      tasks.set(res, [...list, { id, text, resolved: false }]);
      return true;
    },
    async resolveTasks(res, prefix) {
      for (const t of tasks.get(res) ?? []) if (t.id.startsWith(prefix)) t.resolved = true;
    },
    async restoreVoucher(code, res) {
      const v = vouchers.get(code);
      if (!v) return 'not_found';
      if (v.status !== 'used' || v.redeemedOn !== res) return 'not_used_here';
      v.status = 'issued';
      v.redeemedOn = undefined;
      return 'restored';
    },
    async logPayment(record) {
      if (!paymentLog.some((r) => r.sessionId === record.sessionId)) paymentLog.push(record);
    },
    async paidElsewhere(reservationNumbers) {
      return new Map(reservationNumbers.filter((r) => paidElsewhere.has(r)).map((r) => [r, paidElsewhere.get(r)!]));
    },
    async mode() {
      return mode;
    },
    now: clock,
    newId: (prefix) => `${prefix}-${++n}`,
    newToken: () => `tok${++n}`,
    baseUrl: () => 'https://reporting.test',
  };

  return {
    io,
    repo,
    stripe,
    beds24,
    emails,
    alerts,
    tasks,
    vouchers,
    paymentLog,
    paidElsewhere,
    setNow(iso: string) {
      now = new Date(iso);
    },
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    setMode(m: WebPaymentMode) {
      mode = m;
    },
    /** true = every email fails; a RegExp = only emails whose subject matches. */
    setFailEmail(v: boolean | RegExp) {
      failEmail = v === true ? /./ : v === false ? null : v;
    },
    /** A saved card on a fresh customer, as the website leaves it. */
    savedCard(customerId = 'cus_1', pmId = 'pm_1') {
      stripe.cards.set(customerId, [{ id: pmId, card: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 } }]);
    },
  };
}

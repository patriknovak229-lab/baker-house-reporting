import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyAdminAction,
  chargeSchedule,
  openPayLink,
  parseRegistration,
  registerSchedule,
  runWebPaymentsJob,
  settleLinkSession,
  settlePaymentIntent,
  type RegistrationInput,
} from './engine';
import { beds24Row, harness } from './testkit';

// Patrik's example: booked 10 Nov, arrival 10 Dec, 3 nights → free cancellation until 3 Dec,
// 1st charge 1 Dec 08:00, 2nd charge 2 Dec 16:00 (Prague).
const ATTEMPT1 = '2026-12-01T07:05:00Z';
const ATTEMPT2 = '2026-12-02T15:05:00Z';

function input(over: Partial<RegistrationInput> = {}): RegistrationInput {
  return {
    checkoutSessionId: 'cs_live_setup_1',
    setupIntentId: 'seti_1',
    customerId: 'cus_1',
    paymentMethodId: 'pm_1',
    livemode: true,
    bookingIds: [95000001],
    arrival: '2026-12-10',
    departure: '2026-12-13',
    amountMinor: 1234500,
    currency: 'czk',
    guest: { name: 'Jan Novák', email: 'jan@example.com', phone: '+420777000111', lang: 'cs' },
    roomLabel: 'Deluxe studio',
    voucherCode: null,
    termsVersion: '2026-11-13.1',
    attempt1At: '2026-12-01T07:00:00.000Z',
    deadlineDate: '2026-12-03',
    ...over,
  };
}

let h: ReturnType<typeof harness>;

async function registered(over: Partial<RegistrationInput> = {}) {
  h.savedCard();
  for (const id of over.bookingIds ?? [95000001]) h.beds24.rows.set(id, beds24Row(id));
  const r = await registerSchedule(h.io, input(over), 'website', 'website');
  if (!r.ok) throw new Error(r.error);
  return r.scheduleId;
}
const run = () => runWebPaymentsJob(h.io, { recoveryDue: false });
const row = async (id: string) => (await h.repo.get(id))!;

beforeEach(() => {
  h = harness();
});

describe('registration', () => {
  it('stores the schedule with reporting\'s own dates and emails the guest', async () => {
    const id = await registered();
    const s = await row(id);
    expect(s.reservationNumber).toBe('BH-95000001');
    expect(s.status).toBe('scheduled');
    expect(s.attempt1At).toBe('2026-12-01T07:00:00.000Z');
    expect(s.attempt2At).toBe('2026-12-02T15:00:00.000Z');
    expect(s.deadlineDate).toBe('2026-12-03');
    expect(s.cardLast4).toBe('4242');
    expect(h.emails).toHaveLength(1);
    expect(h.emails[0].subject).toContain('naplánována na 1. 12. 2026');
    expect(h.emails[0].html).toContain('https://reporting.test/pay/');
    expect(h.alerts.some((a) => a.includes('Pay later'))).toBe(true);
  });

  it('can answer first and notify after (the website\'s 4 s timeout)', async () => {
    h.savedCard();
    h.beds24.rows.set(95000001, beds24Row(95000001));
    const r = await registerSchedule(h.io, input(), 'website', 'website', { notify: 'defer' });
    expect(r.ok && r.created).toBe(true);
    expect(h.emails).toHaveLength(0);
    if (r.ok && r.notify) await r.notify();
    expect(h.emails).toHaveLength(1);
  });

  it('is idempotent: the website retrying changes nothing', async () => {
    const id = await registered();
    const again = await registerSchedule(h.io, input(), 'website', 'website');
    expect(again).toEqual({ ok: true, scheduleId: id, created: false });
    expect(h.emails).toHaveLength(1);
  });

  it('refuses a card that is not on that customer, or a test/live mix-up', async () => {
    h.savedCard('cus_other', 'pm_1');
    expect(await registerSchedule(h.io, input(), 'website', 'website')).toMatchObject({ ok: false, status: 409, code: 'payment_method_not_on_customer' });
    h.savedCard();
    expect(await registerSchedule(h.io, input({ livemode: false }), 'website', 'website')).toMatchObject({ ok: false, code: 'livemode_mismatch' });
  });

  it('alerts when the website showed different dates (reporting\'s win)', async () => {
    await registered({ attempt1At: '2026-12-02T07:00:00.000Z' });
    expect(h.alerts.some((a) => a.includes('dates differ'))).toBe(true);
  });

  it('validates the website payload strictly', () => {
    expect(parseRegistration({ version: 1 }).ok).toBe(false);
    const body = { ...input(), version: 1 };
    expect(parseRegistration(body).ok).toBe(true);
    expect(parseRegistration({ ...body, amountMinor: 12.5 }).ok).toBe(false);
    expect(parseRegistration({ ...body, currency: 'eur' }).ok).toBe(false);
    expect(parseRegistration({ ...body, bookingIds: [] }).ok).toBe(false);
    expect(parseRegistration({ ...body, guest: { ...body.guest, email: 'nope' } }).ok).toBe(false);
  });
});

describe('the timeline (auto mode)', () => {
  it('reminder on 28 Nov, charge on 1 Dec, receipt, Beds24 paid, VAT log, card removed', async () => {
    const id = await registered();
    h.setNow('2026-11-28T08:30:00Z');
    await run();
    expect(h.emails.map((e) => e.subject)).toEqual([
      expect.stringContaining('naplánována'),
      expect.stringContaining('Připomínka'),
    ]);

    h.setNow(ATTEMPT1);
    const summary = await run();
    expect(summary.charged).toBe(1);
    const s = await row(id);
    expect(s.status).toBe('paid');
    expect(s.paidVia).toBe('auto');
    expect(h.stripe.createCalls).toEqual([`wp_${id}_1`]);
    const pi = [...h.stripe.intents.values()][0];
    expect(pi.metadata).toMatchObject({ kind: 'paylater', schedule_id: id, trigger: 'auto1', arrival: '2026-12-10', departure: '2026-12-13' });
    expect(pi.metadata.reservationNumber).toBeUndefined(); // payouts must treat it as a web booking
    expect(h.beds24.rows.get(95000001)!.deposit).toBe(12345);
    expect(h.paymentLog).toEqual([
      expect.objectContaining({ sessionId: `paylater_live_${pi.id}`, description: 'Web booking 2026-12-10 → 2026-12-13 · pay later', amountCzk: 12345 }),
    ]);
    expect(h.emails.at(-1)!.subject).toContain('Platba přijata');
    expect(h.stripe.detached).toEqual(['pm_1']);
    expect(s.stripePaymentMethodId).toBeNull();

    // Nothing more happens on later runs.
    h.setNow(ATTEMPT2);
    await run();
    expect(h.stripe.createCalls).toHaveLength(1);
    expect(h.emails.filter((e) => e.subject.includes('Platba přijata'))).toHaveLength(1);
  });

  it('decline → failed email with the pay-by time → 2nd decline → cancelled as non-payment', async () => {
    const id = await registered({ voucherCode: 'KAREN500' });
    h.vouchers.set('KAREN500', { status: 'used', redeemedOn: 'BH-95000001' });
    h.stripe.script.push({ decline: 'insufficient_funds' }, { decline: 'insufficient_funds' });

    h.setNow(ATTEMPT1);
    await run();
    let s = await row(id);
    expect(s.status).toBe('failed');
    expect(s.autoDeclines).toBe(1);
    const failed = h.emails.at(-1)!;
    expect(failed.subject).toContain('neprošla');
    expect(failed.html).toContain('2. 12. 2026 v 16:00');
    expect(failed.html).toContain('na kartě není dostatek prostředků');
    expect(h.tasks.get('BH-95000001')!.map((t) => t.id)).toContain('paylater-declined');
    expect(h.beds24.calls.some((c) => c.op === 'cancel')).toBe(false);

    h.setNow('2026-12-02T14:00:00Z'); // before 16:00 Prague: nothing
    await run();
    expect(h.stripe.createCalls).toHaveLength(1);

    h.setNow(ATTEMPT2);
    const summary = await run();
    expect(summary.cancelled).toBe(1);
    s = await row(id);
    expect(s.status).toBe('cancelled_unpaid');
    expect(h.beds24.rows.get(95000001)).toMatchObject({ status: 'cancelled', subStatus: 'nonPayment' });
    expect(h.vouchers.get('KAREN500')!.status).toBe('issued');
    const cancelled = h.emails.at(-1)!;
    expect(cancelled.subject).toContain('byla zrušena');
    expect(cancelled.html).toContain('KAREN500');
    expect(h.stripe.detached).toEqual(['pm_1']);
    expect(h.tasks.get('BH-95000001')!.every((t) => t.resolved)).toBe(true);
    expect(h.stripe.createCalls).toEqual([`wp_${id}_1`, `wp_${id}_2`]);
  });

  it('the guest pays through the link between the attempts → no 2nd charge, no cancellation', async () => {
    const id = await registered();
    h.stripe.script.push({ decline: 'card_declined' });
    h.setNow(ATTEMPT1);
    await run();
    const s = await row(id);

    h.setNow('2026-12-01T18:00:00Z');
    const page = await openPayLink(h.io, s.payToken, {});
    expect(page.kind).toBe('redirect');
    const sessionId = (await row(id)).openLinkSessionId!;
    h.stripe.guestPays(sessionId);
    expect(await settleLinkSession(h.io, sessionId, 'stripe-webhook')).toBe('paid');
    expect((await row(id)).paidVia).toBe('link');

    h.setNow(ATTEMPT2);
    await run();
    expect(h.stripe.createCalls).toHaveLength(1);
    expect(h.beds24.calls.some((c) => c.op === 'cancel')).toBe(false);
  });

  it('two declines with "don\'t auto-cancel" → an admin decides, nothing is cancelled', async () => {
    const id = await registered();
    await applyAdminAction(h.io, id, { action: 'set_no_auto_cancel', value: true }, 'patrik@example.com');
    h.stripe.script.push({ decline: 'card_declined' }, { decline: 'card_declined' });
    h.setNow(ATTEMPT1);
    await run();
    h.setNow(ATTEMPT2);
    const summary = await run();
    expect(summary.waitingForAdmin).toBe(1);
    expect((await row(id)).status).toBe('failed');
    expect(h.beds24.calls.some((c) => c.op === 'cancel')).toBe(false);
    expect(h.tasks.get('BH-95000001')!.map((t) => t.id)).toContain('paylater-decide');
  });

  it('never cancels automatically after free cancellation ended', async () => {
    const id = await registered();
    h.stripe.script.push({ decline: 'card_declined' }, { decline: 'card_declined' });
    h.setNow(ATTEMPT1);
    await run();
    h.setNow('2026-12-04T08:00:00Z'); // the runs on 2–3 Dec were all lost
    await run();
    expect((await row(id)).status).toBe('failed');
    expect(h.beds24.calls.some((c) => c.op === 'cancel')).toBe(false);
    expect(h.alerts.some((a) => a.includes('free cancellation is over'))).toBe(true);
  });

  it('a late 1st decline still gives the guest 20 hours', async () => {
    const id = await registered();
    h.stripe.script.push({ decline: 'card_declined' });
    h.setNow('2026-12-02T12:00:00Z'); // the 1st-attempt runs were lost until noon on 2 Dec
    await run();
    expect((await row(id)).status).toBe('failed');
    h.setNow(ATTEMPT2);
    await run();
    expect(h.stripe.createCalls).toHaveLength(1);
    h.setNow('2026-12-03T08:05:00Z');
    await run();
    expect(h.stripe.createCalls).toHaveLength(2);
  });
});

describe('our failures never count against the guest', () => {
  it('a temporary bank or Stripe problem is retried, with no email and no decline', async () => {
    const id = await registered();
    h.stripe.script.push({ error: 'StripeRateLimitError' });
    h.setNow(ATTEMPT1);
    await run();
    let s = await row(id);
    expect(s.status).toBe('scheduled');
    expect(s.autoDeclines).toBe(0);
    expect(s.attention).toBe('technical_error');
    expect(h.emails.filter((e) => e.subject.includes('neprošla'))).toHaveLength(0);

    h.setNow('2026-12-01T11:00:00Z');
    await run();
    s = await row(id);
    expect(s.status).toBe('paid');
  });

  it('Beds24 unreadable → nothing is charged that run', async () => {
    const id = await registered();
    h.beds24.setDown(true);
    h.setNow(ATTEMPT1);
    await run();
    expect(h.stripe.createCalls).toHaveLength(0);
    expect((await row(id)).status).toBe('scheduled');
    h.beds24.setDown(false);
    await run();
    expect((await row(id)).status).toBe('paid');
  });
});

describe('no double charge', () => {
  it('a second simultaneous charge finds the claim taken', async () => {
    const id = await registered();
    h.setNow(ATTEMPT1);
    const claimed = await h.repo.claim(id, 'other-run', new Date(0), ['scheduled', 'failed']);
    expect(claimed).not.toBeNull();
    expect(await chargeSchedule(h.io, id, 'manual', 'admin')).toEqual({ outcome: 'busy' });
    expect(h.stripe.createCalls).toHaveLength(0);
  });

  it('Stripe charged but the answer was lost → the next run settles it, no new charge', async () => {
    const id = await registered();
    h.stripe.script.push('succeed_but_lose_answer');
    h.setNow(ATTEMPT1);
    await run();
    let s = await row(id);
    expect(s.status).toBe('scheduled');
    expect(s.pendingAttempt?.n).toBe(1);

    h.setNow('2026-12-01T11:00:00Z');
    await run();
    s = await row(id);
    expect(s.status).toBe('paid');
    expect(h.stripe.intents.size).toBe(1);
    expect(h.stripe.createCalls).toEqual([`wp_${id}_1`]);
  });

  it('the request never reached Stripe → replayed with the same key soon after, one payment', async () => {
    const id = await registered();
    h.stripe.script.push('lost_before_stripe');
    h.setNow(ATTEMPT1);
    await run();
    h.advance(5 * 60_000); // an admin presses Charge now 5 minutes later
    expect(await chargeSchedule(h.io, id, 'manual', 'admin')).toMatchObject({ outcome: 'paid' });
    expect(h.stripe.createCalls).toEqual([`wp_${id}_1`, `wp_${id}_1`]);
    expect(h.stripe.intents.size).toBe(1);
  });

  it('no payment in Stripe 15 min after a lost request → a fresh key (a stored 500 would block a day)', async () => {
    const id = await registered();
    h.stripe.script.push({ error: 'StripeAPIError' }); // Stripe stores this 500 under the key
    h.setNow(ATTEMPT1);
    await run();
    expect((await row(id)).pendingAttempt?.n).toBe(1);
    h.setNow('2026-12-01T09:00:00Z');
    await run();
    expect((await row(id)).status).toBe('paid');
    expect(h.stripe.createCalls).toEqual([`wp_${id}_1`, `wp_${id}_2`]);
    expect(h.stripe.intents.size).toBe(1);
  });

  it('an open pay-link page is closed before the scheduled charge', async () => {
    const id = await registered();
    await openPayLink(h.io, (await row(id)).payToken, {});
    const sessionId = (await row(id)).openLinkSessionId!;
    h.setNow(ATTEMPT1);
    await run();
    expect(h.stripe.expireCalls).toContain(sessionId);
    expect(h.stripe.sessions.get(sessionId)!.status).toBe('expired');
    expect((await row(id)).status).toBe('paid');
  });

  it('the guest paid on the link a moment before the charge → settled, not charged', async () => {
    const id = await registered();
    await openPayLink(h.io, (await row(id)).payToken, {});
    h.stripe.guestPays((await row(id)).openLinkSessionId!); // the webhook hasn't arrived yet
    h.setNow(ATTEMPT1);
    await run();
    const s = await row(id);
    expect(s.status).toBe('paid');
    expect(s.paidVia).toBe('link');
    expect(h.stripe.createCalls).toHaveLength(0);
  });

  it('a second successful payment is refunded automatically', async () => {
    const id = await registered();
    await openPayLink(h.io, (await row(id)).payToken, {});
    const sessionId = (await row(id)).openLinkSessionId!;
    h.setNow(ATTEMPT1);
    await run(); // charged off-session; the link page was expired first
    // Simulate the impossible-in-practice case: another payment for the schedule succeeds anyway.
    const stray = await h.stripe.api.createOffSessionPayment(
      { amountMinor: 1234500, currency: 'czk', customerId: 'cus_1', paymentMethodId: 'pm_x', description: 'x', metadata: { kind: 'paylater', schedule_id: id, trigger: 'link' } },
      'stray',
    );
    expect(await settlePaymentIntent(h.io, stray.id, 'stripe-webhook')).toBe('duplicate_refunded');
    expect(h.stripe.refunds).toEqual([{ paymentIntentId: stray.id, key: `wp_dup_${stray.id}` }]);
    expect(h.stripe.sessions.get(sessionId)!.status).toBe('expired');
  });

  it('the webhook and our own charge settling the same payment is harmless', async () => {
    const id = await registered();
    h.setNow(ATTEMPT1);
    await run();
    const pi = [...h.stripe.intents.values()][0];
    expect(await settlePaymentIntent(h.io, pi.id, 'stripe-webhook')).toBe('already');
    expect(h.stripe.refunds).toHaveLength(0);
    expect((await row(id)).paidPaymentIntentId).toBe(pi.id);
  });

  it('a payment arriving after a cancellation is refunded', async () => {
    const id = await registered();
    const s = await row(id);
    await openPayLink(h.io, s.payToken, {});
    const sessionId = (await row(id)).openLinkSessionId!;
    h.stripe.guestPays(sessionId);
    // The booking got cancelled by ops at the same time and the job closed it first.
    await h.repo.patch(id, { status: 'cancelled' });
    expect(await settleLinkSession(h.io, sessionId, 'stripe-webhook')).toBe('duplicate_refunded');
  });
});

describe('Beds24 checks', () => {
  it('booking cancelled in Beds24 before the charge → closed quietly, card removed, nothing charged', async () => {
    const id = await registered();
    h.beds24.rows.get(95000001)!.status = 'cancelled';
    h.setNow(ATTEMPT1);
    await run();
    expect((await row(id)).status).toBe('cancelled');
    expect(h.stripe.createCalls).toHaveLength(0);
    expect(h.stripe.detached).toEqual(['pm_1']);
    expect(h.emails).toHaveLength(1); // only the original confirmation
  });

  it('dates moved by ops → new charge dates, same amount', async () => {
    const id = await registered();
    Object.assign(h.beds24.rows.get(95000001)!, { arrival: '2026-12-20', departure: '2026-12-23' });
    h.setNow('2026-11-20T10:00:00Z');
    await run();
    const s = await row(id);
    expect(s.attempt1At).toBe('2026-12-11T07:00:00.000Z');
    expect(s.amountMinor).toBe(1234500);
  });

  it('Beds24 price ≠ agreed amount → flagged, but the agreed amount is charged', async () => {
    const id = await registered();
    h.beds24.rows.get(95000001)!.price = 9999;
    h.setNow('2026-11-20T10:00:00Z');
    await run();
    expect((await row(id)).attention).toBe('amount_mismatch');
    h.setNow(ATTEMPT1);
    await run();
    expect([...h.stripe.intents.values()][0].amount).toBe(1234500);
  });

  it('Beds24 shows it paid → charging is blocked until an admin looks', async () => {
    const id = await registered();
    h.beds24.rows.get(95000001)!.deposit = 12345;
    h.setNow(ATTEMPT1);
    await run();
    expect(h.stripe.createCalls).toHaveLength(0);
    expect((await row(id)).attention).toBe('beds24_shows_paid');
    expect(await chargeSchedule(h.io, id, 'manual', 'admin')).toMatchObject({ outcome: 'blocked' });
  });

  it('two studios: one charge, both rows marked paid', async () => {
    const id = await registered({ bookingIds: [95000001, 95000002], amountMinor: 2469000 });
    h.setNow(ATTEMPT1);
    await run();
    expect((await row(id)).status).toBe('paid');
    expect(h.stripe.intents.size).toBe(1);
    expect(h.beds24.rows.get(95000001)!.deposit).toBe(12345);
    expect(h.beds24.rows.get(95000002)!.deposit).toBe(12345);
  });
});

describe('manual mode and admin actions', () => {
  it('manual mode: a due charge waits for the admin; Charge now works any time', async () => {
    h.setMode('manual');
    const id = await registered();
    h.setNow(ATTEMPT1);
    const summary = await run();
    expect(summary.waitingForAdmin).toBe(1);
    expect(h.stripe.createCalls).toHaveLength(0);
    expect(h.alerts.some((a) => a.includes('Charge now'))).toBe(true);

    const r = await applyAdminAction(h.io, id, { action: 'charge_now' }, 'patrik@example.com');
    expect(r).toMatchObject({ ok: true, detail: { outcome: 'paid' } });
    expect((await row(id)).paidVia).toBe('manual');
  });

  it('Charge now before the date (the guest phoned) — a decline there is not a scheduled attempt', async () => {
    const id = await registered();
    h.stripe.script.push({ decline: 'card_declined' });
    const r = await applyAdminAction(h.io, id, { action: 'charge_now' }, 'patrik@example.com');
    expect(r).toMatchObject({ ok: true, detail: { outcome: 'declined' } });
    const s = await row(id);
    expect(s.status).toBe('scheduled');
    expect(s.autoDeclines).toBe(0);
    expect(h.emails.filter((e) => e.subject.includes('neprošla'))).toHaveLength(0);
  });

  it('mark paid another way: no charge ever, Beds24 paid, no Stripe receipt or VAT row', async () => {
    const id = await registered();
    expect(await applyAdminAction(h.io, id, { action: 'mark_paid_other', note: '' }, 'a')).toMatchObject({ ok: false, status: 400 });
    expect(await applyAdminAction(h.io, id, { action: 'mark_paid_other', note: 'bank transfer 3 Dec' }, 'a')).toEqual({ ok: true });
    h.setNow(ATTEMPT1);
    await run();
    expect(h.stripe.createCalls).toHaveLength(0);
    expect(h.beds24.rows.get(95000001)!.deposit).toBe(12345);
    expect(h.paymentLog).toHaveLength(0);
    expect(h.emails.filter((e) => e.subject.includes('Platba přijata'))).toHaveLength(0);
  });

  it('change amount needs a reason; the new amount is charged', async () => {
    const id = await registered();
    expect(await applyAdminAction(h.io, id, { action: 'set_amount', amountCzk: 10000, reason: '' }, 'a')).toMatchObject({ ok: false });
    expect(await applyAdminAction(h.io, id, { action: 'set_amount', amountCzk: 10000, reason: 'one night less, agreed by phone' }, 'a')).toEqual({ ok: true });
    h.setNow(ATTEMPT1);
    await run();
    expect([...h.stripe.intents.values()][0].amount).toBe(1000000);
  });
});

describe('the pay link', () => {
  it('opens Stripe, then shows "already paid" once paid', async () => {
    const id = await registered();
    const token = (await row(id)).payToken;
    const first = await openPayLink(h.io, token, {});
    expect(first).toMatchObject({ kind: 'redirect' });
    const sessionId = (await row(id)).openLinkSessionId!;
    h.stripe.guestPays(sessionId);
    const back = await openPayLink(h.io, token, { done: true, sessionId });
    expect(back).toMatchObject({ kind: 'page', page: 'paid_now' });
    expect(await openPayLink(h.io, token, {})).toMatchObject({ kind: 'page', page: 'paid' });
  });

  it('reuses an open page instead of creating a second one', async () => {
    const id = await registered();
    const token = (await row(id)).payToken;
    const a = await openPayLink(h.io, token, {});
    const b = await openPayLink(h.io, token, {});
    expect(a).toEqual(b);
    expect(h.stripe.sessions.size).toBe(1);
  });

  it('refuses while a charge is running, and for a booking cancelled in Beds24', async () => {
    const id = await registered();
    const token = (await row(id)).payToken;
    await h.repo.claim(id, 'job', new Date(0), ['scheduled']);
    expect(await openPayLink(h.io, token, {})).toMatchObject({ page: 'busy' });
    await h.repo.release(id, 'job');
    h.beds24.rows.get(95000001)!.status = 'cancelled';
    expect(await openPayLink(h.io, token, {})).toMatchObject({ page: 'cancelled' });
    expect(await openPayLink(h.io, 'nope', {})).toMatchObject({ page: 'not_found' });
  });
});

describe('safety nets', () => {
  it('mode off: nothing is charged, and the tech chat hears about due payments once a day', async () => {
    h.setMode('off');
    const id = await registered();
    h.setNow(ATTEMPT1);
    await run();
    await run();
    expect(h.stripe.createCalls).toHaveLength(0);
    expect((await row(id)).status).toBe('scheduled');
    expect(h.alerts.filter((a) => a.includes('is OFF'))).toHaveLength(1);
  });

  it('a failed Beds24 update after payment is retried by the outbox', async () => {
    const id = await registered();
    h.setNow(ATTEMPT1);
    // Fail only the markPaid call.
    const realMarkPaid = h.beds24.api.markPaid;
    h.beds24.api.markPaid = async () => {
      throw new Error('Beds24 503');
    };
    await run();
    expect((await row(id)).attention).toBe('beds24_sync_pending');
    h.beds24.api.markPaid = realMarkPaid;
    h.setNow('2026-12-01T11:00:00Z');
    await run();
    const s = await row(id);
    expect(s.effects.beds24Paid).toBeTruthy();
    expect(s.attention).toBeNull();
    expect(h.beds24.rows.get(95000001)!.deposit).toBe(12345);
  });

  it('a failed confirmation email is sent again by the next run', async () => {
    h.setFailEmail(true);
    const id = await registered();
    expect((await row(id)).emails.scheduled).toBeUndefined();
    h.setFailEmail(false);
    h.setNow('2026-11-11T10:00:00Z');
    await run();
    expect((await row(id)).emails.scheduled).toBeTruthy();
  });

  it('recovery: a website booking that never registered is rebuilt from Stripe', async () => {
    h.savedCard('cus_9', 'pm_9');
    h.stripe.customers.push({
      id: 'cus_9',
      name: 'Eva Svobodová',
      email: 'eva@example.com',
      phone: null,
      metadata: { pay_later: '1', bh_reservation: 'BH-95000009', bh_booking_ids: '95000009', amount_minor: '880000', lang: 'cs' },
    });
    const old = { bookingTime: '2026-11-09T10:00:00Z', price: 8800 }; // past the 15-minute grace; matches amount_minor
    h.beds24.rows.set(95000009, beds24Row(95000009, old));
    h.beds24.setRecent([beds24Row(95000009, old)]);
    const r = await runWebPaymentsJob(h.io, { recoveryDue: true });
    expect(r.recovered).toBe(1);
    const s = (await h.repo.getByReservation('BH-95000009'))!;
    expect(s.source).toBe('recovered');
    expect(s.amountMinor).toBe(880000);
  });

  it('recovery: uses the PAYLATER_REF customer id on the booking first', async () => {
    h.savedCard('cus_ref', 'pm_ref');
    h.stripe.customers.push({
      id: 'cus_ref', name: 'Petr', email: 'petr@example.com', phone: null,
      metadata: { pay_later: '1', bh_booking_ids: '95000012', amount_minor: '1234500', lang: 'en' }, // no bh_reservation
    });
    const r = beds24Row(95000012, { bookingTime: '2026-11-09T10:00:00Z', infoItems: [{ code: 'PAYLATER', text: 'x' }, { code: 'PAYLATER_REF', text: 'Stripe cus_ref' }] });
    h.beds24.rows.set(95000012, r);
    h.beds24.setRecent([r]);
    expect((await runWebPaymentsJob(h.io, { recoveryDue: true })).recovered).toBe(1);
    expect((await h.repo.getByReservation('BH-95000012'))!.lang).toBe('en');
  });

  it('recovery: refuses when Beds24 does not add up to the agreed amount (half-created two studios)', async () => {
    h.savedCard('cus_2x', 'pm_2x');
    h.stripe.customers.push({
      id: 'cus_2x', name: 'Ola', email: 'ola@example.com', phone: null,
      metadata: { pay_later: '1', bh_reservation: 'BH-95000013', bh_booking_ids: '95000013,95000014', amount_minor: '2469000', lang: 'cs' },
    });
    const r = beds24Row(95000013, { bookingTime: '2026-11-09T10:00:00Z' }); // the second row was never created
    h.beds24.rows.set(95000013, r);
    h.beds24.setRecent([r]);
    const out = await runWebPaymentsJob(h.io, { recoveryDue: true });
    expect(out.recovered).toBe(0);
    expect(await h.repo.getByReservation('BH-95000013')).toBeNull();
    expect(h.alerts.some((a) => a.includes('NOT scheduled'))).toBe(true);
  });

  it('recovery: leaves a booking alone during its first 15 minutes (the website may still be registering)', async () => {
    h.beds24.setRecent([beds24Row(95000011)]);
    const r = await runWebPaymentsJob(h.io, { recoveryDue: true });
    expect(r.unregistered).toBe(0);
  });

  it('recovery: no card anywhere → one task and one alert, not one per run', async () => {
    h.beds24.setRecent([beds24Row(95000010, { bookingTime: '2026-11-09T10:00:00Z' })]);
    await runWebPaymentsJob(h.io, { recoveryDue: true });
    await runWebPaymentsJob(h.io, { recoveryDue: true });
    expect(h.tasks.get('BH-95000010')!.map((t) => t.id)).toEqual(['paylater-unregistered']);
    expect(h.alerts.filter((a) => a.includes('no schedule'))).toHaveLength(1);
  });
});

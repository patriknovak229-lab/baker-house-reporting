/**
 * The independent review of 13 Nov 2026 — one test per finding, reproducing
 * its scenario against the fixed engine (fakes are as strict as the real
 * systems: testkit.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyAdminAction,
  chargeSchedule,
  openPayLink,
  registerSchedule,
  runWebPaymentsJob,
  settleLinkSession,
  type RegistrationInput,
} from './engine';
import { beds24Row, harness } from './testkit';

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
    guest: { name: 'Jan Novák', email: 'jan@example.com', phone: null, lang: 'cs' },
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
  h.savedCard(over.customerId ?? 'cus_1', over.paymentMethodId ?? 'pm_1');
  for (const id of over.bookingIds ?? [95000001]) if (!h.beds24.rows.has(id)) h.beds24.rows.set(id, beds24Row(id));
  const r = await registerSchedule(h.io, input(over), 'website', 'website');
  if (!r.ok) throw new Error(r.error);
  return r.scheduleId;
}
const run = () => runWebPaymentsJob(h.io, { recoveryDue: true });
const row = async (id: string) => (await h.repo.get(id))!;
const failedEmails = () => h.emails.filter((e) => e.subject.includes('neprošla'));

beforeEach(() => {
  h = harness();
});

describe('#1 a booking cancelled in Beds24 is never charged', () => {
  it('ops cancel with "non payment" after a decline → closed as unpaid, guest told, no charge', async () => {
    const id = await registered();
    h.stripe.script.push({ decline: 'card_declined' });
    h.setNow(ATTEMPT1);
    await run();
    Object.assign(h.beds24.rows.get(95000001)!, { status: 'cancelled', subStatus: 'nonPayment' });
    h.setNow(ATTEMPT2);
    await run();
    expect((await row(id)).status).toBe('cancelled_unpaid');
    expect(h.stripe.createCalls).toHaveLength(1);
    expect(h.emails.at(-1)!.subject).toContain('byla zrušena');
  });

  it('our own cancellation interrupted after Beds24 cancelled → finished by the next run, not charged', async () => {
    const id = await registered();
    await h.repo.markJson(id, 'effects', 'cancelRequested', '2026-11-30T10:00:00Z');
    Object.assign(h.beds24.rows.get(95000001)!, { status: 'cancelled', subStatus: 'nonPayment' });
    h.setNow(ATTEMPT1);
    await run();
    expect((await row(id)).status).toBe('cancelled_unpaid');
    expect(h.stripe.createCalls).toHaveLength(0);
    expect(h.emails.at(-1)!.subject).toContain('byla zrušena');
  });

  it('"non payment" chosen before any decline → a quiet guest/ops cancellation', async () => {
    const id = await registered();
    Object.assign(h.beds24.rows.get(95000001)!, { status: 'cancelled', subStatus: 'nonPayment' });
    h.setNow(ATTEMPT1);
    await run();
    expect((await row(id)).status).toBe('cancelled');
    expect(h.emails.some((e) => e.subject.includes('byla zrušena'))).toBe(false);
  });
});

describe('#2 the guest always hears about a decline before anything else', () => {
  it('a failed "payment failed" email is re-sent; the 2nd attempt waits 20 h from it', async () => {
    const id = await registered();
    h.stripe.script.push({ decline: 'insufficient_funds' }, { decline: 'insufficient_funds' });
    h.setFailEmail(/neprošla/);
    h.setNow(ATTEMPT1);
    await run();
    expect((await row(id)).emails.failed).toBeUndefined();

    h.setNow('2026-12-02T15:05:00Z'); // the planned 2nd attempt — but the guest was never told
    h.setFailEmail(false);
    await run();
    expect(failedEmails()).toHaveLength(1);
    expect(h.stripe.createCalls).toHaveLength(1);
    expect(failedEmails()[0].html).toContain('3. 12. 2026 v 12:05'); // 20 h from the email

    h.setNow('2026-12-03T11:10:00Z');
    await run();
    expect(h.stripe.createCalls).toHaveLength(2);
    expect((await row(id)).status).toBe('cancelled_unpaid'); // still inside free cancellation (3 Dec)
  });

  it('if the email never goes out before the deadline, nothing is cancelled', async () => {
    const id = await registered();
    h.stripe.script.push({ decline: 'card_declined' });
    h.setFailEmail(/neprošla/);
    h.setNow(ATTEMPT1);
    await run();
    for (const t of ['2026-12-02T15:05:00Z', '2026-12-03T15:05:00Z', '2026-12-04T09:00:00Z']) {
      h.setNow(t);
      await run();
    }
    expect((await row(id)).status).toBe('failed');
    expect(h.beds24.calls.some((c) => c.op === 'cancel')).toBe(false);
    expect(h.alerts.some((a) => a.includes('never went out'))).toBe(true);
  });
});

describe('#3 soft declines back off instead of hammering the card', () => {
  it('try_again_later → a handful of attempts a day, not one per run or watchdog fire', async () => {
    const id = await registered();
    for (let i = 0; i < 20; i++) h.stripe.script.push({ decline: 'try_again_later' });
    h.setNow(ATTEMPT1);
    for (let i = 0; i < 12; i++) {
      await run(); // a run every 15 minutes for 3 hours
      h.advance(15 * 60_000);
    }
    expect(h.stripe.createCalls.length).toBeLessThanOrEqual(2);
    expect((await row(id)).autoDeclines).toBe(0);
    expect((await row(id)).status).toBe('scheduled');
  });

  it("Stripe's own decline rate limit never counts as the bank's decline", async () => {
    const id = await registered();
    h.stripe.script.push({ error: 'StripeCardError', code: 'card_decline_rate_limit_exceeded' });
    h.setNow(ATTEMPT1);
    await run();
    expect((await row(id)).autoDeclines).toBe(0);
    expect(failedEmails()).toHaveLength(0);
  });
});

describe('#4 moving the dates after declines never triggers a surprise cancellation', () => {
  it('declined twice after the deadline, dates moved to January → auto-cancel stays off', async () => {
    const id = await registered();
    h.stripe.script.push({ decline: 'card_declined' }, { decline: 'card_declined' });
    h.setNow(ATTEMPT1);
    await run();
    h.setNow('2026-12-04T08:00:00Z'); // runs lost; the 2nd attempt lands after the deadline
    await run();
    expect((await row(id)).autoDeclines).toBe(2);
    Object.assign(h.beds24.rows.get(95000001)!, { arrival: '2027-01-20', departure: '2027-01-23' });
    h.setNow('2026-12-05T08:00:00Z');
    await run();
    const s = await row(id);
    expect(s.noAutoCancel).toBe(true);
    expect(s.status).toBe('failed');
    expect(h.beds24.calls.some((c) => c.op === 'cancel')).toBe(false);
  });
});

describe('#5 Charge now re-checks Beds24; paid bookings stay watched', () => {
  it('the guest cancelled in Beds24 since the last run → Charge now refuses, nothing charged', async () => {
    const id = await registered();
    h.beds24.rows.get(95000001)!.status = 'cancelled';
    expect(await chargeSchedule(h.io, id, 'manual', 'admin')).toMatchObject({ outcome: 'not_chargeable' });
    expect(h.stripe.createCalls).toHaveLength(0);
    expect((await row(id)).status).toBe('cancelled');
  });

  it('paid, then cancelled in Beds24 → flagged for a refund', async () => {
    const id = await registered();
    h.setNow(ATTEMPT1);
    await run();
    h.beds24.rows.get(95000001)!.status = 'cancelled';
    h.setNow('2026-12-02T09:00:00Z');
    await run();
    expect((await row(id)).attention).toBe('paid_booking_cancelled');
    expect(h.tasks.get('BH-95000001')!.map((t) => t.id)).toContain('paylater-refund');
  });
});

describe('#6 no untracked pay-link page can take a second payment', () => {
  it('a page the table never stored is closed before the charge', async () => {
    const id = await registered();
    const stray = h.stripe.strayPage('cus_1', id, 1234500);
    h.setNow(ATTEMPT1);
    await run();
    expect(h.stripe.sessions.get(stray.id)!.status).toBe('expired');
    expect((await row(id)).status).toBe('paid');
  });

  it('two opens at once: the loser closes its page and sends the guest to the stored one', async () => {
    const id = await registered();
    const token = (await row(id)).payToken;
    const [a, b] = await Promise.all([openPayLink(h.io, token, {}), openPayLink(h.io, token, {})]);
    const open = [...h.stripe.sessions.values()].filter((s) => s.status === 'open');
    expect(open).toHaveLength(1);
    expect(a).toEqual(b);
  });
});

describe('#7 changing the amount closes old pages; a different payment is never "fully paid"', () => {
  it('the guest pays the old amount on a page opened before the change', async () => {
    const id = await registered();
    await openPayLink(h.io, (await row(id)).payToken, {});
    const oldPage = (await row(id)).openLinkSessionId!;
    await applyAdminAction(h.io, id, { action: 'set_amount', amountCzk: 15000, reason: 'extra night agreed' }, 'a');
    expect(h.stripe.sessions.get(oldPage)!.status).toBe('expired');

    // A page that slipped through anyway (opened by the guest a moment before the change):
    const slipped = h.stripe.strayPage('cus_1', id, 1234500);
    h.stripe.guestPays(slipped.id);
    await settleLinkSession(h.io, slipped.id, 'stripe-webhook');
    const s = await row(id);
    expect(s.status).toBe('paid');
    expect(s.attention).toBe('amount_paid_differs');
    expect(h.beds24.rows.get(95000001)!.deposit).toBe(12345); // what was actually paid, not the price
    const receipt = h.emails.find((e) => e.subject.includes('Platba přijata'))!;
    expect(receipt.html.replace(/\u00a0/g, ' ')).toContain('platbu 12 345 Kč'); // the receipt says what was paid
    expect(receipt.html.replace(/\u00a0/g, ' ')).not.toContain('15 000 Kč');
  });
});

describe('#9 cancelling respects "paid in Beds24" and the app\'s own Paid', () => {
  it('two declines, but Beds24 now shows the bank transfer → not cancelled', async () => {
    const id = await registered();
    h.stripe.script.push({ decline: 'card_declined' }, { decline: 'card_declined' });
    h.setNow(ATTEMPT1);
    await run();
    h.setNow(ATTEMPT2);
    h.beds24.api.cancelNonPayment = async () => {
      throw new Error('Beds24 503');
    };
    await run(); // 2nd decline; the cancellation fails and will be retried
    h.beds24.rows.get(95000001)!.deposit = 12345; // ops record the bank transfer
    h.setNow('2026-12-03T10:00:00Z');
    await run();
    expect((await row(id)).status).toBe('failed');
    expect((await row(id)).attention).toBe('beds24_shows_paid');
  });

  it("the drawer's Paid status blocks Charge now", async () => {
    const id = await registered();
    h.paidElsewhere.set('BH-95000001', 'the drawer\'s payment status is set to "Paid"');
    expect(await chargeSchedule(h.io, id, 'manual', 'admin')).toMatchObject({ outcome: 'blocked' });
    expect(h.stripe.createCalls).toHaveLength(0);
  });
});

describe('#10 a booking Beds24 does not return is not charged', () => {
  it('a partial Beds24 answer skips the unseen booking only', async () => {
    const seenId = await registered();
    const unseenId = await registered({ bookingIds: [95000002], checkoutSessionId: 'cs_live_setup_2', customerId: 'cus_2', paymentMethodId: 'pm_2' });
    h.beds24.hide(95000002);
    h.setNow(ATTEMPT1);
    await run();
    expect((await row(seenId)).status).toBe('paid');
    expect((await row(unseenId)).status).toBe('scheduled');
    expect(h.stripe.createCalls).toHaveLength(1);
  });
});

describe('#12 an amount change while an attempt is unanswered takes a fresh key', () => {
  it('no idempotency error, no admin task — the new amount is charged once', async () => {
    const id = await registered();
    h.stripe.script.push('lost_before_stripe');
    h.setNow(ATTEMPT1);
    await run();
    await applyAdminAction(h.io, id, { action: 'set_amount', amountCzk: 10000, reason: 'one night less' }, 'a');
    h.advance(5 * 60_000);
    expect(await chargeSchedule(h.io, id, 'manual', 'admin')).toMatchObject({ outcome: 'paid' });
    expect(h.stripe.createCalls).toEqual([`wp_${id}_1`, `wp_${id}_2`]);
    expect([...h.stripe.intents.values()].map((p) => p.amount)).toEqual([1000000]);
    expect(h.tasks.get('BH-95000001')?.some((t) => t.id === 'paylater-technical') ?? false).toBe(false);
  });
});

describe('#13 the tax point is when Stripe took the money', () => {
  it('a 23:59 charge recorded after midnight keeps its time', async () => {
    const id = await registered();
    h.stripe.script.push('succeed_but_lose_answer');
    h.setNow('2026-11-30T22:59:00Z'); // 23:59 Prague on 30 Nov, via Charge now
    await chargeSchedule(h.io, id, 'manual', 'admin');
    h.setNow('2026-12-01T07:05:00Z');
    await run();
    expect((await row(id)).paidAt).toBe('2026-11-30T22:59:00.000Z');
  });
});

describe('#14 the Stripe-vs-table check catches a payment no webhook reported', () => {
  it('a payment on an untracked page after the schedule was closed is refunded', async () => {
    const id = await registered();
    const stray = h.stripe.strayPage('cus_1', id, 1234500);
    await applyAdminAction(h.io, id, { action: 'mark_paid_other', note: 'bank transfer' }, 'a');
    // The outbox closed every open page… unless the guest was already paying on it:
    if (h.stripe.sessions.get(stray.id)!.status === 'expired') h.stripe.sessions.get(stray.id)!.status = 'open';
    h.stripe.guestPays(stray.id); // and no webhook ever arrives
    await run();
    expect(h.stripe.refunds).toHaveLength(1);
  });
});

describe('#15 one booking failing never stops the others', () => {
  it('a crash on one schedule still lets the next one be charged', async () => {
    const a = await registered();
    const b = await registered({ bookingIds: [95000002], checkoutSessionId: 'cs_live_setup_2', customerId: 'cus_2', paymentMethodId: 'pm_2' });
    const real = h.io.paidElsewhere;
    h.io.paidElsewhere = async (rns) => {
      if (rns.length === 1 && rns[0] === 'BH-95000001') throw new Error('boom');
      return real(rns);
    };
    h.setNow(ATTEMPT1);
    await run();
    expect((await row(a)).status).toBe('scheduled');
    expect((await row(b)).status).toBe('paid');
  });
});

describe('#16 a cancelled booking that comes back is flagged', () => {
  it('reinstated in Beds24 after the schedule closed → alert + task (the card is gone)', async () => {
    const id = await registered();
    h.beds24.rows.get(95000001)!.status = 'cancelled';
    h.setNow('2026-11-20T10:00:00Z');
    await run();
    expect((await row(id)).status).toBe('cancelled');
    h.beds24.rows.get(95000001)!.status = 'confirmed';
    h.setNow('2026-11-21T10:00:00Z');
    await run();
    expect((await row(id)).attention).toBe('reinstated_unpaid');
    expect(h.tasks.get('BH-95000001')!.map((t) => t.id)).toContain('paylater-reinstated');
  });
});

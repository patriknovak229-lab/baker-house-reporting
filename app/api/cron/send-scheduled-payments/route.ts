/**
 * GET|POST /api/cron/send-scheduled-payments
 *
 * Daily (vercel.json 09:00 UTC = 10:00/11:00 Prague). Works through the
 * scheduled payment links (types/scheduledPaymentLink.ts); the rules live in
 * utils/scheduledPaymentLinks.ts (pure, tested), this file only does I/O:
 *
 *   send     — create the Stripe link, email it, record the unpaid payment
 *   remind   — the first link expired unpaid: expire it, send ONE fresh link
 *   overdue  — the reminder expired unpaid: in-app alert + Telegram to operations
 *   block    — send-day checks failed: in-app alert only, nothing sent
 *   mark-paid
 *
 * Each link is saved as soon as it is handled, so a crash part-way through
 * never resends what already went out. 3 technical failures in a row → `failed`
 * alert. Bookings are read live from Beds24 on the day.
 *
 * Legacy `split_payments` rows (Create Booking → split payment) are NOT sent by
 * this job; there were none pending when it was switched on (2026-11-18).
 *
 * Auth: platform cron via utils/cronAuth (CRON_SECRET bearer; exempted in
 * proxy.ts); manual = admin/super.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAccess } from '@/utils/authGuard';
import { cronAuth } from '@/utils/cronAuth';
import { withCronLock } from '@/utils/cronLock';
import { writeCronHeartbeat } from '@/data-access/cronHeartbeat';
import { listScheduledLinks, saveScheduledLink } from '@/data-access/scheduledPaymentLinks';
import type { AdditionalPayment } from '@/types/additionalPayment';
import { readAllAdditionalPayments, writeAllAdditionalPayments } from '@/utils/additionalPaymentsStore';
import { getAccessToken } from '@/utils/beds24Auth';
import { netPaidOnBooking, wasPaid } from '@/utils/paymentAllocations';
import { createPaymentLink, emailPaymentLink, expireCheckoutSession, isSessionPaid } from '@/utils/paymentLinkServer';
import { pragueToday } from '@/utils/periodUtils';
import { isLive, nextStep, type BookingFacts } from '@/utils/scheduledPaymentLinks';
import { escapeHtml, sendTelegram } from '@/utils/telegram';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const JOB = 'send-scheduled-payments';
const MAX_FAILURES = 3;

async function run(req: NextRequest) {
  const { isCron } = cronAuth(req, JOB);
  if (!isCron) {
    const guard = await requireAccess('transactions', 'change');
    if ('error' in guard) return guard.error;
  }
  return withCronLock(JOB, maxDuration + 30, () => runLocked());
}

/** Live Beds24 state of one booking, for the send-day checks. */
async function bookingFacts(
  token: string,
  reservationNumber: string,
  payments: AdditionalPayment[],
  ownPaymentId: string | undefined,
): Promise<BookingFacts> {
  const facts: BookingFacts = { reservationNumber, found: false, cancelled: false, price: null, paidCzk: 0 };
  const id = reservationNumber.replace(/^BH-/, '');
  if (!/^\d+$/.test(id)) return facts;
  const res = await fetch(`https://beds24.com/api/v2/bookings?id=${id}`, { headers: { token }, cache: 'no-store' });
  if (!res.ok) throw new Error(`Beds24 ${res.status} for ${reservationNumber}`);
  const json = await res.json();
  const b = (Array.isArray(json?.data) ? json.data[0] : json?.data) ?? null;
  if (!b) return facts;
  const price = Number(b.price);
  // This schedule's own (unpaid) link never counts as "already paid".
  const others = payments.filter((p) => p.id !== ownPaymentId);
  return {
    reservationNumber,
    found: true,
    cancelled: b.status === 'cancelled' || b.status === 'canceled',
    price: Number.isFinite(price) && price > 0 ? price : null,
    paidCzk: Number(b.deposit ?? 0) + netPaidOnBooking(others, reservationNumber),
  };
}

/** Read → change → write the payments list right away (keeps the race window small). */
async function updatePayments(change: (all: AdditionalPayment[]) => AdditionalPayment[]): Promise<void> {
  const all = await readAllAdditionalPayments();
  await writeAllAdditionalPayments(change(all));
}

async function runLocked(): Promise<Response> {
  await beat({ phase: 'started' });
  const today = pragueToday();
  const counts: Record<string, number> = {};
  const errors: { id: string; reason: string }[] = [];

  try {
    const live = (await listScheduledLinks()).filter(isLive);
    const token = live.length > 0 ? await getAccessToken() : '';

    for (const link of live) {
      const now = new Date().toISOString();
      try {
        const payments = await readAllAdditionalPayments();
        const own = link.paymentId ? payments.find((p) => p.id === link.paymentId) : undefined;
        let paid = !!own && wasPaid(own);
        if (!paid && link.paymentId && link.status !== 'scheduled') {
          paid = await isSessionPaid(link.paymentId).catch(() => false); // missed-webhook backstop
        }
        const bookings: BookingFacts[] = [];
        for (const a of link.allocations) bookings.push(await bookingFacts(token, a.reservationNumber, payments, link.paymentId));

        const step = nextStep(link, bookings, paid, today);
        counts[step.kind] = (counts[step.kind] ?? 0) + 1;

        switch (step.kind) {
          case 'wait':
            break;

          case 'mark-paid':
            await saveScheduledLink({ ...link, status: 'paid', failureCount: 0 });
            break;

          case 'send':
          case 'remind': {
            const reminder = step.kind === 'remind';
            if (reminder && link.paymentId) await expireCheckoutSession(link.paymentId);
            const { url, payment } = await createPaymentLink({
              description: link.description,
              allocations: link.allocations,
              guestEmail: link.guestEmail,
              guestPhone: link.guestPhone,
              guestName: link.guestName,
              isMainPayment: link.isMainPayment,
              meta: { scheduledLinkId: link.id, ...(reminder ? { reminder: 'true' } : {}) },
            });
            try {
              await emailPaymentLink({
                to: link.guestEmail,
                guestName: link.guestName,
                description: link.description,
                amountCzk: link.amountCzk,
                url,
                reminder,
              });
            } catch (err) {
              await expireCheckoutSession(payment.id); // nobody has this link — don't leave it payable
              throw err;
            }
            // The fresh link replaces the expired one's unpaid record.
            await updatePayments((all) => [...all.filter((p) => p.id !== link.paymentId || wasPaid(p)), payment]);
            await saveScheduledLink({
              ...link,
              status: reminder ? 'reminded' : 'sent',
              paymentId: payment.id,
              ...(reminder ? { reminderSentAt: now } : { sentAt: now }),
              failureCount: 0,
            });
            break;
          }

          case 'block': {
            // A link already out has expired — drop its unpaid record, the alert takes over.
            if (link.paymentId) await updatePayments((all) => all.filter((p) => p.id !== link.paymentId || wasPaid(p)));
            await saveScheduledLink({ ...link, status: 'blocked', alertReason: step.reason, alertAt: now, failureCount: 0 });
            break;
          }

          case 'overdue': {
            await saveScheduledLink({ ...link, status: 'unpaid', alertReason: step.reason, alertAt: now, failureCount: 0 });
            const ok = await sendTelegram(
              [
                `⚠️ <b>Payment link not paid</b>`,
                `👤 ${escapeHtml(link.guestName || link.guestEmail)}`,
                `🏨 #${link.allocations.map((a) => a.reservationNumber).join(' + #')}`,
                `💰 ${Math.round(link.amountCzk).toLocaleString('cs-CZ')} Kč — ${escapeHtml(link.description)}`,
                `Sent ${link.sentAt?.slice(0, 10)} and reminded ${link.reminderSentAt?.slice(0, 10)}; both links expired unpaid. Follow up with the guest.`,
              ].join('\n'),
            );
            if (!ok) console.error(`[cron/${JOB}] Telegram failed for ${link.id} (in-app alert is set)`);
            break;
          }
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[cron/${JOB}] ${link.id}:`, err);
        errors.push({ id: link.id, reason });
        const failureCount = (link.failureCount ?? 0) + 1;
        await saveScheduledLink({
          ...link,
          failureCount,
          ...(failureCount >= MAX_FAILURES
            ? { status: 'failed' as const, alertReason: `Could not process: ${reason}`, alertAt: now }
            : {}),
        }).catch((e) => console.error(`[cron/${JOB}] could not save failure for ${link.id}:`, e));
      }
    }

    const summary = { phase: 'completed', today, live: live.length, ...counts, errors: errors.length };
    await beat(summary);
    return NextResponse.json({ ok: true, ...summary, ...(errors.length ? { errorDetails: errors } : {}) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[cron/${JOB}]`, err);
    await beat({ phase: 'failed', error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Liveness — see utils/cronHeartbeat.ts. Swallowed so it can never fail the run. */
function beat(summary: Record<string, unknown>): Promise<void> {
  return writeCronHeartbeat(JOB, { ranAt: new Date().toISOString(), summary }).catch((err) =>
    console.error(`[cron/${JOB}] heartbeat write failed:`, err),
  );
}

// Vercel invokes cron paths with GET (see utils/cronAuth).
export const GET = run;
export const POST = run;


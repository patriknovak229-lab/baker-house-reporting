/**
 * Pay-later Telegram lines for the technical chat (sendTechnicalAlert) and the
 * Pending-task texts on the booking. Pure; guest text is always escaped
 * (Telegram HTML mode drops the whole message on a stray "<").
 */
import type { WebPaymentSchedule } from '@/types/webPayment';
import { escapeHtml } from '@/utils/telegram';
import { formatCzk, formatPragueDateTime } from './dates';

type S = Pick<
  WebPaymentSchedule,
  'reservationNumber' | 'arrival' | 'departure' | 'amountMinor' | 'guestName' | 'guestPhone' | 'roomLabel' | 'cardBrand' | 'cardLast4'
>;

const short = (iso: string) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${d}.${m}.`;
};
const head = (s: S) =>
  `${escapeHtml(s.reservationNumber)} · ${escapeHtml(s.roomLabel ?? 'web')} · ${short(s.arrival)}–${short(s.departure)} · ${formatCzk(s.amountMinor)}`;
const guest = (s: S) => `👤 ${escapeHtml(s.guestName)}${s.guestPhone ? ` · 📞 ${escapeHtml(s.guestPhone)}` : ''}`;
const cardOf = (s: S) => (s.cardLast4 ? `${escapeHtml(s.cardBrand ?? 'card')} •••• ${escapeHtml(s.cardLast4)}` : 'card');
const at = (d: Date) => formatPragueDateTime(d, 'cs');

export const msg = {
  registered: (s: S, chargeAt: Date) => `🗓 <b>Pay later</b> ${head(s)}\nCharge ${at(chargeAt)} · ${cardOf(s)}\n${guest(s)}`,
  recovered: (s: S, chargeAt: Date) =>
    `🔧 <b>Pay later recovered from Stripe</b> ${head(s)}\nThe website never registered it; rebuilt from the Stripe customer. Charge ${at(chargeAt)}.`,
  paid: (s: S, via: string) => `✅ <b>Pay later paid</b> ${head(s)} · ${escapeHtml(via)}`,
  declined1: (s: S, code: string, payBy: Date) =>
    `⚠️ <b>Pay later: 1st charge declined</b>\n${head(s)} · ${cardOf(s)} · ${escapeHtml(code)}\nGuest emailed the pay link. 2nd attempt ${at(payBy)}.\n${guest(s)}`,
  declinedManual: (s: S, code: string, by: string) =>
    `⚠️ <b>Pay later: Charge now declined</b> (${escapeHtml(by)})\n${head(s)} · ${cardOf(s)} · ${escapeHtml(code)}\nDoesn't count as a scheduled attempt.`,
  cancelled: (s: S, code: string) =>
    `🚫 <b>Pay later: cancelled for non-payment</b>\n${head(s)}\n2nd charge declined (${escapeHtml(code)}). The dates are free again; the guest was emailed.`,
  decide: (s: S, why: string) =>
    `⏸ <b>Pay later: declined twice, NOT cancelled</b>\n${head(s)}\nReason: ${escapeHtml(why)}. Decide in the drawer: Charge now, send the link, or cancel.\n${guest(s)}`,
  dueManual: (s: S, step: string) =>
    `🔔 <b>Pay later: charge due</b> (${escapeHtml(step)}, manual mode)\n${head(s)}\nUse <b>Charge now</b> in the drawer.`,
  technical: (s: S, what: string, detail: string) =>
    `🛠 <b>Pay later: ${escapeHtml(what)}</b>\n${head(s)}\n${escapeHtml(detail).slice(0, 600)}\nNothing was charged by this error; retried on the next run.`,
  unknownOutcome: (s: S, detail: string) =>
    `🛠 <b>Pay later: no answer from Stripe</b>\n${head(s)}\n${escapeHtml(detail).slice(0, 400)}\nThe next run replays the same request (no double charge possible) and records the real result.`,
  amountMismatch: (s: S, beds24Czk: number) =>
    `⚠️ <b>Pay later: Beds24 price ≠ agreed amount</b>\n${head(s)}\nBeds24 now says ${beds24Czk.toLocaleString('cs-CZ')} Kč. We still charge the agreed ${formatCzk(s.amountMinor)}; change it in the drawer if a new amount was agreed with the guest.`,
  beds24ShowsPaid: (s: S) =>
    `⚠️ <b>Pay later: Beds24 shows the booking paid</b>\n${head(s)}\nWe never took this money, so charging is blocked. Check it, then use "Mark paid another way" or fix Beds24.`,
  datesChanged: (s: S, chargeAt: Date) =>
    `ℹ️ <b>Pay later: dates changed in Beds24</b>\n${head(s)}\nCharge moved to ${at(chargeAt)}. The amount stays as agreed.`,
  bookingCancelled: (s: S) =>
    `ℹ️ <b>Pay later: booking cancelled before the charge</b>\n${head(s)}\nSchedule closed, card removed, nothing charged.`,
  duplicateRefunded: (s: S, paymentIntentId: string, amountMinor: number, why: string) =>
    `↩️ <b>Pay later: second payment refunded automatically</b>\n${head(s)}\n${escapeHtml(paymentIntentId)} · ${formatCzk(amountMinor)} · ${escapeHtml(why)}`,
  duplicateRefundFailed: (s: S, paymentIntentId: string, detail: string) =>
    `🆘 <b>Pay later: a second payment could NOT be refunded</b>\n${head(s)}\n${escapeHtml(paymentIntentId)}: ${escapeHtml(detail).slice(0, 300)}\nRefund it by hand in Stripe.`,
  unregistered: (reservationNumber: string, detail: string) =>
    `❗ <b>Pay later: web booking with no schedule</b>\n${escapeHtml(reservationNumber)}\n${escapeHtml(detail)}\nNo card charge will happen for it — check the booking and Stripe.`,
  modeOff: (count: number, list: string) =>
    `⛔ <b>Pay later is OFF</b> but ${count} payment step(s) are due: ${escapeHtml(list)}.\nSwitch to manual or auto in Transactions → Pay later.`,
  overdue: (list: string) =>
    `⏰ <b>Pay later: steps overdue</b> — the charge job's runs were missed.\n${escapeHtml(list)}\nFiring the job now.`,
  jobCrashed: (detail: string) => `🛠 <b>Pay later job crashed</b>: ${escapeHtml(detail).slice(0, 500)}`,
};

/** Pending-task texts (plain, on the booking). Ids start with `paylater-` so they can be resolved together. */
export const task = {
  declined: (code: string, payBy: Date) => ({
    id: 'paylater-declined',
    text: `Pay later: the card was declined (${code}). The guest was emailed the pay link; the 2nd attempt runs ${formatPragueDateTime(payBy, 'cs')}. Consider phoning the guest.`,
  }),
  decide: (why: string) => ({
    id: 'paylater-decide',
    text: `Pay later: declined twice and NOT cancelled automatically (${why}). In the drawer: Charge now, send the link, or Cancel booking.`,
  }),
  dueManual: (step: string) => ({
    id: `paylater-due-${step}`,
    text: `Pay later: the charge is due (manual mode). Use Charge now in the drawer.`,
  }),
  mismatch: (beds24Czk: number, agreed: string) => ({
    id: 'paylater-amount',
    text: `Pay later: Beds24 price ${beds24Czk.toLocaleString('cs-CZ')} Kč ≠ agreed ${agreed}. The agreed amount will be charged unless you change it in the drawer.`,
  }),
  beds24Paid: () => ({
    id: 'paylater-beds24-paid',
    text: 'Pay later: Beds24 shows this booking paid, but the card was never charged. Charging is blocked until you check it.',
  }),
  technical: (detail: string) => ({
    id: 'paylater-technical',
    text: `Pay later: technical problem (${detail.slice(0, 160)}). Retried automatically; check the drawer if it persists.`,
  }),
  unregistered: () => ({
    id: 'paylater-unregistered',
    text: 'Pay later: this web booking has no payment schedule and no saved card was found. It will NOT be charged — check Stripe and the booking.',
  }),
};

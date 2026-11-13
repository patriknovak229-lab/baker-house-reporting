/**
 * Pay-later guest emails (sent from reservations@ by the charge engine).
 * Czech is the source; English translates it line for line, nothing added.
 * DRAFT wording — Patrik approves before launch. Pure: same input, same HTML.
 */
import type { WebPaymentEmailKind, WebPaymentLang } from '@/types/webPayment';
import { czechGreetingLine } from '@/utils/czechVocative';
import { formatCzk, formatDateLong, formatPragueDateTime, pragueDateOf as dateOf } from '@/utils/webPayments/dates';
import { BODY_FONT_STACK, CURSIVE_FONT_IMPORT, CURSIVE_FONT_STACK, DARK_BROWN, GOLD, LIGHT_BG, MID_BROWN } from './palette';

export interface PayLaterEmailVars {
  lang: WebPaymentLang;
  guestName: string;
  reservationNumber: string;
  arrival: string;
  departure: string;
  amountMinor: number;
  cardBrand: string | null;
  cardLast4: string | null;
  /** 1st charge time (scheduled / reminder). */
  chargeAt: Date;
  /** Last free-cancellation day. */
  deadlineDate: string;
  payUrl: string;
  /** failed: when the 2nd attempt runs (the guest's pay-by time). */
  payBy?: Date;
  /** failed: plain-language decline reason. */
  reason?: string;
  /** receipt: when the money arrived. */
  paidAt?: Date;
  /** scheduled: whether a reminder will follow. */
  reminderPlanned?: boolean;
  /** cancelled: a voucher the guest can use again. */
  voucherRestored?: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function card(v: PayLaterEmailVars): string {
  const brand = v.cardBrand ? v.cardBrand.charAt(0).toUpperCase() + v.cardBrand.slice(1) : v.lang === 'cs' ? 'Karta' : 'Card';
  return v.cardLast4 ? `${brand} •••• ${v.cardLast4}` : brand;
}

function stay(v: PayLaterEmailVars): string {
  return `${formatDateLong(v.arrival, v.lang)} – ${formatDateLong(v.departure, v.lang)}`;
}

function greeting(v: PayLaterEmailVars): string {
  const [first, ...rest] = v.guestName.trim().split(/\s+/);
  if (v.lang === 'cs') return czechGreetingLine(first ?? '', rest.join(' ') || null);
  return first ? `Dear ${first},` : 'Dear guest,';
}

/** Copy per language. Every guest-facing sentence lives here. */
const COPY = {
  cs: {
    scheduledSubject: (v: PayLaterEmailVars) =>
      `Platba za rezervaci ${v.reservationNumber} – naplánována na ${formatDateLong(dateOf(v.chargeAt), 'cs')}`,
    scheduledIntro: 'děkujeme za rezervaci v Baker House Apartments. Vaše rezervace je potvrzená a dnes jsme Vám nic neúčtovali.',
    rowBooking: 'Rezervace',
    rowAmount: 'Částka',
    rowPayment: 'Platba',
    rowPaymentValue: (v: PayLaterEmailVars) => `${formatPragueDateTime(v.chargeAt, 'cs')} strhneme z karty ${card(v)}`,
    rowFreeCancel: 'Zrušení zdarma',
    rowFreeCancelValue: (v: PayLaterEmailVars) => `do 23:59 dne ${formatDateLong(v.deadlineDate, 'cs')}`,
    payNowIntro: 'Pokud chcete zaplatit hned nebo jinou kartou, můžete to udělat zde:',
    payNowCta: 'Zaplatit nyní',
    reminderNote: 'Tři dny před platbou Vám pošleme připomínku.',
    reminderSubject: (v: PayLaterEmailVars) =>
      `Připomínka: platba za rezervaci ${v.reservationNumber} dne ${formatDateLong(dateOf(v.chargeAt), 'cs')}`,
    reminderIntro: (v: PayLaterEmailVars) =>
      `připomínáme, že ${formatPragueDateTime(v.chargeAt, 'cs')} strhneme z Vaší karty ${card(v)} částku ${formatCzk(v.amountMinor)} za rezervaci ${v.reservationNumber} (${stay(v)}).`,
    reminderFreeCancel: (v: PayLaterEmailVars) => `Zrušení zdarma je možné do 23:59 dne ${formatDateLong(v.deadlineDate, 'cs')}.`,
    reminderPayEarly: 'Chcete-li zaplatit dříve nebo jinou kartou, použijte tento odkaz:',
    failedSubject: (v: PayLaterEmailVars) => `Platba za rezervaci ${v.reservationNumber} neprošla – prosíme o úhradu`,
    failedIntro: (v: PayLaterEmailVars) =>
      `platbu ${formatCzk(v.amountMinor)} za rezervaci ${v.reservationNumber} (${stay(v)}) se nám nepodařilo strhnout z karty ${card(v)} (${v.reason ?? 'banka platbu zamítla'}).`,
    failedAsk: (v: PayLaterEmailVars) =>
      `Prosíme, zaplaťte ji do ${formatPragueDateTime(v.payBy ?? v.chargeAt, 'cs')} přes tento odkaz (kartou, Apple Pay nebo Google Pay):`,
    failedPayCta: 'Zaplatit',
    failedNext:
      'Pokud do té doby platba neproběhne, zkusíme kartu strhnout ještě jednou. Pokud se to nepodaří, bude rezervace zrušena bez poplatku.',
    helpLine: 'S čímkoli Vám rádi pomůžeme – stačí odpovědět na tento e-mail.',
    receiptSubject: (v: PayLaterEmailVars) => `Platba přijata – rezervace ${v.reservationNumber}`,
    receiptIntro: (v: PayLaterEmailVars) =>
      `děkujeme, platbu ${formatCzk(v.amountMinor)} za rezervaci ${v.reservationNumber} (${stay(v)}) jsme přijali dne ${formatDateLong(dateOf(v.paidAt ?? v.chargeAt), 'cs')}.`,
    receiptFreeCancel: (v: PayLaterEmailVars) =>
      `Rezervaci můžete i nadále zrušit zdarma do 23:59 dne ${formatDateLong(v.deadlineDate, 'cs')}; platbu Vám pak vrátíme.`,
    receiptOutro: 'Těšíme se na Vás v Baker House Apartments.',
    cancelledSubject: (v: PayLaterEmailVars) => `Rezervace ${v.reservationNumber} byla zrušena – platba neproběhla`,
    cancelledIntro: (v: PayLaterEmailVars) =>
      `platbu za rezervaci ${v.reservationNumber} (${stay(v)}) se nepodařilo provést, a proto jsme rezervaci zrušili. Nic jsme Vám neúčtovali a zrušení je bez poplatku.`,
    cancelledVoucher: (code: string) => `Váš slevový kód ${code} můžete použít znovu.`,
    cancelledRebook:
      'Pokud se u nás chcete ubytovat i tak, rezervujte si prosím pobyt znovu na našem webu nebo odpovězte na tento e-mail – rádi Vám pomůžeme.',
    cancelledCta: 'Rezervovat znovu',
    linkSubject: (v: PayLaterEmailVars) => `Platba za rezervaci ${v.reservationNumber}`,
    linkIntro: (v: PayLaterEmailVars) =>
      `posíláme odkaz k úhradě rezervace ${v.reservationNumber} (${stay(v)}), částka ${formatCzk(v.amountMinor)}:`,
    linkMethods: 'Platit můžete kartou, Apple Pay nebo Google Pay.',
    signOff: 'Patrik & Zuzana',
  },
  en: {
    scheduledSubject: (v: PayLaterEmailVars) =>
      `Payment for booking ${v.reservationNumber} – scheduled for ${formatDateLong(dateOf(v.chargeAt), 'en')}`,
    scheduledIntro: 'thank you for booking with Baker House Apartments. Your booking is confirmed and nothing has been charged today.',
    rowBooking: 'Booking',
    rowAmount: 'Amount',
    rowPayment: 'Payment',
    rowPaymentValue: (v: PayLaterEmailVars) => `we will charge your ${card(v)} on ${formatPragueDateTime(v.chargeAt, 'en')}`,
    rowFreeCancel: 'Free cancellation',
    rowFreeCancelValue: (v: PayLaterEmailVars) => `until 23:59 on ${formatDateLong(v.deadlineDate, 'en')}`,
    payNowIntro: 'If you would like to pay now or with a different card, you can do so here:',
    payNowCta: 'Pay now',
    reminderNote: 'We will send you a reminder three days before the payment.',
    reminderSubject: (v: PayLaterEmailVars) =>
      `Reminder: payment for booking ${v.reservationNumber} on ${formatDateLong(dateOf(v.chargeAt), 'en')}`,
    reminderIntro: (v: PayLaterEmailVars) =>
      `this is a reminder that on ${formatPragueDateTime(v.chargeAt, 'en')} we will charge ${formatCzk(v.amountMinor)} to your ${card(v)} for booking ${v.reservationNumber} (${stay(v)}).`,
    reminderFreeCancel: (v: PayLaterEmailVars) => `Free cancellation is possible until 23:59 on ${formatDateLong(v.deadlineDate, 'en')}.`,
    reminderPayEarly: 'If you would like to pay earlier or with a different card, use this link:',
    failedSubject: (v: PayLaterEmailVars) => `Payment for booking ${v.reservationNumber} did not go through – please pay`,
    failedIntro: (v: PayLaterEmailVars) =>
      `we were unable to charge ${formatCzk(v.amountMinor)} for booking ${v.reservationNumber} (${stay(v)}) to your ${card(v)} (${v.reason ?? 'your bank declined the payment'}).`,
    failedAsk: (v: PayLaterEmailVars) =>
      `Please pay by ${formatPragueDateTime(v.payBy ?? v.chargeAt, 'en')} using this link (card, Apple Pay or Google Pay):`,
    failedPayCta: 'Pay',
    failedNext:
      'If the payment has not been made by then, we will try to charge your card once more. If that fails, the booking will be cancelled free of charge.',
    helpLine: 'We are happy to help with anything – just reply to this email.',
    receiptSubject: (v: PayLaterEmailVars) => `Payment received – booking ${v.reservationNumber}`,
    receiptIntro: (v: PayLaterEmailVars) =>
      `thank you, we received your payment of ${formatCzk(v.amountMinor)} for booking ${v.reservationNumber} (${stay(v)}) on ${formatDateLong(dateOf(v.paidAt ?? v.chargeAt), 'en')}.`,
    receiptFreeCancel: (v: PayLaterEmailVars) =>
      `You can still cancel the booking free of charge until 23:59 on ${formatDateLong(v.deadlineDate, 'en')}; we will then refund the payment.`,
    receiptOutro: 'We look forward to welcoming you at Baker House Apartments.',
    cancelledSubject: (v: PayLaterEmailVars) => `Booking ${v.reservationNumber} has been cancelled – the payment did not go through`,
    cancelledIntro: (v: PayLaterEmailVars) =>
      `we were unable to collect the payment for booking ${v.reservationNumber} (${stay(v)}), so we have cancelled the booking. Nothing has been charged and the cancellation is free of charge.`,
    cancelledVoucher: (code: string) => `You can use your voucher code ${code} again.`,
    cancelledRebook:
      'If you would still like to stay with us, please book again on our website or reply to this email – we are happy to help.',
    cancelledCta: 'Book again',
    linkSubject: (v: PayLaterEmailVars) => `Payment for booking ${v.reservationNumber}`,
    linkIntro: (v: PayLaterEmailVars) =>
      `here is the link to pay for booking ${v.reservationNumber} (${stay(v)}), amount ${formatCzk(v.amountMinor)}:`,
    linkMethods: 'You can pay by card, Apple Pay or Google Pay.',
    signOff: 'Patrik & Zuzana',
  },
};


const p = (text: string) => `<p style="margin:0 0 14px">${esc(text)}</p>`;

function button(href: string, label: string): string {
  return `<p style="margin:6px 0 20px;text-align:center"><a href="${esc(href)}" style="display:inline-block;padding:12px 26px;background:${GOLD};color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;font-size:15px">${esc(label)}</a></p>`;
}

function detailsBox(rows: Array<[string, string]>): string {
  const cells = rows
    .map(
      ([k, val]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:${MID_BROWN};white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:4px 0;color:${DARK_BROWN}">${esc(val)}</td></tr>`,
    )
    .join('');
  return `<div style="background:${LIGHT_BG};border-radius:8px;padding:14px 18px;margin:0 0 18px"><table role="presentation" cellspacing="0" cellpadding="0" border="0" style="font-size:14px">${cells}</table></div>`;
}

function layout(lang: WebPaymentLang, title: string, inner: string, signOff: string): string {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${CURSIVE_FONT_IMPORT}">
</head>
<body style="margin:0;padding:0;background:#fff;font-family:${BODY_FONT_STACK};color:${DARK_BROWN};line-height:1.5">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#fff;padding:24px 0">
    <tr><td align="center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="max-width:560px;width:100%;background:#fff;border:1px solid #eee9e0;border-radius:8px;overflow:hidden">
        <tr><td style="padding:24px 32px 8px;text-align:center;border-bottom:2px solid ${GOLD}">
          <div style="font-family:${CURSIVE_FONT_STACK};font-size:44px;color:${GOLD};line-height:1.1">Baker House Apartments</div>
          <div style="font-size:11px;color:${MID_BROWN};letter-spacing:1.5px;text-transform:uppercase;margin-top:4px">Brno, Czech Republic</div>
        </td></tr>
        <tr><td style="padding:28px 32px 8px;font-size:15px;color:${DARK_BROWN}">
          ${inner}
        </td></tr>
        <tr><td style="padding:0 32px 28px;text-align:center">
          <div style="font-family:${CURSIVE_FONT_STACK};font-size:30px;color:${GOLD};line-height:1.2">${esc(signOff)}</div>
          <div style="font-size:11px;color:${MID_BROWN};margin-top:4px;letter-spacing:0.5px">Baker House Apartments</div>
        </td></tr>
        <tr><td style="padding:14px 32px;border-top:1px solid #f0ebe2;text-align:center;font-size:11px;color:#9a8e80">
          <a href="https://www.bakerhouseapartments.cz" style="color:${GOLD};text-decoration:none">bakerhouseapartments.cz</a>
          &nbsp;·&nbsp; reservations@bakerhouseapartments.cz
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function renderPayLaterEmail(kind: WebPaymentEmailKind, v: PayLaterEmailVars): RenderedEmail {
  const t = COPY[v.lang === 'en' ? 'en' : 'cs'];
  const hello = p(greeting(v));
  const booking = `${v.reservationNumber} · ${stay(v)}`;
  let subject: string;
  let body: string;

  switch (kind) {
    case 'scheduled':
      subject = t.scheduledSubject(v);
      body = [
        hello,
        p(t.scheduledIntro),
        detailsBox([
          [t.rowBooking, booking],
          [t.rowAmount, formatCzk(v.amountMinor)],
          [t.rowPayment, t.rowPaymentValue(v)],
          [t.rowFreeCancel, t.rowFreeCancelValue(v)],
        ]),
        p(t.payNowIntro),
        button(v.payUrl, t.payNowCta),
        v.reminderPlanned ? p(t.reminderNote) : '',
        p(t.helpLine),
      ].join('\n');
      break;
    case 'reminder':
      subject = t.reminderSubject(v);
      body = [hello, p(t.reminderIntro(v)), p(t.reminderFreeCancel(v)), p(t.reminderPayEarly), button(v.payUrl, t.payNowCta), p(t.helpLine)].join('\n');
      break;
    case 'failed':
      subject = t.failedSubject(v);
      body = [hello, p(t.failedIntro(v)), p(t.failedAsk(v)), button(v.payUrl, t.failedPayCta), p(t.failedNext), p(t.helpLine)].join('\n');
      break;
    case 'receipt':
      subject = t.receiptSubject(v);
      body = [hello, p(t.receiptIntro(v)), p(t.receiptFreeCancel(v)), p(t.receiptOutro)].join('\n');
      break;
    case 'cancelled':
      subject = t.cancelledSubject(v);
      body = [
        hello,
        p(t.cancelledIntro(v)),
        v.voucherRestored ? p(t.cancelledVoucher(v.voucherRestored)) : '',
        p(t.cancelledRebook),
        button('https://www.bakerhouseapartments.cz/', t.cancelledCta),
      ].join('\n');
      break;
    case 'link':
      subject = t.linkSubject(v);
      body = [hello, p(t.linkIntro(v)), button(v.payUrl, t.failedPayCta), p(t.linkMethods), p(t.helpLine)].join('\n');
      break;
  }
  return { subject, html: layout(v.lang, subject, body, t.signOff) };
}

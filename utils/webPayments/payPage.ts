/**
 * The small HTML pages a guest can see at /pay/<token> instead of Stripe:
 * already paid, thank you, cancelled, busy, not found, error. Czech source,
 * English line for line. Pure.
 */
import type { WebPaymentSchedule } from '@/types/webPayment';
import { formatCzk, formatDateLong } from './dates';

export type PayPageKind = 'not_found' | 'paid' | 'paid_now' | 'cancelled' | 'busy' | 'error';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const TEXT = {
  cs: {
    not_found: ['Odkaz není platný', 'Tento platební odkaz neznáme. Zkontrolujte prosím odkaz z e-mailu, nebo nám napište.'],
    paid: ['Rezervace je zaplacená', 'Platbu za tuto rezervaci už máme. Není potřeba nic dalšího.'],
    paid_now: ['Děkujeme, platba proběhla', 'Platbu jsme přijali a potvrzení Vám pošleme e-mailem.'],
    cancelled: ['Rezervace byla zrušena', 'Tato rezervace už není aktivní, a proto ji nelze zaplatit. Pokud jde o omyl, napište nám.'],
    busy: ['Platba se právě zpracovává', 'Zkuste to prosím znovu za minutu.'],
    error: ['Platbu se nepodařilo otevřít', 'Zkuste to prosím za chvíli znovu, nebo nám napište – rádi pomůžeme.'],
    booking: 'Rezervace',
    contact: 'Kontakt',
  },
  en: {
    not_found: ['This link is not valid', 'We do not recognise this payment link. Please check the link in your email, or write to us.'],
    paid: ['This booking is paid', 'We already have the payment for this booking. Nothing else is needed.'],
    paid_now: ['Thank you, the payment went through', 'We have received your payment and will send you a confirmation by email.'],
    cancelled: ['This booking has been cancelled', 'This booking is no longer active, so it cannot be paid. If this is a mistake, please write to us.'],
    busy: ['The payment is being processed', 'Please try again in a minute.'],
    error: ['The payment could not be opened', 'Please try again shortly, or write to us – we are happy to help.'],
    booking: 'Booking',
    contact: 'Contact',
  },
} as const;

export function renderPayPage(kind: PayPageKind, row?: WebPaymentSchedule | null): string {
  const lang = row?.lang === 'en' ? 'en' : 'cs';
  const t = TEXT[lang];
  const [title, body] = t[kind];
  const ok = kind === 'paid' || kind === 'paid_now';
  const details = row
    ? `<p class="d">${esc(t.booking)}: ${esc(row.reservationNumber)} · ${esc(formatDateLong(row.arrival, lang))} – ${esc(formatDateLong(row.departure, lang))} · ${esc(formatCzk(row.amountMinor))}</p>`
    : '';
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} — Baker House Apartments</title>
<style>
  body{margin:0;background:#FAF7F2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#3B2F2F;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
  .c{background:#fff;border:1px solid #eee9e0;border-radius:12px;max-width:440px;width:100%;padding:32px 28px;text-align:center}
  .i{width:52px;height:52px;border-radius:50%;margin:0 auto 14px;display:flex;align-items:center;justify-content:center;font-size:26px;background:${ok ? '#e7f4ea' : '#f6efe3'};color:${ok ? '#2f7a45' : '#B08D57'}}
  h1{font-size:20px;margin:0 0 10px}
  p{font-size:15px;line-height:1.5;margin:0 0 10px;color:#5b4d42}
  .d{font-size:13px;color:#8a7c6f}
  .f{margin-top:18px;font-size:12px;color:#9a8e80}
  a{color:#B08D57}
</style>
</head>
<body>
  <div class="c">
    <div class="i">${ok ? '✓' : 'i'}</div>
    <h1>${esc(title)}</h1>
    <p>${esc(body)}</p>
    ${details}
    <p class="f">Baker House Apartments · <a href="https://www.bakerhouseapartments.cz">bakerhouseapartments.cz</a><br>${esc(t.contact)}: reservations@bakerhouseapartments.cz</p>
  </div>
</body>
</html>`;
}

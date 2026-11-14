import { describe, expect, it } from 'vitest';
import { renderPayLaterEmail, type PayLaterEmailVars } from './payLater';

const base: PayLaterEmailVars = {
  lang: 'cs',
  guestName: 'Jana Nováková',
  reservationNumber: 'BH-12345678',
  arrival: '2027-01-12',
  departure: '2027-01-13',
  amountMinor: 211725,
  cardBrand: 'visa',
  cardLast4: '4242',
  chargeAt: new Date('2027-01-03T07:00:00Z'),
  deadlineDate: '2027-01-05',
  payUrl: 'https://reporting.example/pay/token',
  paidAt: new Date('2026-11-14T13:48:41Z'),
};

describe('pay-later receipt email', () => {
  it.each(['cs', 'en'] as const)('%s: ends with the contact line (email + WhatsApp links), never offers cancellation', (lang) => {
    const { html } = renderPayLaterEmail('receipt', { ...base, lang });
    expect(html).toContain('href="mailto:reservations@bakerhouseapartments.cz"');
    expect(html).toContain('href="https://wa.me/420735230711"');
    expect(html).toContain('+420 735 230 711');
    expect(html).not.toMatch(/zrušit zdarma|vrátíme|free of charge|refund/i);
    expect(html).not.toContain('{email}');
    expect(html).not.toContain('{whatsapp}');
  });

  it('keeps the paid amount and the date it arrived', () => {
    const { subject, html } = renderPayLaterEmail('receipt', base);
    expect(subject).toBe('Platba přijata – rezervace BH-12345678');
    expect(html.replace(/ /g, ' ')).toContain('platbu 2 117,25 Kč za rezervaci BH-12345678');
    expect(html).toContain('14. 11. 2026');
  });
});

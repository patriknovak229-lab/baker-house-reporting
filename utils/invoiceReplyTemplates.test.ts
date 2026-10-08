import { describe, expect, it } from 'vitest';
import { invoiceConfirmationTemplate, renderInvoiceConfirmation } from './invoiceReplyTemplates';

describe('invoice confirmation wording', () => {
  it('before checkout: promises the invoice after the checkout date', () => {
    const t = invoiceConfirmationTemplate('Tomas', 'before-checkout');
    expect(t).toContain('after your checkout on {DATE}');
    expect(t).toContain('{EMAIL}');
  });

  it('late request: no date, no promise tied to a past checkout', () => {
    const t = invoiceConfirmationTemplate('Tomas', 'after-checkout');
    expect(t).toContain('We will send the invoice to {EMAIL} shortly.');
    expect(t).not.toContain('{DATE}');
    expect(t).not.toContain('checkout');
  });

  it('never mentions an amount (amounts are the operator\'s call)', () => {
    for (const kind of ['before-checkout', 'after-checkout'] as const) {
      expect(invoiceConfirmationTemplate('Tomas', kind)).not.toMatch(/Kč|CZK|amount|price/i);
    }
  });

  // English skips Google Translate, so the full render runs without network.
  it('renders the late confirmation end to end (en)', async () => {
    const text = await renderInvoiceConfirmation(
      'Tomas',
      'drummaster@seznam.cz',
      '2026-09-30',
      'en',
      'after-checkout',
    );
    expect(text).toContain('Tomas! Thank you, we have everything we need.');
    expect(text).toContain('We will send the invoice to drummaster@seznam.cz shortly.');
    expect(text).not.toContain('{');
    expect(text.endsWith('— Zuzana')).toBe(true);
  });

  it('default kind keeps the original before-checkout behaviour', async () => {
    const text = await renderInvoiceConfirmation('Anna', 'a@b.cz', '2026-10-12', 'en');
    expect(text).toContain('The invoice will be sent to a@b.cz after your checkout on 12 Oct 2026.');
  });
});

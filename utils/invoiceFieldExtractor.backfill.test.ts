import { describe, it, expect, afterEach } from 'vitest';
import { backfillEmailFromText, extractInvoiceFields, type ExtractedInvoiceFields } from './invoiceFieldExtractor';

// The guest's reply to the "we still need your email" ask is often nothing but
// the address. One such reply came back from the model without an email and the
// guest was asked again the next day — so the email must never depend on the
// model alone.

const NOTHING: ExtractedInvoiceFields = {
  companyName: null,
  companyAddress: null,
  ico: null,
  dic: null,
  email: null,
  hasOtherRequests: false,
};

describe('backfillEmailFromText', () => {
  it('reads a reply that is only an email address', () => {
    expect(backfillEmailFromText(NOTHING, 'jan.novak@example.cz').email).toBe('jan.novak@example.cz');
  });

  it('reads an address inside a sentence, without trailing punctuation', () => {
    const text = 'pošlete mi prosím fakturu na email.: fakturace@example.cz, moc děkuji.';
    expect(backfillEmailFromText(NOTHING, text).email).toBe('fakturace@example.cz');
    expect(backfillEmailFromText(NOTHING, 'Můj e-mail je Petr.Svoboda@Example.com.').email).toBe('petr.svoboda@example.com');
  });

  it('skips channel-conduit aliases and takes the next real address', () => {
    const text = 'Booking má 12345.abc@guest.booking.com, ale fakturu na ucetni@example.cz';
    expect(backfillEmailFromText(NOTHING, text).email).toBe('ucetni@example.cz');
    expect(backfillEmailFromText(NOTHING, 'abc@guest.airbnb.com').email).toBeNull();
  });

  it('never overrides an address the model already picked', () => {
    const fromModel = { ...NOTHING, email: 'fakturace@example.cz' };
    expect(backfillEmailFromText(fromModel, 'cc: jiny@example.cz').email).toBe('fakturace@example.cz');
  });

  it('leaves the other fields alone and stays null when there is no address', () => {
    const partial = { ...NOTHING, companyName: 'Acme s.r.o.', dic: 'CZ12345678' };
    expect(backfillEmailFromText(partial, 'jan.novak@example.cz')).toEqual({ ...partial, email: 'jan.novak@example.cz' });
    expect(backfillEmailFromText(NOTHING, 'Fakturu prosím zaslat na e-mail [email removed]').email).toBeNull();
  });
});

describe('extractInvoiceFields without the model', () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it('still returns the email when the model yields nothing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const fields = await extractInvoiceFields('jan.novak@example.cz');
    expect(fields.email).toBe('jan.novak@example.cz');
    expect(fields.companyName).toBeNull();
  });
});

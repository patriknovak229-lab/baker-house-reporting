import { describe, it, expect } from 'vitest';
import {
  canonicalReservationNumber,
  cleanInvoiceData,
  invoiceDeliveryProblem,
  parseNewBookingInvoice,
  scheduledInvoiceTask,
} from './newBookingInvoice';
import type { InvoiceData } from '@/types/reservation';

const TODAY = '2026-10-13';

const company: InvoiceData = {
  companyName: 'Acme s.r.o.',
  companyAddress: 'Šumavská 10, Brno',
  ico: '12345678',
  vatNumber: 'CZ12345678',
  billingEmail: 'billing@acme.cz',
};

describe('invoiceDeliveryProblem', () => {
  it('lets complete company details go out now or on a later date', () => {
    expect(invoiceDeliveryProblem(company, 'now', undefined, TODAY)).toBeNull();
    expect(invoiceDeliveryProblem(company, 'schedule', '2026-11-10', TODAY)).toBeNull();
  });

  it('needs a company name and a real billing address to send', () => {
    expect(invoiceDeliveryProblem({ ...company, companyName: ' ' }, 'now', undefined, TODAY)).toMatch(/company name/);
    expect(invoiceDeliveryProblem({ ...company, billingEmail: '' }, 'now', undefined, TODAY)).toMatch(/billing email is required/);
    expect(invoiceDeliveryProblem({ ...company, billingEmail: 'acme.cz' }, 'now', undefined, TODAY)).toMatch(/not a valid/);
  });

  it('sends a private person now without an IČO, but will not schedule one the cron would skip', () => {
    const person = { ...company, ico: '', vatNumber: '' };
    expect(invoiceDeliveryProblem(person, 'now', undefined, TODAY)).toBeNull();
    expect(invoiceDeliveryProblem(person, 'schedule', '2026-11-10', TODAY)).toMatch(/IČO or DIČ/);
    // A foreign VAT number alone is enough — same rule as the cron.
    expect(invoiceDeliveryProblem({ ...person, vatNumber: 'PL5251985295' }, 'schedule', '2026-11-10', TODAY)).toBeNull();
  });

  it('refuses a schedule for today or earlier — the 09:00 run may already be gone', () => {
    expect(invoiceDeliveryProblem(company, 'schedule', TODAY, TODAY)).toMatch(/after today/);
    expect(invoiceDeliveryProblem(company, 'schedule', '2026-10-01', TODAY)).toMatch(/after today/);
    expect(invoiceDeliveryProblem(company, 'schedule', '', TODAY)).toMatch(/pick the date/);
  });

  it('saves partial details, but not an empty form', () => {
    expect(invoiceDeliveryProblem({ ...cleanInvoiceData({}), ico: '123' }, 'save', undefined, TODAY)).toBeNull();
    expect(invoiceDeliveryProblem(cleanInvoiceData({}), 'save', undefined, TODAY)).toMatch(/at least one/);
  });
});

describe('canonicalReservationNumber', () => {
  it('files a package under its lowest Beds24 id, like the dashboard merge', () => {
    expect(canonicalReservationNumber(['BH-95000012', 'BH-95000010', 'BH-95000011'])).toBe('BH-95000010');
  });

  it('ignores junk and returns null when nothing usable is left', () => {
    expect(canonicalReservationNumber(['x', 5, 'BH-12'])).toBe('BH-12');
    expect(canonicalReservationNumber([])).toBeNull();
    expect(canonicalReservationNumber('BH-1')).toBeNull();
  });
});

describe('scheduledInvoiceTask', () => {
  it('is an open invoice task due on the chosen date, carrying the payment-details choice', () => {
    const t = scheduledInvoiceTask(company, '2026-11-10', true, new Date('2026-10-13T10:00:00Z'));
    expect(t).toMatchObject({
      category: 'invoice',
      actionableDate: '2026-11-10',
      resolved: false,
      includeQR: true,
    });
    expect(t.text).toContain('Acme s.r.o.');
    expect(t.text).toContain('with payment details');
  });

  it('leaves includeQR off the task for a plain invoice (the cron default)', () => {
    const t = scheduledInvoiceTask(company, '2026-11-10', false);
    expect('includeQR' in t).toBe(false);
    expect(t.text).not.toContain('payment details');
  });
});

describe('parseNewBookingInvoice', () => {
  it('accepts a schedule and trims every field', () => {
    const r = parseNewBookingInvoice(
      {
        reservationNumbers: ['BH-2', 'BH-1'],
        invoiceData: { ...company, companyName: '  Acme s.r.o. ' },
        delivery: 'schedule',
        sendDate: '2026-11-10',
        includeQR: true,
      },
      TODAY,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.reservationNumber).toBe('BH-1');
    expect(r.value.invoiceData.companyName).toBe('Acme s.r.o.');
    expect(r.value.sendDate).toBe('2026-11-10');
    expect(r.value.includeQR).toBe(true);
  });

  it('drops a stray sendDate unless scheduling, and treats includeQR as strictly boolean', () => {
    const r = parseNewBookingInvoice(
      { reservationNumbers: ['BH-1'], invoiceData: company, delivery: 'now', sendDate: '2026-11-10', includeQR: 'yes' },
      TODAY,
    );
    expect(r.ok && r.value.sendDate).toBeFalsy();
    expect(r.ok && r.value.includeQR).toBe(false);
  });

  it('rejects an unknown delivery or a missing reservation', () => {
    expect(parseNewBookingInvoice({ reservationNumbers: ['BH-1'], invoiceData: company, delivery: 'later' }, TODAY).ok).toBe(false);
    expect(parseNewBookingInvoice({ invoiceData: company, delivery: 'now' }, TODAY).ok).toBe(false);
    expect(parseNewBookingInvoice(null, TODAY).ok).toBe(false);
  });
});

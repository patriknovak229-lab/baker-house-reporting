import { describe, expect, it } from 'vitest';
import {
  checkInvoice,
  findDuplicateInvoice,
  findOriginalInvoice,
  isValidCzechIco,
  normalizeInvoiceAmounts,
  resolveMissingYear,
  round2,
} from './invoiceChecks';
import { findKnownSupplier } from './supplierRegistry';
import { postProcess } from './invoiceExtraction';

const TODAY = new Date('2026-10-09T12:00:00Z');

describe('round2', () => {
  it('kills float noise', () => {
    expect(round2(2815.6000000000004)).toBe(2815.6);
    expect(round2(10282.029999999999)).toBe(10282.03);
    expect(round2(6025.04812323)).toBe(6025.05);
  });
});

describe('resolveMissingYear', () => {
  it('uses the printed weekday (Action "Středa 19. srpna" = 2026)', () => {
    expect(resolveMissingYear('2024-08-19', 'Wednesday', TODAY)).toBe('2026-08-19');
  });
  it('falls back to the most recent past occurrence without a weekday', () => {
    expect(resolveMissingYear('2025-09-25', null, TODAY)).toBe('2026-09-25');
    expect(resolveMissingYear('2026-12-01', null, TODAY)).toBe('2025-12-01');
  });
});

describe('isValidCzechIco', () => {
  it('validates the mod-11 checksum', () => {
    expect(isValidCzechIco('03439747')).toBe(true); // Action
    expect(isValidCzechIco('27082440')).toBe(true); // Alza
    expect(isValidCzechIco('03439748')).toBe(false);
  });
});

describe('findKnownSupplier', () => {
  it('matches name variants and spaced IČO', () => {
    expect(findKnownSupplier('ACTION', null)?.id).toBe('action');
    expect(findKnownSupplier('ACTION / Action Retail Czech s.r.o.', null)?.id).toBe('action');
    expect(findKnownSupplier(null, '034 39 747')?.id).toBe('action');
    expect(findKnownSupplier('IKEA BRNO', null)?.category).toBe('equipment');
    expect(findKnownSupplier('Makro Cash & Carry', null)?.category).toBe('consumables');
    expect(findKnownSupplier('Google Ireland Limited', null)?.category).toBe('software');
    expect(findKnownSupplier('Penny Market s.r.o.', '64945880')).toBeNull();
  });
});

describe('checkInvoice', () => {
  const action = {
    supplierName: 'Action Retail Czech s.r.o.',
    supplierICO: '03439747',
    invoiceDate: '2026-08-19',
    amount: 2916.2,
    vat: 495.52,
    currency: 'CZK',
    vatBreakdown: [
      { rate: 12, base: 142.5, vat: 17.1 },
      { rate: 21, base: 2278.18, vat: 478.42 },
    ],
  };

  it('passes a consistent mixed-rate receipt', () => {
    expect(checkInvoice(action, TODAY)).toEqual([]);
  });
  it('passes when there is no VAT table but the rate is 21 %', () => {
    expect(checkInvoice({ ...action, vatBreakdown: null, amount: 1210, vat: 210 }, TODAY)).toEqual([]);
  });
  it('flags VAT that is not 12 % or 21 %', () => {
    const issues = checkInvoice({ ...action, vatBreakdown: null, amount: 1300, vat: 300 }, TODAY);
    expect(issues.map((i) => i.field)).toContain('vat');
  });
  it('flags a non-Czech rate and a VAT row that does not compute', () => {
    const issues = checkInvoice({ ...action, vatBreakdown: [{ rate: 15, base: 2535.83, vat: 380.37 }], vat: 380.37 }, TODAY);
    expect(issues.some((i) => i.message.includes('15 %'))).toBe(true);
  });
  it('flags a total that does not equal base + VAT', () => {
    const issues = checkInvoice({ ...action, amount: 3916.2 }, TODAY);
    expect(issues.map((i) => i.field)).toContain('amount');
  });
  it('flags the wrong year (too old) and future dates', () => {
    expect(checkInvoice({ ...action, invoiceDate: '2024-08-19' }, TODAY).map((i) => i.field)).toContain('date');
    expect(checkInvoice({ ...action, invoiceDate: '2026-12-19' }, TODAY).map((i) => i.field)).toContain('date');
  });
  it('flags our own IČO as supplier', () => {
    expect(checkInvoice({ ...action, supplierICO: '19876106' }, TODAY).map((i) => i.field)).toContain('supplier');
  });
  it('requires credit notes to be negative and linked', () => {
    const credit = { ...action, documentType: 'credit_note', vatBreakdown: null, amount: -1210, vat: -210 };
    expect(checkInvoice({ ...credit, hasOriginalInvoice: true }, TODAY)).toEqual([]);
    expect(checkInvoice({ ...credit, hasOriginalInvoice: false }, TODAY).map((i) => i.field)).toEqual(['link']);
    expect(checkInvoice({ ...credit, amount: 1210, hasOriginalInvoice: true }, TODAY).map((i) => i.field)).toContain('amount');
  });
  it('skips the Czech-rate check for foreign currency without VAT', () => {
    expect(checkInvoice({ ...action, currency: 'USD', supplierICO: '41-4535625', vat: 0, vatBreakdown: null, amount: 64.97 }, TODAY)).toEqual([]);
  });
});

describe('normalizeInvoiceAmounts', () => {
  it('rounds and forces credit notes negative', () => {
    expect(normalizeInvoiceAmounts({ amountCZK: 2815.6000000000004, vatAmountCZK: 488.66 })).toEqual({ amountCZK: 2815.6, vatAmountCZK: 488.66 });
    expect(normalizeInvoiceAmounts({ amountCZK: 299, vatAmountCZK: 51.89, documentType: 'credit_note' })).toEqual({ amountCZK: -299, vatAmountCZK: -51.89, documentType: 'credit_note' });
  });
});

describe('findDuplicateInvoice / findOriginalInvoice', () => {
  const saved = [
    { id: 'a', supplierName: 'Action Retail Czech s.r.o.', supplierICO: '03439747', invoiceNumber: 'INV-ACTIONRETAIL-1908', invoiceDate: '2026-08-19', amountCZK: 2916.2 },
    { id: 'b', supplierName: 'Alza.cz a.s.', supplierICO: '27082440', invoiceNumber: '4024458200', invoiceDate: '2026-07-04', amountCZK: 8912 },
    { id: 'c', supplierName: 'Alza.cz a.s.', supplierICO: '27082440', invoiceNumber: '6100000001', invoiceDate: '2026-07-10', amountCZK: -299, documentType: 'credit_note' },
  ];
  it('catches a re-import with a different number by date + amount', () => {
    const dup = findDuplicateInvoice({ id: 'x', supplierName: 'Action Retail Czech s.r.o.', supplierICO: '03439747', invoiceNumber: 'B08010210241953', invoiceDate: '2026-08-19', amountCZK: 2916.2 }, saved);
    expect(dup?.id).toBe('a');
  });
  it('does not merge two same-amount credit notes', () => {
    const dup = findDuplicateInvoice({ id: 'x', supplierName: 'Alza.cz a.s.', supplierICO: '27082440', invoiceNumber: '6100000002', invoiceDate: '2026-07-10', amountCZK: -299, documentType: 'credit_note' }, saved);
    expect(dup).toBeNull();
  });
  it('finds the original invoice of a credit note', () => {
    expect(findOriginalInvoice('Alza.cz a.s.', null, '4024458200', saved)?.id).toBe('b');
    expect(findOriginalInvoice('Alza.cz a.s.', null, '6100000001', saved)).toBeNull(); // never another credit note
  });
});

describe('postProcess', () => {
  const categories = [
    { id: 'consumables', label: 'Consumables', color: '' },
    { id: 'equipment', label: 'Equipment', color: '' },
    { id: 'other', label: 'Other', color: '' },
  ];
  const base = {
    documentType: 'receipt' as const,
    supplierName: 'ACTION',
    supplierICO: '034 39 747',
    invoiceNumber: ' B08010210241953 ',
    originalInvoiceNumber: null,
    invoiceDate: '2024-08-19',
    invoiceDateHasYear: false,
    invoiceWeekday: 'Wednesday',
    duzpDate: null,
    dueDate: null,
    currency: 'czk',
    totalAmount: 2916.2000000001,
    vatAmount: 495.52,
    vatBreakdown: [],
    suggestedCategory: 'other',
    lineItems: [{ description: 'towel', amount: 299.6 }],
  };

  it('canonicalises a known supplier, fixes the year and ignores receipt line items', () => {
    const r = postProcess(base, categories, TODAY);
    expect(r).toMatchObject({
      supplierName: 'Action Retail Czech s.r.o.',
      supplierICO: '03439747',
      invoiceNumber: 'B08010210241953',
      invoiceDate: '2026-08-19',
      amountCZK: 2916.2,
      invoiceCurrency: 'CZK',
      suggestedCategory: 'consumables',
      documentType: 'invoice',
      lineItems: null,
      knownSupplierId: 'action',
    });
  });
  it('makes credit notes negative and keeps the original number', () => {
    const r = postProcess({ ...base, supplierName: 'Alza.cz a.s.', supplierICO: '27082440', documentType: 'credit_note', invoiceDateHasYear: true, invoiceDate: '2026-07-10', totalAmount: 299, vatAmount: 51.89, originalInvoiceNumber: '4024458200' }, categories, TODAY);
    expect(r).toMatchObject({ amountCZK: -299, vatAmountCZK: -51.89, documentType: 'credit_note', originalInvoiceNumber: '4024458200' });
  });
  it('sums line items only for fee statements', () => {
    const r = postProcess({ ...base, supplierName: 'Airbnb Ireland UC', supplierICO: null, documentType: 'fee_statement', invoiceDateHasYear: true, totalAmount: 999, lineItems: [{ description: 'A', amount: 100.105 }, { description: 'B', amount: 200.2 }] }, categories, TODAY);
    expect(r.amountCZK).toBe(300.31);
    expect(r.lineItems).toHaveLength(2);
  });
});

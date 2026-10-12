import { describe, it, expect } from 'vitest';
import { classifySupplier } from './classify';

const c = (supplierName: string, supplierIco: string | null, currency = 'CZK', settlementGroupId: string | null = null) =>
  classifySupplier({ supplierName, supplierIco, currency, settlementGroupId });

describe('vat/classify', () => {
  it('recognises OTA fee records and stray OTA invoices', () => {
    expect(c('Booking.com B.V.', null, 'CZK', 'g1')).toEqual({ cls: 'ota_settlement' });
    expect(c('Airbnb', null)).toEqual({ cls: 'ota_legacy' });
    expect(c('Some name', 'NL805734958B01')).toEqual({ cls: 'ota_legacy' });
  });

  it('keeps marketplaces out', () => {
    expect(c('Temu', null).cls).toBe('marketplace');
  });

  it('classifies Czech suppliers by IČO / CZ DIČ', () => {
    expect(c('Alza.cz a.s.', '27082440')).toEqual({ cls: 'domestic', ico: '27082440' });
    expect(c('Alza.cz a.s.', 'CZ27082440')).toEqual({ cls: 'domestic', ico: '27082440' });
  });

  it('classifies EU and non-EU suppliers', () => {
    expect(c('Anthropic, PBC', 'IE4276970QH', 'USD')).toMatchObject({ cls: 'foreign', eu: true, countryCode: 'IE', vatId: '4276970QH' });
    expect(c('Some GmbH', 'DE 814 529 349')).toMatchObject({ cls: 'foreign', eu: true, countryCode: 'DE', vatId: '814529349' });
    expect(c('Greek Co', 'GR123456789')).toMatchObject({ cls: 'foreign', countryCode: 'EL' });
    expect(c('Vercel Inc.', 'EU056329113', 'USD')).toMatchObject({ cls: 'foreign', eu: false });
    expect(c('PriceLabs Revenue Inc.', '41-4535625', 'USD')).toMatchObject({ cls: 'foreign', eu: false, vatId: null });
    expect(c('Unknown US Inc', '98-7654321', 'USD')).toMatchObject({ cls: 'foreign', eu: false });
  });

  it('fixes known vendors with inconsistent stored ids', () => {
    expect(c('Google Cloud EMEA Limited', 'IE66988070')).toMatchObject({ countryCode: 'IE', vatId: '3668997OH', idSource: 'known' });
    expect(c('ARTGEIST SPÓŁKA Z O.O.', '7262622485')).toMatchObject({ countryCode: 'PL', vatId: '7262622485', eu: true });
  });

  it('falls back sensibly', () => {
    expect(c('Mystery Ltd', null, 'GBP')).toMatchObject({ cls: 'foreign', eu: false, idSource: 'none' });
    expect(c('Some shop', null)).toEqual({ cls: 'unknown' });
  });
});

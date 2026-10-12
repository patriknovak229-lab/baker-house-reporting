import { describe, it, expect } from 'vitest';
import { lookupRate, parseYearTable } from './cnb';

const Y2026 = [
  'Datum|1 EUR|100 JPY|1 USD',
  '30.12.2026|24,100|13,500|20,900',
  '31.12.2026|24,120|13,510|20,950',
].join('\n');
const Y2027 = [
  'Datum|1 EUR|100 JPY|1 USD',
  '04.01.2027|24,250|13,141|21,303',
  '05.01.2027|24,170|13,226||',
  '08.01.2027|24,210|13,300|21,076',
].join('\n');

describe('vat/cnb', () => {
  const t26 = parseYearTable(2026, Y2026);
  const t27 = parseYearTable(2027, Y2027);

  it('parses the yearly file including per-100 units and empty cells', () => {
    expect(t27.dates).toEqual(['2027-01-04', '2027-01-05', '2027-01-08']);
    expect(t27.rates.get('2027-01-04')?.get('EUR')).toEqual({ rateMilli: 24250, unit: 1 });
    expect(t27.rates.get('2027-01-04')?.get('JPY')).toEqual({ rateMilli: 13141, unit: 100 });
    expect(t27.rates.get('2027-01-05')?.has('USD')).toBe(false);
  });

  it('uses the last fixing on or before the date', () => {
    expect(lookupRate([t26, t27], 'EUR', '2027-01-04')).toEqual({ rateMilli: 24250, unit: 1, fixingDate: '2027-01-04' });
    expect(lookupRate([t26, t27], 'EUR', '2027-01-07')?.fixingDate).toBe('2027-01-05');
    // USD has no value on 5 Jan → falls back to 4 Jan
    expect(lookupRate([t26, t27], 'USD', '2027-01-06')?.fixingDate).toBe('2027-01-04');
    // New Year's Day: previous year's last fixing
    expect(lookupRate([t26, t27], 'EUR', '2027-01-01')).toEqual({ rateMilli: 24120, unit: 1, fixingDate: '2026-12-31' });
    expect(lookupRate([t27], 'GBP', '2027-01-08')).toBeNull();
  });
});

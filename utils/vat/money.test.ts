import { describe, it, expect } from 'vitest';
import { formatHal, fxToHal, halToDecimal, roundDiv, roundHalfAway, splitGross, toHal, toWholeCzk, vatOnBase } from './money';

describe('vat/money', () => {
  it('parses stored amounts into integer haléře without float drift', () => {
    expect(toHal(3174.4)).toBe(317440);
    expect(toHal('63312.29')).toBe(6331229);
    expect(toHal('1 234,56')).toBe(123456);
    expect(toHal(-260.16)).toBe(-26016);
    expect(toHal(0.1 + 0.2)).toBe(30);
    expect(toHal(null)).toBe(0);
    expect(() => toHal('abc')).toThrow();
  });

  it('rounds half away from zero', () => {
    expect(roundHalfAway(2.5)).toBe(3);
    expect(roundHalfAway(-2.5)).toBe(-3);
    expect(roundHalfAway(2.4999999999)).toBe(3); // binary noise treated as .5
    expect(roundDiv(7, 2)).toBe(4);
    expect(roundDiv(-7, 2)).toBe(-4);
    expect(roundDiv(5, 3)).toBe(2);
    expect(() => roundDiv(1.5, 2)).toThrow();
  });

  it('splits a VAT-inclusive amount so base + VAT = gross exactly', () => {
    // 401 274,65 Kč at 12 % (the July 2026 mock)
    expect(splitGross(40127465, 12)).toEqual({ base: 35828094, vat: 4299371 });
    expect(splitGross(121000, 21)).toEqual({ base: 100000, vat: 21000 });
    const neg = splitGross(-50000, 12);
    expect(neg.base + neg.vat).toBe(-50000);
    expect(neg.base).toBe(-44643);
  });

  it('computes VAT on a base and converts currencies at ČNB rates', () => {
    expect(vatOnBase(6331229, 21)).toBe(1329558);   // 13 295,58
    expect(fxToHal(5935, 24250)).toBe(143924);      // 59,35 EUR × 24,250
    expect(fxToHal(7996, 21171)).toBe(169283);      // 79,96 USD × 21,171
    expect(fxToHal(10000, 13141, 100)).toBe(1314);  // 100 JPY quoted per 100 units
  });

  it('formats for XML, CSV and the UI', () => {
    expect(halToDecimal(1234567)).toBe('12345.67');
    expect(halToDecimal(-5)).toBe('-0.05');
    expect(halToDecimal(0)).toBe('0.00');
    expect(toWholeCzk(1105569)).toBe(11056);
    expect(toWholeCzk(-150)).toBe(-2);
    expect(formatHal(123456789)).toBe('1 234 567,89');
    expect(formatHal(-26016)).toBe('−260,16');
    expect(formatHal(1157947, { decimals: 0 })).toBe('11 579');
  });
});

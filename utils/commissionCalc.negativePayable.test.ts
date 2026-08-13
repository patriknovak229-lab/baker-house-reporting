import { describe, it, expect } from 'vitest';
import { negativePayableWarning } from './commissionCalc';

/**
 * Guards the owner-settlement path. payableToOwner is grossProfit × 0.75, so a
 * month with no reservations but real costs renders as the owner OWING us 75% of
 * those costs — and issued settlements are final, so it must never be issued by
 * accident. The warning must fire for that case without blocking a genuinely
 * loss-making month.
 */
describe('negativePayableWarning', () => {
  const healthy = { netSales: 40000, operationalCosts: 12000, payableToOwner: 21000 };

  it('stays silent on a normal profitable month', () => {
    expect(negativePayableWarning(healthy)).toBeNull();
  });

  it('stays silent on an exactly-break-even month', () => {
    expect(negativePayableWarning({ netSales: 12000, operationalCosts: 12000, payableToOwner: 0 })).toBeNull();
  });

  it('fires on the dangerous case: no net sales but real costs', () => {
    const w = negativePayableWarning({ netSales: 0, operationalCosts: 8400, payableToOwner: -6300 });
    expect(w?.code).toBe('negative-payable');
    expect(w?.zeroSales).toBe(true);
    // Must name the likely cause so the operator checks the sync, not the maths.
    expect(w?.message).toMatch(/no reservations/i);
    expect(w?.message).toMatch(/final/i);
  });

  it('fires on a genuinely loss-making month, but without blaming the sync', () => {
    const w = negativePayableWarning({ netSales: 5000, operationalCosts: 9000, payableToOwner: -3000 });
    expect(w?.code).toBe('negative-payable');
    expect(w?.zeroSales).toBe(false);
    expect(w?.message).not.toMatch(/no reservations/i);
  });

  it('treats a missing payable as nothing to warn about, not as negative', () => {
    // A malformed body must not be turned into a scary warning by coercion.
    expect(negativePayableWarning({})).toBeNull();
    expect(negativePayableWarning({ netSales: 0, operationalCosts: 0 })).toBeNull();
  });

  it('reports the amounts it is warning about', () => {
    const w = negativePayableWarning({ netSales: 0, operationalCosts: 8400, payableToOwner: -6300 });
    // cs-CZ uses a non-breaking space (U+00A0) as the thousands separator — written
    // as an escape so this assertion doesn't hinge on invisible characters.
    const plain = w!.message.replace(/\u00a0/g, ' ');
    expect(plain).toContain('8 400 Kč');
    expect(plain).toContain('-6 300 Kč');
  });
});

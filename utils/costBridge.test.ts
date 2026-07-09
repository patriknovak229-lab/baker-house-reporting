import { describe, it, expect } from 'vitest';
import { classifyCost, CAPITALIZATION_THRESHOLD } from './costBridge';

describe('classifyCost — cost bridge', () => {
  it('maps known categories to line A with the correct ledger account', () => {
    expect(classifyCost('cleaning', 5000)).toMatchObject({ account: '518', line: 'A', capitalized: false, unknownCategory: false });
    expect(classifyCost('laundry', 5000)).toMatchObject({ account: '518', line: 'A' });
    expect(classifyCost('services', 5000)).toMatchObject({ account: '518', line: 'A' });
    expect(classifyCost('software', 500)).toMatchObject({ account: '518', line: 'A' });
    expect(classifyCost('distribution-fees', 10000)).toMatchObject({ account: '518', line: 'A' });
    expect(classifyCost('consumables', 2000)).toMatchObject({ account: '501', line: 'A' });
    expect(classifyCost('equipment', 2000)).toMatchObject({ account: '501', line: 'A' });
    expect(classifyCost('other', 2000)).toMatchObject({ account: '501', line: 'A' });
    expect(classifyCost('maintenance', 2000)).toMatchObject({ account: '511', line: 'A' });
    expect(classifyCost('utilities', 1000)).toMatchObject({ account: '502', line: 'A' });
  });

  it('capitalizes an equipment/other item >= 80000 to asset 022 on line E (not A)', () => {
    expect(classifyCost('equipment', CAPITALIZATION_THRESHOLD)).toMatchObject({ account: '022', line: 'E', capitalized: true });
    expect(classifyCost('other', 95000)).toMatchObject({ account: '022', line: 'E', capitalized: true });
  });

  it('keeps items just below the threshold as an expense on line A', () => {
    expect(classifyCost('equipment', CAPITALIZATION_THRESHOLD - 1)).toMatchObject({ account: '501', line: 'A', capitalized: false });
  });

  it('does NOT capitalize non-capitalizable categories even above the threshold', () => {
    expect(classifyCost('distribution-fees', 200000)).toMatchObject({ account: '518', line: 'A', capitalized: false });
    expect(classifyCost('cleaning', 90000)).toMatchObject({ account: '518', line: 'A', capitalized: false });
  });

  it('falls back to 548 / line F for categories not in the bridge', () => {
    expect(classifyCost('mystery-category', 500)).toMatchObject({ account: '548', line: 'F', unknownCategory: true });
  });
});

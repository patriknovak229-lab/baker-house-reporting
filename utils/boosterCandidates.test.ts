import { describe, it, expect } from 'vitest';
import {
  WATCH_BAND,
  boostedSellChance,
  boosterVerdict,
  breakEvenLift,
  breakEvenSellChance,
  expectedBoostGain,
  marginsPerKc,
  openGaps,
  openRuns,
  rollUpDateVerdict,
  sellChanceCurve,
  type BoosterEconomics,
  type BoosterUnitNight,
  type VerdictInput,
} from './boosterCandidates';

// The measured economics from the 2026-11-13 analysis.
const ECON: BoosterEconomics = {
  baseCommission: 0.193,
  boostedCommission: 0.2615,
  variableCostShareOfNet: 0.15,
  assumedDemandUplift: 0.2,
  bookingPriceFactor: 0.9,
};

describe('margins and break-even lift', () => {
  it('keeps variable cost at the unboosted level', () => {
    const m = marginsPerKc(ECON);
    expect(m.plain).toBeCloseTo(0.807 * 0.85, 6);
    expect(m.boosted).toBeCloseTo(0.7385 - 0.15 * 0.807, 6);
  });

  it('needs about 11 % more bookings at 19.3 % → 26.15 %', () => {
    expect(breakEvenLift(ECON)).toBeCloseTo(0.111, 3);
  });

  it('needs nothing when the boost costs nothing', () => {
    expect(breakEvenLift({ ...ECON, boostedCommission: ECON.baseCommission })).toBeCloseTo(0, 9);
  });
});

describe('boostedSellChance (Poisson uplift)', () => {
  it('leaves certain and hopeless nights alone', () => {
    expect(boostedSellChance(1, 0.2)).toBe(1);
    expect(boostedSellChance(0, 0.2)).toBe(0);
  });

  it('lifts a quiet night by almost the full uplift and a busy one barely', () => {
    expect(boostedSellChance(0.05, 0.2) / 0.05).toBeGreaterThan(1.19);
    // 1 − 0.1^1.2 = 0.937 → +4 %, well under the +11 % a boosted date needs.
    expect(boostedSellChance(0.9, 0.2) / 0.9).toBeLessThan(1.05);
  });
});

describe('breakEvenSellChance', () => {
  it('is where the boosted gain ratio meets the break-even ratio', () => {
    const q = breakEvenSellChance(ECON);
    expect(q).toBeGreaterThan(0.55);
    expect(q).toBeLessThan(0.65);
    expect(boostedSellChance(q, ECON.assumedDemandUplift) / q).toBeCloseTo(1 + breakEvenLift(ECON), 6);
  });

  it('rises when the booster is assumed to work harder', () => {
    expect(breakEvenSellChance({ ...ECON, assumedDemandUplift: 0.5 })).toBeGreaterThan(breakEvenSellChance(ECON));
  });

  it('is 0 when the uplift cannot even cover the extra commission', () => {
    expect(breakEvenSellChance({ ...ECON, assumedDemandUplift: 0.1 })).toBe(0);
  });
});

describe('expectedBoostGain', () => {
  it('is about zero at the break-even chance, positive below, negative above', () => {
    const q = breakEvenSellChance(ECON);
    expect(Math.abs(expectedBoostGain(1, 3000, q, ECON))).toBeLessThan(0.01);
    expect(expectedBoostGain(1, 3000, 0.3, ECON)).toBeGreaterThan(0);
    expect(expectedBoostGain(1, 3000, 0.9, ECON)).toBeLessThan(0);
  });

  it('scales with open rooms', () => {
    expect(expectedBoostGain(3, 2000, 0.3, ECON)).toBeCloseTo(3 * expectedBoostGain(1, 2000, 0.3, ECON), 6);
  });
});

describe('sellChanceCurve', () => {
  it('accumulates sales booked at or inside each lead against empty nights', () => {
    // 2 nights sold same-day, 1 at lead 1, 3 at lead 2+, 4 never sold.
    expect(sellChanceCurve([2, 1, 3], 4)).toEqual([2 / 6, 3 / 7, 6 / 10]);
  });

  it('returns null where there is nothing to learn from', () => {
    expect(sellChanceCurve([0, 0], 0)).toEqual([null, null]);
  });
});

describe('openRuns', () => {
  it('counts consecutive open nights from each date', () => {
    expect(openRuns([1, 2, 0, 1, 1])).toEqual([2, 1, 0, 2, 1]);
  });
});

describe('openGaps', () => {
  it('gives every night the length of the whole open stretch it sits in', () => {
    expect(openGaps([1, 2, 0, 1, 0, 1, 1, 1])).toEqual([2, 2, 0, 1, 0, 3, 3, 3]);
  });

  it('is 0 for sold-out nights and handles an all-open series', () => {
    expect(openGaps([0, 0])).toEqual([0, 0]);
    expect(openGaps([1, 1, 1])).toEqual([3, 3, 3]);
  });
});

describe('rollUpDateVerdict', () => {
  const unit = (verdict: BoosterUnitNight['verdict']): BoosterUnitNight => ({
    unitId: 'u',
    label: 'U',
    openRooms: 1,
    capacity: 1,
    sellChance: 0.5,
    boostedSellChance: 0.56,
    openRunNights: 2,
    openGapNights: 2,
    minStay: 1,
    livePrice: 3000,
    position: 'p50-75',
    expectedGain: 0,
    verdict,
  });

  it('boosts only when a unit says boost and the date gains overall', () => {
    expect(rollUpDateVerdict([unit('boost'), unit('sells-anyway')], 50)).toBe('boost');
    expect(rollUpDateVerdict([unit('boost'), unit('sells-anyway')], -50)).toBe('sells-anyway');
  });

  it('otherwise shows the most actionable verdict', () => {
    expect(rollUpDateVerdict([unit('watch'), unit('fix-min-stay')], 0)).toBe('fix-min-stay');
    expect(rollUpDateVerdict([unit('sells-anyway'), unit('check-price')], 0)).toBe('check-price');
  });
});

describe('boosterVerdict (operator rules, 2026-11-14)', () => {
  // A quiet, bookable, fairly priced night — the textbook boost.
  const base: VerdictInput = {
    daysOut: 3,
    sellChance: 0.3,
    breakEvenSellChance: 0.6,
    cityDemand: 'normal',
    openGapNights: 3,
    minStay: 2,
    position: 'p50-75',
  };
  const verdict = (patch: Partial<VerdictInput>) => boosterVerdict({ ...base, ...patch });

  it('boosts a quiet night', () => {
    expect(verdict({})).toBe('boost');
  });

  it('asks to fix the min stay first — no booking fits a gap shorter than it', () => {
    expect(verdict({ openGapNights: 1, minStay: 2, cityDemand: 'high', position: 'above-p90' })).toBe('fix-min-stay');
    expect(verdict({ openGapNights: 2, minStay: 2 })).toBe('boost');
    expect(verdict({ openGapNights: 1, minStay: null })).toBe('boost');
  });

  it('trusts PriceLabs on good/high-demand dates, even when history says quiet', () => {
    expect(verdict({ cityDemand: 'good' })).toBe('sells-anyway');
    expect(verdict({ cityDemand: 'high', position: 'above-p90' })).toBe('sells-anyway');
  });

  it('flags the price on normal/low dates above the market p90', () => {
    expect(verdict({ position: 'above-p90' })).toBe('check-price');
    expect(verdict({ position: 'above-p90', cityDemand: 'low' })).toBe('check-price');
    expect(verdict({ position: 'p75-90' })).toBe('boost');
  });

  it('watches when there is no history', () => {
    expect(verdict({ sellChance: null })).toBe('watch');
  });

  it('uses a ±10-point band around break-even: boost < 50 %, watch 50–70 %, sells anyway > 70 %', () => {
    expect(WATCH_BAND).toBe(0.1);
    expect(verdict({ sellChance: 0.49 })).toBe('boost');
    expect(verdict({ sellChance: 0.5 })).toBe('watch');
    expect(verdict({ sellChance: 0.6 })).toBe('watch');
    expect(verdict({ sellChance: 0.7 })).toBe('watch');
    expect(verdict({ sellChance: 0.71 })).toBe('sells-anyway');
  });

  it('moves the band with the break-even chance', () => {
    expect(verdict({ sellChance: 0.55, breakEvenSellChance: 0.7 })).toBe('boost');
  });
});

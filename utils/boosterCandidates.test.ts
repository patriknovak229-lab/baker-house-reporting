import { describe, it, expect } from 'vitest';
import {
  CLOSE_IN_DAYS,
  WATCH_BAND,
  boostedSellChance,
  boosterVerdict,
  breakEvenLift,
  breakEvenSellChance,
  expectedBoostGain,
  isIsoDate,
  marginsPerKc,
  openGaps,
  openRuns,
  rollUpDateVerdict,
  sellChanceCurve,
  type BoosterEconomics,
  type BoosterUnitNight,
  type VerdictInput,
} from './boosterCandidates';

// The measured economics (2026-11-13) with Patrik's fill assumption (2026-11-17).
const ECON: BoosterEconomics = {
  baseCommission: 0.193,
  boostedCommission: 0.2615,
  boostLevel: 25,
  variableCostShareOfNet: 0.15,
  fillAtBoost: 0.85,
  bookingPriceFactor: 0.9,
};

describe('margins and break-even lift', () => {
  it('keeps variable cost at the unboosted level', () => {
    const m = marginsPerKc(ECON);
    expect(m.plain).toBeCloseTo(0.807 * 0.85, 6);
    expect(m.boosted).toBeCloseTo(0.7385 - 0.15 * 0.807, 6);
  });

  it('needs about 11 % more sales at 19.3 % → 26.15 %', () => {
    expect(breakEvenLift(ECON)).toBeCloseTo(0.111, 3);
  });
});

describe('fill model', () => {
  it('lifts an open night to the boosted fill chance, never lowers it', () => {
    expect(boostedSellChance(0.3, 0.85)).toBe(0.85);
    expect(boostedSellChance(0.9, 0.85)).toBe(0.9);
  });

  it('breaks even at fill × boosted/plain margin — about 77 % for an 85 % fill', () => {
    const q = breakEvenSellChance(ECON);
    const m = marginsPerKc(ECON);
    expect(q).toBeCloseTo((0.85 * m.boosted) / m.plain, 9);
    expect(q).toBeCloseTo(0.765, 2);
  });

  it('moves with the fill assumption (0.9 × fill)', () => {
    expect(breakEvenSellChance({ ...ECON, fillAtBoost: 1 })).toBeCloseTo(0.9, 2);
    expect(breakEvenSellChance({ ...ECON, fillAtBoost: 0.7 })).toBeCloseTo(0.63, 2);
  });
});

describe('expectedBoostGain', () => {
  it('is about zero at the break-even chance, positive below, negative above', () => {
    const q = breakEvenSellChance(ECON);
    expect(Math.abs(expectedBoostGain(1, 3000, q, ECON))).toBeLessThan(0.01);
    expect(expectedBoostGain(1, 3000, 0.5, ECON)).toBeGreaterThan(0);
    expect(expectedBoostGain(1, 3000, 0.9, ECON)).toBeLessThan(0);
  });

  it('prices K.201 on 20 Nov (61 %, live 6 912) at roughly +700 Kč a night', () => {
    // 6 912 × 0.9 × (0.85 × 0.6175 − 0.61 × 0.686) ≈ 662
    expect(expectedBoostGain(1, 6912, 0.61, ECON)).toBeGreaterThan(600);
    expect(expectedBoostGain(1, 6912, 0.61, ECON)).toBeLessThan(720);
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

describe('openRuns / openGaps', () => {
  it('counts consecutive open nights from each date', () => {
    expect(openRuns([1, 2, 0, 1, 1])).toEqual([2, 1, 0, 2, 1]);
  });

  it('gives every night the length of the whole open stretch it sits in', () => {
    expect(openGaps([1, 2, 0, 1, 0, 1, 1, 1])).toEqual([2, 2, 0, 1, 0, 3, 3, 3]);
    expect(openGaps([0, 0])).toEqual([0, 0]);
  });
});

describe('boosterVerdict (operator rules, revised 2026-11-17)', () => {
  // A quiet, bookable, fairly priced first night of a gap, 2 days out.
  const base: VerdictInput = {
    daysOut: 2,
    sellChance: 0.5,
    breakEvenSellChance: 0.765,
    cityDemand: 'normal',
    openGapNights: 3,
    gapStart: true,
    minStay: 2,
    position: 'p50-75',
  };
  const verdict = (patch: Partial<VerdictInput>) => boosterVerdict({ ...base, ...patch });

  it('boosts a quiet first night', () => {
    expect(verdict({})).toBe('boost');
  });

  it('asks to fix the min stay first — no booking fits a gap shorter than it', () => {
    expect(verdict({ openGapNights: 1, minStay: 2, cityDemand: 'high', position: 'above-p90' })).toBe('fix-min-stay');
    expect(verdict({ openGapNights: 2, minStay: 2 })).toBe('boost');
  });

  it('trusts PriceLabs on good/high demand until the night is still open 3 days out', () => {
    expect(CLOSE_IN_DAYS).toBe(3);
    expect(verdict({ cityDemand: 'high', daysOut: 4 })).toBe('sells-anyway');
    expect(verdict({ cityDemand: 'good', daysOut: 10, sellChance: 0.2 })).toBe('sells-anyway');
    expect(verdict({ cityDemand: 'high', daysOut: 3 })).toBe('boost');
    expect(verdict({ cityDemand: 'good', daysOut: 0, sellChance: 0.9 })).toBe('sells-anyway');
  });

  it('flags the price only on normal/low dates — strong dates are priced high on purpose', () => {
    expect(verdict({ position: 'above-p90' })).toBe('check-price');
    expect(verdict({ position: 'above-p90', cityDemand: 'low', daysOut: 9 })).toBe('check-price');
    // K.201 20 Nov: Good demand, 3 days out, above p90, 61 % → boost.
    expect(verdict({ position: 'above-p90', cityDemand: 'good', daysOut: 3, sellChance: 0.61 })).toBe('boost');
  });

  it('watches when there is no history', () => {
    expect(verdict({ sellChance: null })).toBe('watch');
  });

  it('uses a ±10-point band around break-even: boost < ~67 %, watch to ~87 %, then sells anyway', () => {
    expect(WATCH_BAND).toBe(0.1);
    expect(verdict({ sellChance: 0.66 })).toBe('boost');
    expect(verdict({ sellChance: 0.67 })).toBe('watch');
    expect(verdict({ sellChance: 0.86 })).toBe('watch');
    expect(verdict({ sellChance: 0.87 })).toBe('sells-anyway');
  });

  it('sends a mid-gap night to the gap start, so a 2+ night stay can take the whole gap', () => {
    expect(verdict({ gapStart: false })).toBe('boost-gap-start');
    expect(verdict({ gapStart: false, sellChance: 0.8 })).toBe('watch');
  });
});

describe('rollUpDateVerdict', () => {
  const unit = (verdict: BoosterUnitNight['verdict']): BoosterUnitNight => ({
    unitId: 'u',
    label: 'U',
    openRooms: 1,
    capacity: 1,
    sellChance: 0.5,
    boostedSellChance: 0.85,
    openRunNights: 2,
    openGapNights: 2,
    gapStart: true,
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
    expect(rollUpDateVerdict([unit('sells-anyway'), unit('boost-gap-start')], 0)).toBe('boost-gap-start');
    expect(rollUpDateVerdict([unit('sells-anyway'), unit('check-price')], 0)).toBe('check-price');
  });
});

describe('isIsoDate', () => {
  it('accepts real calendar dates only', () => {
    expect(isIsoDate('2026-11-20')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('20-11-2026')).toBe(false);
    expect(isIsoDate(20261120)).toBe(false);
  });
});

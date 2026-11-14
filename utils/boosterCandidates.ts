/**
 * Visibility Booster candidates — the pure half (client-safe, unit-tested).
 *
 * THE QUESTION: Booking.com's Visibility Booster raises the commission on every
 * booking for a chosen check-in date, including the bookings that would have
 * come anyway. Which upcoming dates are worth boosting?
 *
 * THE MODEL, in three steps:
 *   1. `sellChance` — the chance an open room-night this many days out still
 *      sells on its own, learned from our own history (`sellChanceCurve`).
 *   2. Demand behaves like a Poisson stream: an open night sells if at least one
 *      booker arrives, P = 1 − e^(−λ). The booster multiplies λ by (1 + uplift),
 *      so the boosted chance is 1 − (1 − p)^(1 + uplift). A night that would sell
 *      anyway barely moves (it was going to sell); a quiet night gains almost the
 *      full uplift. That saturation is the whole reason to boost quiet dates only.
 *   3. Boosting pays when boosted chance × boosted margin > plain chance × plain
 *      margin. With today's commission that needs about 11 % more bookings, which
 *      the saturation curve turns into a "sells anyway" threshold
 *      (`breakEvenSellChance`) — above it, boosting loses money.
 *
 * Margins are per Kč of Booking.com guest price; variable costs are a fixed share
 * of the UNBOOSTED net, because cleaning a room does not get dearer when Booking
 * takes more.
 */
import type { DemandLevel, PricePosition } from '@/utils/radarTypes';

export interface BoosterEconomics {
  baseCommission: number;
  boostedCommission: number;
  variableCostShareOfNet: number;
  assumedDemandUplift: number;
  bookingPriceFactor: number;
}

export type BoosterVerdict =
  /** Likely to stay empty and nothing else blocks it — boost the check-in date. */
  | 'boost'
  /** Likely to sell on its own — boosting mostly pays extra on bookings you'd get anyway. */
  | 'sells-anyway'
  /** The open gap is shorter than the minimum stay: no booking can start here. */
  | 'fix-min-stay'
  /** We sit far above the market — fix the price before paying for visibility. */
  | 'check-price'
  /** In between — keep an eye on it. */
  | 'watch';

export interface BoosterUnitNight {
  unitId: string;
  label: string;
  /** Rooms of this unit still unsold that night. */
  openRooms: number;
  capacity: number;
  /** Chance an open room-night this far out still sells with no help; null = no history. */
  sellChance: number | null;
  /** The same chance if the check-in date is boosted (Poisson uplift model). */
  boostedSellChance: number | null;
  /** Consecutive nights from this date with at least one room open. */
  openRunNights: number;
  /** Length of the whole open stretch this night sits in (before + after). */
  openGapNights: number;
  minStay: number | null;
  livePrice: number | null;
  position: PricePosition | null;
  /** Expected Kč from boosting this unit's open rooms for this night; null = unknown. */
  expectedGain: number | null;
  verdict: BoosterVerdict;
}

export interface BoosterDate {
  date: string;
  daysOut: number;
  cityDemand: DemandLevel | null;
  /** Market occupancy on the books for the night, 0–1 (max over bedroom categories). */
  marketOccupancy: number | null;
  /** Only units with at least one open room. */
  units: BoosterUnitNight[];
  /** Sum of the units' expected gains (unknown units count as 0). */
  expectedGain: number;
  verdict: BoosterVerdict;
}

export interface BoosterResponse {
  dates: BoosterDate[];
  economics: BoosterEconomics;
  /** Extra bookings a boosted date needs to break even, e.g. 0.11 = +11 %. */
  breakEvenLift: number;
  /** Above this chance of selling anyway, boosting loses money (under the assumed uplift). */
  breakEvenSellChance: number;
  /** Stay window the sell-chance curve learned from. */
  historyFrom: string;
  historyTo: string;
  /** Last bookings-mirror sync — the open-rooms counts are only this fresh. */
  mirrorSyncedAt: string | null;
  generatedAt: string;
}

// ── Margins ──────────────────────────────────────────────────────────────────

/** Contribution per Kč of Booking.com guest price, plain and boosted. */
export function marginsPerKc(econ: BoosterEconomics): { plain: number; boosted: number } {
  const plainNet = 1 - econ.baseCommission;
  const variable = econ.variableCostShareOfNet * plainNet;
  return { plain: plainNet - variable, boosted: 1 - econ.boostedCommission - variable };
}

/** How many more bookings a boosted date needs just to stand still (0.11 = +11 %). */
export function breakEvenLift(econ: BoosterEconomics): number {
  const m = marginsPerKc(econ);
  return m.boosted > 0 ? m.plain / m.boosted - 1 : Infinity;
}

// ── Demand model ─────────────────────────────────────────────────────────────

/** Chance an open night sells once its demand is multiplied by (1 + uplift). */
export function boostedSellChance(sellChance: number, uplift: number): number {
  const p = Math.min(1, Math.max(0, sellChance));
  return 1 - Math.pow(1 - p, 1 + uplift);
}

/**
 * The "sells anyway" chance above which boosting stops paying.
 *
 * The relative gain boosted(p)/p falls from (1 + uplift) at p → 0 to 1 at p = 1,
 * so there is exactly one crossing with the break-even ratio; bisection finds it.
 * Returns 0 when even a hopeless night cannot gain enough (uplift ≤ break-even
 * lift): no date is worth boosting.
 */
export function breakEvenSellChance(econ: BoosterEconomics): number {
  const ratio = 1 + breakEvenLift(econ);
  if (!Number.isFinite(ratio) || 1 + econ.assumedDemandUplift <= ratio) return 0;
  const gainRatio = (p: number) => boostedSellChance(p, econ.assumedDemandUplift) / p;
  let lo = 1e-9;
  let hi = 1;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (gainRatio(mid) > ratio) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Expected Kč from boosting one night of `openRooms` rooms: what the boosted
 * chance earns at the boosted margin, minus what the plain chance would have
 * earned anyway. Negative = the booster costs more than it brings.
 */
export function expectedBoostGain(
  openRooms: number,
  livePrice: number,
  sellChance: number,
  econ: BoosterEconomics,
): number {
  const guestPrice = livePrice * econ.bookingPriceFactor;
  const m = marginsPerKc(econ);
  const boosted = boostedSellChance(sellChance, econ.assumedDemandUplift);
  return openRooms * guestPrice * (boosted * m.boosted - sellChance * m.plain);
}

// ── History → sell-chance curve ──────────────────────────────────────────────

/**
 * Chance that a room-night still open `d` days before the night sells by then.
 *
 * `soldByLead[k]` = past room-nights that were booked exactly k days before the
 * night (the last bucket holds everything booked that far out or further);
 * `emptyNights` = past room-nights that never sold. A night still open d days out
 * either sells to a booking made at lead ≤ d or stays empty, so
 *
 *     chance(d) = sold(lead ≤ d) / (sold(lead ≤ d) + empty)
 *
 * Cancelled-then-resold nights count once, as the resale — the cancelled booking
 * never "held" the night as far as the end state is concerned.
 * Returns null where there is nothing to learn from.
 */
export function sellChanceCurve(soldByLead: number[], emptyNights: number): (number | null)[] {
  const curve: (number | null)[] = [];
  let cumulative = 0;
  for (const sold of soldByLead) {
    cumulative += sold;
    const denominator = cumulative + emptyNights;
    curve.push(denominator > 0 ? cumulative / denominator : null);
  }
  return curve;
}

// ── Verdicts ─────────────────────────────────────────────────────────────────

export interface VerdictInput {
  daysOut: number;
  /** Chance it sells anyway; null = no history for this unit. */
  sellChance: number | null;
  /** From `breakEvenSellChance` — above it, the booster loses money. */
  breakEvenSellChance: number;
  cityDemand: DemandLevel | null;
  /** Length of the whole open stretch this night sits in — what decides an orphan. */
  openGapNights: number;
  minStay: number | null;
  /** Our live price inside the market's asking-price percentiles. */
  position: PricePosition | null;
}

/**
 * Half-width of the "watch" band around the break-even sell chance, in absolute
 * points: with break-even at ~60 % this boosts below 50 %, watches 50–70 % and
 * calls 70 %+ "sells anyway". Relative to the break-even (not fixed at 50/70) so
 * the band moves with the commission and uplift assumptions.
 */
export const WATCH_BAND = 0.1;

/**
 * The operator's call for one unit on one night (Patrik's rules, 2026-11-14).
 * First match wins:
 *   1. The whole open gap is shorter than the minimum stay → nobody can book it;
 *      PriceLabs' orphan rule should have caught it, so this is a PriceLabs
 *      setting to check. (The whole gap, not the nights from this date on: the
 *      last night of a 3-night gap is bookable from the gap's first night.)
 *   2. Good/High demand → trust PriceLabs; it is pricing the strong date already.
 *   3. Above the market's p90 on a normal/low date → we are not competitive;
 *      fix the price before paying for visibility. (On strong dates step 2 has
 *      already returned — sitting high there is PriceLabs doing its job.)
 *   4. No history → can't judge, keep watching.
 *   5. The break-even band: below it boost, inside it watch, above it sells anyway.
 */
export function boosterVerdict(input: VerdictInput): BoosterVerdict {
  const { sellChance, breakEvenSellChance, cityDemand, openGapNights, minStay, position } = input;
  if (minStay !== null && openGapNights < minStay) return 'fix-min-stay';
  if (cityDemand === 'good' || cityDemand === 'high') return 'sells-anyway';
  if (position === 'above-p90') return 'check-price';
  if (sellChance === null) return 'watch';
  if (sellChance < breakEvenSellChance - WATCH_BAND) return 'boost';
  if (sellChance <= breakEvenSellChance + WATCH_BAND) return 'watch';
  return 'sells-anyway';
}

/** Which non-boost verdict to show for a date — the most actionable one first. */
const DATE_VERDICT_PRIORITY: BoosterVerdict[] = ['fix-min-stay', 'check-price', 'watch', 'sells-anyway'];

/**
 * The booster works per check-in DATE, not per apartment, so a date is worth
 * boosting only when the units that say "boost" outweigh the deadweight on the
 * open units that would sell anyway. Otherwise the most actionable other verdict.
 */
export function rollUpDateVerdict(units: BoosterUnitNight[], expectedGain: number): BoosterVerdict {
  if (units.some((u) => u.verdict === 'boost') && expectedGain > 0) return 'boost';
  for (const verdict of DATE_VERDICT_PRIORITY) {
    if (units.some((u) => u.verdict === verdict)) return verdict;
  }
  return 'sells-anyway';
}

/**
 * Consecutive open nights starting at each index — a check-in on night i can
 * stay `run[i]` nights before hitting a sold-out night.
 */
export function openRuns(openRooms: number[]): number[] {
  const runs = new Array<number>(openRooms.length).fill(0);
  for (let i = openRooms.length - 1; i >= 0; i -= 1) {
    runs[i] = openRooms[i] > 0 ? 1 + (i + 1 < openRooms.length ? runs[i + 1] : 0) : 0;
  }
  return runs;
}

/**
 * Length of the whole open stretch each night sits in (0 when sold out). A gap
 * shorter than the minimum stay is a true orphan; a night whose own forward run
 * is too short but whose gap is long enough is simply the tail of a stay that
 * starts earlier.
 */
export function openGaps(openRooms: number[]): number[] {
  const forward = openRuns(openRooms);
  const gaps = new Array<number>(openRooms.length).fill(0);
  let back = 0;
  for (let i = 0; i < openRooms.length; i += 1) {
    back = openRooms[i] > 0 ? back + 1 : 0;
    gaps[i] = openRooms[i] > 0 ? back + forward[i] - 1 : 0;
  }
  return gaps;
}

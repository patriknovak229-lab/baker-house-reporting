/**
 * Visibility Booster candidates — the pure half (client-safe, unit-tested).
 *
 * THE QUESTION: Booking.com's Visibility Booster raises the commission on every
 * booking for a chosen check-in date, including the bookings that would have
 * come anyway. Which upcoming dates are worth boosting?
 *
 * THE MODEL (Patrik's assumptions, 2026-11-17):
 *   1. `sellChance` — the chance an open room-night this many days out still
 *      sells on its own, learned from our own history (`sellChanceCurve`).
 *   2. Boosting at the recommended level (25 %) lifts that chance to
 *      `fillAtBoost` (85 %) — boosted dates reach page 1 of a Brno search.
 *      Intermediate levels are not modelled: with a fill chance that rises in a
 *      straight line from 18 % to 25 %, the gain is a hump whose top sits past
 *      25 %, so the best level is 25 % or nothing (a 19–24 % level wins only in a
 *      ~1.5-point band of sell chance, for a few Kč). Above 25 % there is no fill
 *      left to buy.
 *   3. Boosting pays when fill × boosted margin > plain chance × plain margin,
 *      i.e. below a sell chance of fill × (boosted ÷ plain margin) ≈ 0.9 × fill
 *      (`breakEvenSellChance`, ≈ 77 % at an 85 % fill).
 *
 * Margins are per Kč of Booking.com guest price; variable costs are a fixed share
 * of the UNBOOSTED net, because cleaning a room does not get dearer when Booking
 * takes more.
 */
import type { DemandLevel, PricePosition } from '@/utils/radarTypes';

export interface BoosterEconomics {
  baseCommission: number;
  boostedCommission: number;
  /** Recommended booster slider level, nominal commission points (e.g. 25). */
  boostLevel: number;
  variableCostShareOfNet: number;
  /** Chance a still-open room sells once its check-in date is boosted. */
  fillAtBoost: number;
  bookingPriceFactor: number;
}

export type BoosterVerdict =
  /** Likely to stay empty, first night of its gap, nothing blocks it — boost. */
  | 'boost'
  /** Worth boosting, but it sits inside a gap — boost the gap's first night instead. */
  | 'boost-gap-start'
  /** Likely to sell on its own — boosting mostly pays extra on bookings you'd get anyway. */
  | 'sells-anyway'
  /** The open gap is shorter than the minimum stay: no booking can start here. */
  | 'fix-min-stay'
  /** We sit far above the market on a normal/low date — fix the price first. */
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
  /** The same chance if the check-in date is boosted (never below sellChance). */
  boostedSellChance: number | null;
  /** Consecutive nights from this date with at least one room open. */
  openRunNights: number;
  /** Length of the whole open stretch this night sits in (before + after). */
  openGapNights: number;
  /** True when the night before is sold (or is in the past) — a stay can take the whole gap from here. */
  gapStart: boolean;
  minStay: number | null;
  livePrice: number | null;
  position: PricePosition | null;
  /** Expected Kč from boosting this unit's open rooms for this night; null = unknown. */
  expectedGain: number | null;
  verdict: BoosterVerdict;
}

/** A check-in date the operator ticked as boosted in the card. */
export interface BoostedFlag {
  /** Nominal booster slider level, e.g. 22 or 25. */
  commission: number;
  markedAt: string;
  markedBy: string | null;
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
  /** Ticked as boosted in the card; null = not ticked. */
  flag: BoostedFlag | null;
  /** Highest all-in commission seen on a Booking.com booking for this check-in date, when it looks boosted. */
  detectedCommission: number | null;
}

/** How the boosted dates of the last N days actually did. */
export interface BoosterTrackRecord {
  from: string;
  to: string;
  /** Distinct boosted check-in dates (ticked or detected from commission). */
  boostedDates: number;
  /** …of which only known because a boosted booking came in (not ticked). */
  detectedOnly: number;
  /** Rooms still open on those nights that a boosted check-in filled. */
  filledByBoost: number;
  /** Rooms left empty on those nights. */
  leftEmpty: number;
}

export interface BoosterResponse {
  dates: BoosterDate[];
  economics: BoosterEconomics;
  /** Extra sales a boosted date needs to break even, e.g. 0.11 = +11 %. */
  breakEvenLift: number;
  /** Above this chance of selling anyway, boosting loses money. */
  breakEvenSellChance: number;
  /** Half-width of the watch band around the break-even, absolute points. */
  watchBand: number;
  /** Strong-demand dates stop being trusted to PriceLabs this many days out. */
  closeInDays: number;
  trackRecord: BoosterTrackRecord;
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

/** How many more sales a boosted date needs just to stand still (0.11 = +11 %). */
export function breakEvenLift(econ: BoosterEconomics): number {
  const m = marginsPerKc(econ);
  return m.boosted > 0 ? m.plain / m.boosted - 1 : Infinity;
}

// ── Fill model ───────────────────────────────────────────────────────────────

/** Chance an open night sells once its check-in date is boosted. A boost never makes it less likely. */
export function boostedSellChance(sellChance: number, fillAtBoost: number): number {
  return Math.max(Math.min(1, Math.max(0, sellChance)), fillAtBoost);
}

/**
 * The "sells anyway" chance above which boosting stops paying: where
 * plain chance × plain margin = fill × boosted margin.
 */
export function breakEvenSellChance(econ: BoosterEconomics): number {
  const m = marginsPerKc(econ);
  if (m.plain <= 0 || m.boosted <= 0) return 0;
  return Math.min(1, (econ.fillAtBoost * m.boosted) / m.plain);
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
  const boosted = boostedSellChance(sellChance, econ.fillAtBoost);
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
  /** The night before is sold (or past) — a stay starting here can take the whole gap. */
  gapStart: boolean;
  minStay: number | null;
  /** Our live price inside the market's asking-price percentiles. */
  position: PricePosition | null;
}

/**
 * Half-width of the "watch" band around the break-even sell chance, in absolute
 * points: with break-even at ~77 % this boosts below ~67 %, watches ~67–87 % and
 * calls ~87 %+ "sells anyway". Relative to the break-even (not fixed numbers) so
 * the band moves with the commission and fill assumptions.
 */
export const WATCH_BAND = 0.1;

/**
 * PriceLabs' Good/High-demand reading is trusted (no boost) until the night is
 * still open this close to the date. PriceLabs has no last-minute logic, so from
 * here on the night's own sell chance decides.
 */
export const CLOSE_IN_DAYS = 3;

/**
 * The operator's call for one unit on one night (Patrik's rules, 2026-11-14,
 * revised 2026-11-17). First match wins:
 *   1. The whole open gap is shorter than the minimum stay → nobody can book it;
 *      PriceLabs' orphan rule should have caught it — check that setting.
 *   2. Good/High demand more than CLOSE_IN_DAYS out → trust PriceLabs.
 *   3. Above the market's p90 on a normal/low date → not competitive; fix the
 *      price first. (On strong dates PriceLabs prices high on purpose.)
 *   4. No history → can't judge, keep watching.
 *   5. Below break-even − band → boost — but only on the gap's FIRST night, so a
 *      2+ night stay can take the whole gap (single nights carry the one-night
 *      premium on purpose; a stay starting mid-gap can strand the nights before).
 *   6. Inside the band → watch; above it → sells anyway.
 */
export function boosterVerdict(input: VerdictInput): BoosterVerdict {
  const { daysOut, sellChance, breakEvenSellChance, cityDemand, openGapNights, gapStart, minStay, position } =
    input;
  if (minStay !== null && openGapNights < minStay) return 'fix-min-stay';
  const strongDemand = cityDemand === 'good' || cityDemand === 'high';
  if (strongDemand && daysOut > CLOSE_IN_DAYS) return 'sells-anyway';
  if (!strongDemand && position === 'above-p90') return 'check-price';
  if (sellChance === null) return 'watch';
  if (sellChance < breakEvenSellChance - WATCH_BAND) return gapStart ? 'boost' : 'boost-gap-start';
  if (sellChance <= breakEvenSellChance + WATCH_BAND) return 'watch';
  return 'sells-anyway';
}

/** Which non-boost verdict to show for a date — the most actionable one first. */
const DATE_VERDICT_PRIORITY: BoosterVerdict[] = [
  'fix-min-stay',
  'check-price',
  'boost-gap-start',
  'watch',
  'sells-anyway',
];

/**
 * The booster works per check-in DATE across all apartments, so a date is worth
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

/** Valid booster slider levels to tick, above the 18 % Preferred base. */
export const BOOST_LEVELS = [19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];

/** YYYY-MM-DD with a real calendar date behind it. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Corporate schedule arithmetic — pure, no I/O, tested in corporateSchedule.test.ts.
 *
 * Turns an agreement's pattern ("Mon and Tue nights, every week, 12 Oct → 17
 * Dec") into the list of stays it implies, and prices a stay from the
 * agreement's pricing mode. Both the client preview and the server run exactly
 * this code, which is what lets the server trust the client's row numbering:
 * the same spec always numbers the same stays.
 *
 * THE MODEL: the operator picks the NIGHTS the guest sleeps here, not arrival
 * days. Consecutive chosen nights become one stay — Mon + Tue nights is a
 * single Mon → Wed booking, and Sat + Sun + Mon nights is one Sat → Tue booking
 * even though it crosses the week boundary. That is how the company thinks
 * about it ("we need Monday and Tuesday"), and it removes the classic
 * off-by-one where "until the 17th" is read as a night by one person and a
 * checkout by another: `endDate` is the last night that may be slept, full stop.
 */
import type { PricingMode, StayPriceSource } from './corporateShared';

export interface ScheduleSpec {
  /** First night the pattern may fall on (YYYY-MM-DD). */
  startDate: string;
  /** Last night the pattern may fall on, inclusive (YYYY-MM-DD). */
  endDate: string;
  /** ISO weekdays (Mon = 1 … Sun = 7) of the nights the guest sleeps here. */
  nightWeekdays: number[];
}

/** One stay the pattern implies — a run of consecutive chosen nights. */
export interface StayOccurrence {
  /** 1-based, in date order. */
  seq: number;
  /** First night (check-in date). */
  arrival: string;
  /** Checkout morning — the day after the last night. */
  departure: string;
  nights: number;
}

/** Longest span an agreement may cover. A year of weekly stays is the realistic maximum. */
export const MAX_SCHEDULE_DAYS = 400;
/** Most stays one agreement may generate — keeps the Beds24 batch and the preview sane. */
export const MAX_STAYS = 120;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function isYmd(v: unknown): v is string {
  if (typeof v !== 'string' || !YMD.test(v)) return false;
  // Date.parse happily rolls "2026-02-30" over into March, so round-trip the
  // value: a real calendar date comes back unchanged.
  const ms = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === v;
}

/** Add `n` days to a YYYY-MM-DD date (UTC arithmetic — inputs carry no time). */
export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (exclusive) — nights of a stay. */
export function nightsBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** ISO weekday of a YYYY-MM-DD date: Mon = 1 … Sun = 7. */
export function isoWeekday(ymd: string): number {
  const js = new Date(`${ymd}T00:00:00Z`).getUTCDay(); // Sun = 0
  return js === 0 ? 7 : js;
}

/**
 * Why a spec cannot be scheduled, or null when it can. Checked before
 * `generateStays`, which assumes a valid spec.
 */
export function validateSchedule(spec: ScheduleSpec): string | null {
  if (!isYmd(spec.startDate)) return 'Start date must be a valid YYYY-MM-DD date';
  if (!isYmd(spec.endDate)) return 'End date must be a valid YYYY-MM-DD date';
  if (spec.endDate < spec.startDate) return 'The last night cannot be before the first night';
  const span = nightsBetween(spec.startDate, spec.endDate) + 1;
  if (span > MAX_SCHEDULE_DAYS) return `The period may cover at most ${MAX_SCHEDULE_DAYS} days`;
  const days = spec.nightWeekdays;
  if (!Array.isArray(days) || days.length === 0) return 'Pick at least one night of the week';
  if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return 'Weekdays must be ISO numbers 1 (Mon) to 7 (Sun)';
  return null;
}

/**
 * Every stay the pattern implies between the two dates, in date order.
 *
 * Walks each calendar night in [startDate, endDate], keeps the ones whose
 * weekday is chosen, and merges consecutive kept nights into one stay. A
 * pattern with all seven nights therefore yields ONE long stay, which is the
 * correct answer for "they want it continuously".
 */
export function generateStays(spec: ScheduleSpec): StayOccurrence[] {
  const problem = validateSchedule(spec);
  if (problem) throw new Error(problem);

  const wanted = new Set(spec.nightWeekdays);
  const stays: StayOccurrence[] = [];
  let runStart: string | null = null;
  let runNights = 0;

  const close = (afterLastNight: string) => {
    if (runStart === null) return;
    stays.push({ seq: stays.length + 1, arrival: runStart, departure: afterLastNight, nights: runNights });
    runStart = null;
    runNights = 0;
  };

  const stop = addDays(spec.endDate, 1); // first morning after the period
  for (let night = spec.startDate; night < stop; night = addDays(night, 1)) {
    if (wanted.has(isoWeekday(night))) {
      if (runStart === null) runStart = night;
      runNights += 1;
    } else {
      close(night);
    }
  }
  close(stop);

  if (stays.length > MAX_STAYS) {
    throw new Error(`This pattern produces ${stays.length} stays; the limit is ${MAX_STAYS}. Shorten the period.`);
  }
  return stays;
}

/** "Mon + Tue nights", "Mon–Fri nights", "every night" — for lists and Telegram. */
export function describeNights(nightWeekdays: number[]): string {
  const days = [...new Set(nightWeekdays)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  if (days.length === 0) return 'no nights';
  if (days.length === 7) return 'every night';
  const short = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  // A single unbroken run reads better as a range.
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  if (contiguous && days.length >= 3) return `${short[days[0]]}–${short[days[days.length - 1]]} nights`;
  return `${days.map((d) => short[d]).join(' + ')} night${days.length === 1 ? '' : 's'}`;
}

// ─── Pricing ─────────────────────────────────────────────────────────────────

export interface StayPriceInputs {
  mode: PricingMode;
  nights: number;
  /** Flat mode: the agreed nightly rate. */
  flatNightPriceCzk?: number | null;
  /** Dynamic mode: the web price Beds24 quoted for the stay, before discount. */
  listPriceCzk?: number | null;
  /** Dynamic mode: percent off the web price (0–100). */
  discountPercent?: number | null;
}

/**
 * The price a stay is charged, in whole CZK, or null when it cannot be known
 * yet (dynamic mode with no quote). Flat ignores the discount on purpose — a
 * negotiated nightly rate is already the final number.
 */
export function computeStayPrice(inputs: StayPriceInputs): number | null {
  if (inputs.nights <= 0) return null;
  if (inputs.mode === 'flat') {
    const rate = inputs.flatNightPriceCzk;
    if (rate === null || rate === undefined || !Number.isFinite(rate) || rate < 0) return null;
    return Math.round(rate * inputs.nights);
  }
  const list = inputs.listPriceCzk;
  if (list === null || list === undefined || !Number.isFinite(list) || list < 0) return null;
  const pct = Math.min(100, Math.max(0, inputs.discountPercent ?? 0));
  return Math.round(list * (1 - pct / 100));
}

/** Which source label a computed price carries. */
export function priceSourceFor(mode: PricingMode, quoteSource?: 'offers' | 'calendar-nominal' | 'none' | null): StayPriceSource | null {
  if (mode === 'flat') return 'flat';
  if (quoteSource === 'offers' || quoteSource === 'calendar-nominal') return quoteSource;
  return null;
}

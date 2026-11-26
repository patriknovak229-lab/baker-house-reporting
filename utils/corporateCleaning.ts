/**
 * Mid-stay cleanings for corporate stays — pure rules, no I/O.
 *
 * A long corporate stay gets cleanings DURING the stay ("Úklid během pobytu")
 * on top of the ordinary post-stay cleaning, which this module never touches.
 * The operator picks a frequency per stay; the frequency fixes the MINIMUM
 * number of cleanings: one per started cycle after the first, so the guest is
 * never longer than one cycle without a clean apartment (arrival counts as
 * clean, the post-stay cleaning doesn't count).
 *
 *   73 nights, weekly → cycles end day 7, 14 … 70 → 10 cleanings
 *   (day 77 would be after checkout on day 73 — that's the post-stay clean).
 *
 * Two ways to place them:
 *   - regular: a weekday (two for twice a week) → dates generated on the calendar
 *   - ad hoc:  one date box per expected cleaning, filled in by the operator
 * Either way the saved result is a plain list of dates the operator can edit at
 * any time; that list is what reaches the cleaning app
 * (utils/cleaningRequestsPublish.ts).
 */
import { addDays, isoWeekday, isYmd, nightsBetween } from '@/utils/corporateSchedule';

export type CleaningFrequency = 'twice_weekly' | 'weekly' | 'biweekly';
export type CleaningMode = 'regular' | 'adhoc';

export interface CleaningPlan {
  frequency: CleaningFrequency;
  mode: CleaningMode;
  /** ISO weekdays (1 = Mon … 7 = Sun) for regular plans; [] for ad hoc. */
  weekdays: number[];
  /** The cleanings, YYYY-MM-DD, sorted — strictly inside the stay. */
  dates: string[];
  updatedAt: string;
  updatedBy: string;
}

/** Label the cleaning app shows on each of these cleanings (Czech app). */
export const CORPORATE_CLEANING_TEXT = 'Úklid během pobytu';

/** Id prefix of the published cleanings — reporting-side, so the sync can tell them apart. */
export const CORPORATE_CLEANING_ID_PREFIX = 'corp-';

export const FREQUENCY_LABELS: Record<CleaningFrequency, string> = {
  twice_weekly: 'Twice a week',
  weekly: 'Once a week',
  biweekly: 'Every 2 weeks',
};

/** Longest stretch, in days, a guest may go without a cleaning. */
export const CYCLE_DAYS: Record<CleaningFrequency, number> = {
  twice_weekly: 3.5,
  weekly: 7,
  biweekly: 14,
};

/** Weekdays a regular plan needs: two for twice a week, one otherwise. */
export function weekdaysNeeded(frequency: CleaningFrequency): number {
  return frequency === 'twice_weekly' ? 2 : 1;
}

/**
 * Minimum cleanings during the stay: one per cycle that starts before
 * checkout, minus the first (arrival is clean). 73 n weekly → 10, 14 n → 1,
 * 7 n → 0 (checkout day is the post-stay clean).
 */
export function expectedCleaningCount(nights: number, frequency: CleaningFrequency): number {
  if (!Number.isFinite(nights) || nights <= 1) return 0;
  return Math.max(0, Math.ceil(nights / CYCLE_DAYS[frequency]) - 1);
}

/** A date a mid-stay cleaning can be on: after arrival day, before checkout day. */
export function isInsideStay(arrival: string, departure: string, date: string): boolean {
  return isYmd(date) && date > arrival && date < departure;
}

/** Sorted, de-duplicated, inside-the-stay dates only. */
export function normalizeDates(arrival: string, departure: string, dates: string[]): string[] {
  return [...new Set(dates.filter((d) => isInsideStay(arrival, departure, d)))].sort();
}

/**
 * Longest run of days without a cleaning, counting arrival and the post-stay
 * clean on checkout day as clean. The UI warns when it exceeds the cycle.
 */
export function longestGapDays(arrival: string, departure: string, dates: string[]): number {
  const points = [arrival, ...normalizeDates(arrival, departure, dates), departure];
  let max = 0;
  for (let i = 1; i < points.length; i++) max = Math.max(max, nightsBetween(points[i - 1], points[i]));
  return max;
}

/**
 * Evenly spaced starting suggestion for an ad hoc plan — one date at the end
 * of each cycle. Only a prefill; the operator agrees real dates with the guest.
 */
export function suggestedAdhocDates(arrival: string, departure: string, frequency: CleaningFrequency): string[] {
  const n = expectedCleaningCount(nightsBetween(arrival, departure), frequency);
  const out: string[] = [];
  for (let k = 1; k <= n; k++) out.push(addDays(arrival, Math.floor(k * CYCLE_DAYS[frequency])));
  return normalizeDates(arrival, departure, out);
}

/**
 * Days after arrival before the first regular cleaning may happen — the
 * apartment was cleaned for the guest's arrival, so a cleaning the next day
 * would clean a clean room (Patrik, 2026-11-26). Half a cycle, rounded up:
 * weekly → 4, so with "every Tuesday" the first cleaning is
 *   arrive Mon → 8 days, Tue → 7, Wed → 6, Thu → 5, Fri → 4, Sat → 10, Sun → 9
 * i.e. never sooner than 4 nights and never later than 10.
 * Twice a week → 2, every 2 weeks → 7 (same idea, scaled to the cycle).
 */
export function minDaysBeforeFirstCleaning(frequency: CleaningFrequency): number {
  return Math.ceil(CYCLE_DAYS[frequency] / 2);
}

/**
 * Regular plan: the chosen weekday(s), starting with the first one at least
 * `minDaysBeforeFirstCleaning` days after arrival, then every occurrence
 * (weekly, twice a week) or every second one (every 2 weeks) until the day
 * before checkout. The count can differ by one from `expectedCleaningCount`
 * — the calendar decides; the operator can still edit every date.
 */
export function regularCleaningDates(
  arrival: string,
  departure: string,
  frequency: CleaningFrequency,
  weekdays: number[],
): string[] {
  if (weekdays.length === 0) return [];
  const out: string[] = [];
  for (let d = addDays(arrival, minDaysBeforeFirstCleaning(frequency)); d < departure; d = addDays(d, 1)) {
    if (!weekdays.includes(isoWeekday(d))) continue;
    if (frequency === 'biweekly' && out.length > 0 && nightsBetween(out[out.length - 1], d) < 14) continue;
    out.push(d);
  }
  return out;
}

/** Validate a plan coming from the client. Returns the clean plan or an error. */
export function parseCleaningPlanInput(
  body: unknown,
  arrival: string,
  departure: string,
): { ok: true; value: Omit<CleaningPlan, 'updatedAt' | 'updatedBy'> } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body must be an object' };
  const b = body as Record<string, unknown>;
  const frequency = b.frequency as CleaningFrequency;
  if (!(frequency in CYCLE_DAYS)) return { ok: false, error: 'frequency must be twice_weekly, weekly or biweekly' };
  const mode = b.mode as CleaningMode;
  if (mode !== 'regular' && mode !== 'adhoc') return { ok: false, error: 'mode must be regular or adhoc' };
  const weekdays = Array.isArray(b.weekdays)
    ? [...new Set(b.weekdays.filter((d): d is number => Number.isInteger(d) && d >= 1 && d <= 7))].sort()
    : [];
  if (mode === 'regular' && weekdays.length !== weekdaysNeeded(frequency)) {
    return { ok: false, error: `Pick ${weekdaysNeeded(frequency)} weekday(s) for a regular plan` };
  }
  if (!Array.isArray(b.dates) || !b.dates.every((d) => typeof d === 'string')) {
    return { ok: false, error: 'dates must be a list of YYYY-MM-DD' };
  }
  const outside = (b.dates as string[]).filter((d) => d && !isInsideStay(arrival, departure, d));
  if (outside.length) {
    return { ok: false, error: `Not inside the stay (after arrival day, before checkout day): ${outside.join(', ')}` };
  }
  return {
    ok: true,
    value: { frequency, mode, weekdays: mode === 'regular' ? weekdays : [], dates: normalizeDates(arrival, departure, b.dates as string[]) },
  };
}

/**
 * Pay-later dates — the one place the timeline is computed. Client-safe (pure).
 *
 * MUST stay identical to the rental site's src/lib/pay-later.ts: both apps run
 * the same 11 fixtures from Projects/PayLater/contract.md §1. The guest is shown
 * the website's numbers; the charge job uses these.
 *
 * Example, 3 nights from 10 Dec: free cancellation until 23:59 on 3 Dec,
 * 1st charge 1 Dec 08:00, 2nd charge 2 Dec 16:00, reminder 28 Nov 09:00
 * (all Prague time). The deadline day itself is a buffer for late runs.
 */

export const PRAGUE_TZ = 'Europe/Prague';

/** Stays of this many nights or more get the longer free-cancellation window. */
export const LONG_STAY_MIN_NIGHTS = 7;
export const SHORT_STAY_WINDOW_DAYS = 7;
export const LONG_STAY_WINDOW_DAYS = 14;

/** Prague wall-clock times of the steps. */
export const ATTEMPT1_HOUR = 8;
export const ATTEMPT2_HOUR = 16;
export const REMINDER_HOUR = 9;
/** A reminder this close to the booking is pointless — the guest just got the confirmation. */
export const REMINDER_MIN_LEAD_MS = 24 * 60 * 60 * 1000;
/** The guest always gets at least this long between the "payment failed" email and the 2nd attempt. */
export const MIN_GAP_AFTER_DECLINE_MS = 20 * 60 * 60 * 1000;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function isoToUtcMs(iso: string): number | null {
  const m = ISO_RE.exec(iso.trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function addDaysIso(iso: string, days: number): string {
  const t = isoToUtcMs(iso);
  if (t == null) throw new Error(`Bad date: ${iso}`);
  return new Date(t + days * DAY_MS).toISOString().slice(0, 10);
}

const PRAGUE_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: PRAGUE_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Minutes Prague is ahead of UTC at this instant (60 in winter, 120 in summer). */
function pragueOffsetMinutes(instantMs: number): number {
  const parts = PRAGUE_PARTS.formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((wall - Math.floor(instantMs / 1000) * 1000) / 60_000);
}

/** The UTC instant of a Prague wall-clock time, through the real CET/CEST offset. */
export function pragueTimeToUtc(dateIso: string, hour: number, minute = 0): Date {
  const day = isoToUtcMs(dateIso);
  if (day == null) throw new Error(`Bad date: ${dateIso}`);
  const naive = day + (hour * 60 + minute) * 60_000;
  // Guess with the offset at the naive instant, then correct once: right on
  // both sides of a clock change (our hours are never inside the 02:00–03:00 gap).
  const first = naive - pragueOffsetMinutes(naive) * 60_000;
  const second = naive - pragueOffsetMinutes(first) * 60_000;
  return new Date(second);
}

/** Calendar date (YYYY-MM-DD) in Prague at this instant. */
export function pragueDateOf(now: Date): string {
  const parts = PRAGUE_PARTS.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function nightsBetween(arrivalIso: string, departureIso: string): number | null {
  const a = isoToUtcMs(arrivalIso);
  const d = isoToUtcMs(departureIso);
  if (a == null || d == null || d <= a) return null;
  return Math.round((d - a) / DAY_MS);
}

export function freeCancellationWindowDays(nights: number): number {
  return nights >= LONG_STAY_MIN_NIGHTS ? LONG_STAY_WINDOW_DAYS : SHORT_STAY_WINDOW_DAYS;
}

export interface PayLaterTimeline {
  nights: number;
  windowDays: number;
  /** Last free-cancellation day — free until 23:59 Prague time. */
  deadlineDate: string;
  attempt1Date: string;
  attempt1At: Date;
  attempt2Date: string;
  attempt2At: Date;
  /** null when the guest booked less than 24 h before it would go out. */
  reminderAt: Date | null;
  /** True when the 1st charge is at least tomorrow (Prague) — pay later can be offered. */
  qualifies: boolean;
}

/** Contract §1. Returns null for impossible dates. */
export function payLaterSchedule(arrivalIso: string, departureIso: string, now: Date): PayLaterTimeline | null {
  const nights = nightsBetween(arrivalIso, departureIso);
  if (nights == null) return null;
  const windowDays = freeCancellationWindowDays(nights);
  const deadlineDate = addDaysIso(arrivalIso, -windowDays);
  const attempt1Date = addDaysIso(deadlineDate, -2);
  const attempt2Date = addDaysIso(deadlineDate, -1);
  const reminderCandidate = pragueTimeToUtc(addDaysIso(attempt1Date, -3), REMINDER_HOUR);
  return {
    nights,
    windowDays,
    deadlineDate,
    attempt1Date,
    attempt1At: pragueTimeToUtc(attempt1Date, ATTEMPT1_HOUR),
    attempt2Date,
    attempt2At: pragueTimeToUtc(attempt2Date, ATTEMPT2_HOUR),
    reminderAt: reminderCandidate.getTime() - now.getTime() < REMINDER_MIN_LEAD_MS ? null : reminderCandidate,
    qualifies: pragueDateOf(now) < attempt1Date,
  };
}

/** The 2nd attempt never comes sooner than 20 h after the 1st decline (a late 1st run). */
export function effectiveAttempt2At(attempt2At: Date, firstDeclineAt: Date | null): Date {
  if (!firstDeclineAt) return attempt2At;
  const floor = firstDeclineAt.getTime() + MIN_GAP_AFTER_DECLINE_MS;
  return new Date(Math.max(attempt2At.getTime(), floor));
}

/** True while cancellation is still free (until 23:59 Prague on the deadline day). */
export function withinFreeCancellation(deadlineDate: string, now: Date): boolean {
  return pragueDateOf(now) <= deadlineDate;
}

/** "1. 12. 2026" / "1 December 2026" */
export function formatDateLong(iso: string, lang: 'cs' | 'en'): string {
  const t = isoToUtcMs(iso);
  if (t == null) return iso;
  if (lang === 'cs') {
    const [y, m, d] = iso.split('-').map(Number);
    return `${d}. ${m}. ${y}`;
  }
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(t));
}

/** "1. 12. 2026 v 8:00" / "1 December 2026 at 08:00" — Prague time. */
export function formatPragueDateTime(at: Date, lang: 'cs' | 'en'): string {
  const date = formatDateLong(pragueDateOf(at), lang);
  const parts = PRAGUE_PARTS.formatToParts(at);
  const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return lang === 'cs' ? `${date} v ${Number(hh)}:${mm}` : `${date} at ${hh}:${mm}`;
}

/** "12 345 Kč" from haléře. */
export function formatCzk(amountMinor: number): string {
  const czk = amountMinor / 100;
  const whole = Number.isInteger(czk);
  return `${czk.toLocaleString('cs-CZ', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })} Kč`;
}

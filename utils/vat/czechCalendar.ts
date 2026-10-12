/**
 * Czech working-day calendar for VAT deadlines.
 *
 * The VAT return, the control statement (kontrolní hlášení) and the VAT
 * payment are due on the 25th day after the end of the month. A deadline that
 * falls on a weekend or a public holiday moves to the next working day
 * (§ 33(4) daňový řád). Dates are plain 'YYYY-MM-DD' strings handled in UTC so
 * the server's timezone can never shift a day.
 */

const DAY_MS = 86_400_000;

function parse(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fmt(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return fmt(new Date(parse(iso).getTime() + days * DAY_MS));
}

/** Whole days from `fromIso` to `toIso` (negative when `toIso` is earlier). */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((parse(toIso).getTime() - parse(fromIso).getTime()) / DAY_MS);
}

/** Easter Sunday (Gregorian, anonymous algorithm). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Czech public holidays (zákon č. 245/2000 Sb.) for a year. */
export function czechHolidays(year: number): Set<string> {
  const easter = easterSunday(year);
  const fixed = ['01-01', '05-01', '05-08', '07-05', '07-06', '09-28', '10-28', '11-17', '12-24', '12-25', '12-26'];
  return new Set([
    ...fixed.map((md) => `${year}-${md}`),
    addDays(easter, -2), // Good Friday
    addDays(easter, 1),  // Easter Monday
  ]);
}

export function isWorkingDay(iso: string): boolean {
  const dow = parse(iso).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !czechHolidays(Number(iso.slice(0, 4))).has(iso);
}

export function nextWorkingDayOnOrAfter(iso: string): string {
  let d = iso;
  while (!isWorkingDay(d)) d = addDays(d, 1);
  return d;
}

/** 'YYYY-MM' of the month after `month`. */
export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

export function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export function monthStart(month: string): string {
  return `${month}-01`;
}

export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}

/** Filing + payment deadline for a monthly VAT period: the 25th of the next month, moved to a working day. */
export function filingDeadline(month: string): string {
  return nextWorkingDayOnOrAfter(`${nextMonth(month)}-25`);
}

/** 'YYYY-MM-DD' → 'DD.MM.YYYY' (the EPO date format). */
export function toCzechDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

export function isValidMonth(month: string | null | undefined): month is string {
  return !!month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

export function isValidIsoDate(iso: string | null | undefined): iso is string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  return fmt(parse(iso)) === iso;
}

import type { Reservation } from "@/types/reservation";

export type PeriodKey =
  | "current-month"
  | "last-month"
  | "last-30-days"
  | "next-month"
  | "custom";

export interface DateRange {
  start: string; // ISO date YYYY-MM-DD (inclusive)
  end: string;   // ISO date YYYY-MM-DD (inclusive)
}

export interface PeriodOption {
  key: PeriodKey;
  label: string;
}

export const PERIOD_OPTIONS: PeriodOption[] = [
  { key: "current-month", label: "Current Month" },
  { key: "last-month",    label: "Last Month" },
  { key: "last-30-days",  label: "Last 30 Days" },
  { key: "next-month",    label: "Next Month" },
  { key: "custom",        label: "Custom Range" },
];

// ── Date arithmetic helpers (UTC-consistent) ────────────────────────────────
//
// The previous implementation mixed `new Date(yyyy-mm-dd)` (parses as UTC
// midnight) with `getMonth() / setDate() / setMonth()` (LOCAL-time
// accessors) and roundtripped through `toISOString()` (back to UTC). On
// any non-UTC operator (Czech summer = UTC+2), that produced two bugs:
//
//   1. `endOfMonth("2026-05-15")` returned "2026-05-30" instead of
//      "2026-05-31" — the LAST day of every month was silently dropped
//      from "current/last/next month" ranges.
//   2. `addMonths("2026-05-31", -1)` returned "2026-05-01" instead of
//      "2026-04-30" — JS rollover ("April 31 → May 1") combined with the
//      UTC back-shift produced a wrong month entirely.
//
// Symptom: on May 31, current-month and last-month preset both computed
// to "May 1 → May 30", so the operator saw IDENTICAL numbers when
// toggling between them and May 31 nights never counted.
//
// Fix: all arithmetic goes through `Date.UTC(...)` constructors and UTC
// accessors. The only local-aware call is `today()` so the period
// boundary turns over at the operator's midnight, not UTC's.

function today(): string {
  // sv-SE locale formats as YYYY-MM-DD — saves us a manual split. Local
  // time so "current month" on the operator's clock matches what they
  // see in the UI even close to midnight.
  return new Date().toLocaleDateString("sv-SE");
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function startOfMonth(dateStr: string): string {
  return dateStr.slice(0, 7) + "-01";
}

function endOfMonth(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  // Day 0 of next month = last day of this month
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return last.toISOString().slice(0, 10);
}

function addMonths(dateStr: string, months: number): string {
  // Clamp the day-of-month to the target month's last day. Otherwise
  // adding 1 month to Jan 31 would roll over into March, and subtracting
  // 1 month from May 31 would land on May 1.
  const d = new Date(dateStr + "T00:00:00Z");
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + months;
  const day = d.getUTCDate();
  const lastDayOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfTarget);
  return new Date(Date.UTC(year, month, clampedDay)).toISOString().slice(0, 10);
}

export function getPeriodDateRange(
  period: PeriodKey,
  customRange?: DateRange
): DateRange {
  const t = today();
  const yesterday = addDays(t, -1);

  switch (period) {
    case "current-month":
      return { start: startOfMonth(t), end: endOfMonth(t) };

    case "last-month": {
      const firstOfLastMonth = startOfMonth(addMonths(t, -1));
      return { start: firstOfLastMonth, end: endOfMonth(firstOfLastMonth) };
    }

    case "last-30-days":
      return { start: addDays(t, -30), end: yesterday };

    case "next-month": {
      const firstOfNextMonth = startOfMonth(addMonths(t, 1));
      return { start: firstOfNextMonth, end: endOfMonth(firstOfNextMonth) };
    }

    case "custom":
      return customRange ?? { start: startOfMonth(t), end: yesterday };
  }
}

// Count calendar days between two inclusive ISO date strings
export function daysBetween(start: string, end: string): number {
  const msPerDay = 86_400_000;
  return Math.max(
    0,
    Math.round((new Date(end).getTime() - new Date(start).getTime()) / msPerDay) + 1
  );
}

// How many nights of a reservation physically fall within a date range.
// Uses staythrough logic: clips the stay to the period boundary.
// checkInDate is the first night; checkOutDate is the day of departure (exclusive).
// Example: check-in Mar 30, check-out Apr 3 → 2 nights in March, 2 nights in April.
export function getNightsInPeriod(
  reservation: Reservation,
  range: DateRange
): number {
  const checkIn     = new Date(reservation.checkInDate).getTime();
  const checkOut    = new Date(reservation.checkOutDate).getTime();  // exclusive upper bound
  const periodStart = new Date(range.start).getTime();
  const periodEnd   = new Date(range.end).getTime() + 86_400_000;   // inclusive → exclusive

  const overlapStart = Math.max(checkIn, periodStart);
  const overlapEnd   = Math.min(checkOut, periodEnd);
  return Math.max(0, Math.round((overlapEnd - overlapStart) / 86_400_000));
}

// A reservation overlaps a period if any of its nights fall within it.
// Replaces the old check-in-date-only attribution model.
export function isReservationInPeriod(
  reservation: Reservation,
  range: DateRange
): boolean {
  return getNightsInPeriod(reservation, range) > 0;
}

// Scale monthly fixed costs to a date range (proportional to days in that month/range)
export function scaleFixedCosts(monthlyCost: number, range: DateRange): number {
  const days = daysBetween(range.start, range.end);
  // Use 30.44 (avg days/month) as the divisor so partial months scale correctly
  return (monthlyCost / 30.44) * days;
}

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

// Returns today as a YYYY-MM-DD string
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// Add/subtract days from a YYYY-MM-DD string
function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function startOfMonth(dateStr: string): string {
  return dateStr.slice(0, 7) + "-01";
}

function endOfMonth(dateStr: string): string {
  const d = new Date(dateStr);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return last.toISOString().slice(0, 10);
}

function addMonths(dateStr: string, months: number): string {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

export function getPeriodDateRange(
  period: PeriodKey,
  customRange?: DateRange
): DateRange {
  const t = today();
  const yesterday = addDays(t, -1);

  switch (period) {
    case "current-month":
      return { start: startOfMonth(t), end: yesterday };

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

// A reservation "falls in" a period if its check-in date is within the range.
// Using check-in date as the attribution point keeps the logic simple and consistent.
export function isReservationInPeriod(
  reservation: Reservation,
  range: DateRange
): boolean {
  return (
    reservation.checkInDate >= range.start &&
    reservation.checkInDate <= range.end
  );
}

// Scale monthly fixed costs to a date range (proportional to days in that month/range)
export function scaleFixedCosts(monthlyCost: number, range: DateRange): number {
  const days = daysBetween(range.start, range.end);
  // Use 30.44 (avg days/month) as the divisor so partial months scale correctly
  return (monthlyCost / 30.44) * days;
}

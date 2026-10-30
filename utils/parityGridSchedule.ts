/**
 * When the parity grid run is due — weekly since 2026-10-30 (operator: "once
 * a week is enough"; it was daily before).
 *
 * Due on PARITY_SWEEP.gridWeekday unless a grid already landed that day, or
 * on any day once gridMaxGapDays have passed since the last grid — so a
 * Monday the Mac was asleep for catches up on the next day it wakes, and the
 * following Monday still runs (the cadence stays anchored to the weekday).
 */
import { PARITY_SWEEP } from '@/data/parityConfig';

/** ISO weekday (1 = Monday … 7 = Sunday) of a YYYY-MM-DD date. */
export function isoWeekday(isoDate: string): number {
  const day = new Date(`${isoDate}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (new Date(`${toIso}T12:00:00Z`).getTime() - new Date(`${fromIso}T12:00:00Z`).getTime()) / 86_400_000,
  );
}

/**
 * @param lastGridDate Prague date of the most recent grid run, null if none.
 * @param today Prague today.
 */
export function isGridDue(
  lastGridDate: string | null,
  today: string,
  cfg: { gridWeekday: number; gridMaxGapDays: number } = PARITY_SWEEP,
): boolean {
  if (lastGridDate === null) return true;
  if (lastGridDate >= today) return false;
  return isoWeekday(today) === cfg.gridWeekday || daysBetween(lastGridDate, today) >= cfg.gridMaxGapDays;
}

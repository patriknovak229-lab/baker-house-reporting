/**
 * Stay-level severity — one place that turns a board cell into the calendar
 * colour and the human-readable issue list the detail panel shows.
 *
 * Client-safe: pure functions over data, no env access. The MAJOR rules
 * mirror the Telegram alert rules in the ingest route exactly; MINOR is
 * view-only by design (the operator wants to see it, not be pinged about it).
 */
import {
  AIRBNB_VS_BOOKING_TOLERANCE_PCT,
  bookingMemberFloor,
} from '@/data/parityConfig';
import type { BoardUnitCell } from '@/utils/parityTypes';

export type StaySeverity = 'booked' | 'nodata' | 'ok' | 'minor' | 'major';

export interface StayIssue {
  severity: 'minor' | 'major';
  text: string;
}

export interface StayAssessment {
  severity: StaySeverity;
  issues: StayIssue[];
  /** Derived Genius/app price for the Booking observation, when present. */
  memberFloor: number | null;
  /** True when the offer carries a (detected or derived) Booking-funded discount. */
  bookingFunded: boolean;
}

const kc = (n: number) => `${Math.round(n).toLocaleString('cs-CZ')} Kč`;

export function assessStay(cell: BoardUnitCell): StayAssessment {
  const w = cell.web?.price ?? null;
  const a = cell.airbnb?.price ?? null;
  const b = cell.booking?.price ?? null;
  const bookingLabels = cell.booking?.labels ?? [];
  const bookingFunded = bookingLabels.some((l) => l.startsWith('Booking.com pays'));
  const memberFloor = b !== null ? bookingMemberFloor(b, bookingLabels) : null;

  if (cell.sellable === false) {
    return { severity: 'booked', issues: [], memberFloor, bookingFunded };
  }

  const issues: StayIssue[] = [];

  // MAJOR — same rules as the Telegram alerts.
  if (a !== null && b !== null && b > 0) {
    const gap = ((a - b) / b) * 100;
    if (Math.abs(gap) > AIRBNB_VS_BOOKING_TOLERANCE_PCT) {
      issues.push({
        severity: 'major',
        text: `Airbnb ${kc(a)} is ${Math.abs(gap).toFixed(0)}% ${gap < 0 ? 'below' : 'above'} Booking ${kc(b)} (tolerance ±${AIRBNB_VS_BOOKING_TOLERANCE_PCT}%)`,
      });
    }
  }
  if (w !== null && b !== null && w > b * 1.01) {
    issues.push({
      severity: 'major',
      text: `Our site ${kc(w)} is above Booking ${kc(b)}${bookingFunded ? ' — the Booking price includes a “Booking.com pays” discount funded by Booking, not by us' : ''}`,
    });
  }
  if (w !== null && a !== null && w > a * 1.01) {
    issues.push({ severity: 'major', text: `Our site ${kc(w)} is above Airbnb ${kc(a)}` });
  }

  // MINOR — the computed Genius/app price on Booking undercuts the direct site.
  if (w !== null && memberFloor !== null && memberFloor < w * 0.99 && !issues.some((i) => i.severity === 'major')) {
    issues.push({
      severity: 'minor',
      text: `A Genius/app customer pays ≈${kc(memberFloor)} on Booking — below our site ${kc(w)}`,
    });
  }

  if (issues.some((i) => i.severity === 'major')) {
    return { severity: 'major', issues, memberFloor, bookingFunded };
  }
  if (issues.length > 0) {
    return { severity: 'minor', issues, memberFloor, bookingFunded };
  }
  // Sellable per Beds24 but no channel observation yet (fresh config, or the
  // rotation has not reached this date) — visibly different from "all good".
  if (a === null && b === null) {
    return { severity: 'nodata', issues: [], memberFloor, bookingFunded };
  }
  return { severity: 'ok', issues: [], memberFloor, bookingFunded };
}

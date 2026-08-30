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

export type StaySeverity = 'booked' | 'restricted' | 'nodata' | 'ok' | 'minor' | 'major';

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

  // Open calendar, but a min-stay rule refuses this stay length — visually
  // distinct from booked (the room is NOT occupied; the rate setup is why
  // nothing sells). Channel prices should not exist here either; whatever was
  // captured still shows in the drawer.
  if (cell.web?.availability === 'restricted') {
    return { severity: 'restricted', issues: [], memberFloor, bookingFunded };
  }
  // A failed web lookup is UNKNOWN, not booked — fall through to no-data
  // rather than painting an occupied room.
  if (cell.web?.availability === 'error') {
    return { severity: 'nodata', issues: [], memberFloor, bookingFunded };
  }
  if (cell.sellable === false) {
    return { severity: 'booked', issues: [], memberFloor, bookingFunded };
  }

  const issues: StayIssue[] = [];

  // MAJOR — same rules as the Telegram alerts. Airbnb must sit INSIDE the
  // corridor between Booking's two real prices: no lower than the derived
  // Genius/app floor (Airbnb undercutting the baseline channel) and no higher
  // than the anonymous price plus tolerance (visibly dearer to a comparison
  // shopper). A single ± band around either price alone cannot work — the
  // floor sits ~19% under anonymous BY DESIGN, so anonymous-vs-anonymous
  // flagged every "Booking.com pays" date and floor-vs-anonymous would flag
  // every normal one.
  if (a !== null && b !== null && b > 0 && memberFloor !== null) {
    const tol = AIRBNB_VS_BOOKING_TOLERANCE_PCT / 100;
    if (a > b * (1 + tol)) {
      issues.push({
        severity: 'major',
        text: `Airbnb ${kc(a)} is ${(((a - b) / b) * 100).toFixed(0)}% above Booking's anonymous price ${kc(b)} (allowed +${AIRBNB_VS_BOOKING_TOLERANCE_PCT}%)`,
      });
    } else if (a < memberFloor * (1 - tol)) {
      issues.push({
        severity: 'major',
        text: `Airbnb ${kc(a)} is ${(((memberFloor - a) / memberFloor) * 100).toFixed(0)}% below even Booking's Genius/app price ${kc(memberFloor)} — Airbnb undercuts the baseline channel`,
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

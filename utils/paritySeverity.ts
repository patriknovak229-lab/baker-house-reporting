/**
 * Stay-level severity — one place that turns a board cell into the calendar
 * colour and the human-readable issue list the detail panel shows.
 *
 * Client-safe: pure functions over data, no env access. The comparison rules
 * come from the operator-editable config (utils/parityRules) — the SAME list
 * the ingest route uses for Telegram alerts, so the calendar and the pings
 * can never disagree. Severity 'minor' is view-only by design (the operator
 * wants to see it, not be pinged about it).
 */
import { bookingMemberFloor } from '@/data/parityConfig';
import {
  evaluateParityRules,
  ruleContextFromLabels,
  type ParityRule,
  type PriceKey,
} from '@/utils/parityRules';
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

export function assessStay(cell: BoardUnitCell, rules: ParityRule[]): StayAssessment {
  const bookingLabels = cell.booking?.labels ?? [];
  const bookingFunded = bookingLabels.some((l) => l.startsWith('Booking.com pays'));
  const b = cell.booking?.price ?? null;
  const memberFloor = b !== null ? bookingMemberFloor(b, bookingLabels) : null;

  const prices: Record<PriceKey, number | null> = {
    web: cell.web?.price ?? null,
    airbnb: cell.airbnb?.price ?? null,
    bookingAnon: b,
    bookingComputed: memberFloor,
  };

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

  const issues: StayIssue[] = evaluateParityRules(rules, prices, ruleContextFromLabels(bookingLabels)).map((f) => ({
    severity: f.rule.severity === 'major' ? 'major' : 'minor',
    text:
      f.text +
      (bookingFunded && (f.rule.left.startsWith('booking') || f.rule.right.startsWith('booking'))
        ? ' — the Booking price includes a “Booking.com pays” discount funded by Booking, not by us'
        : ''),
  }));

  if (issues.some((i) => i.severity === 'major')) {
    return { severity: 'major', issues, memberFloor, bookingFunded };
  }
  if (issues.length > 0) {
    return { severity: 'minor', issues, memberFloor, bookingFunded };
  }
  // Sellable per Beds24 but no channel observation yet (fresh config, or the
  // rotation has not reached this date) — visibly different from "all good".
  if (prices.airbnb === null && b === null) {
    return { severity: 'nodata', issues: [], memberFloor, bookingFunded };
  }
  return { severity: 'ok', issues: [], memberFloor, bookingFunded };
}

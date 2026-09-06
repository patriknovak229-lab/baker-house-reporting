/**
 * Stay shortening — the guest asks to cut a night off a booking that is
 * otherwise going ahead. Distinct from a non-arrival (guest doesn't come at
 * all, booking dies, we keep charging) and from a partial platform refund
 * (money back, dates untouched).
 *
 * The operator moves the dates here, the freed nights go back on sale, and the
 * price is adjusted by hand in Beds24 afterwards — Beds24 never recalculates a
 * booking's price when its dates change, which is exactly what we want: the
 * refund is negotiated with the guest, not derived from a rate.
 *
 * This module is the pure rule set, shared by the drawer (live preview) and
 * `POST /api/bookings/shorten` (which re-validates against LIVE Beds24 dates,
 * never the client's view).
 */

import { nightsBetween } from "./stayRequest";

export interface StaySpan {
  /** YYYY-MM-DD, first night. */
  arrival: string;
  /** YYYY-MM-DD, morning after the last night (exclusive). */
  departure: string;
}

export interface ShortenPlan {
  fromArrival: string;
  fromDeparture: string;
  toArrival: string;
  toDeparture: string;
  nightsBefore: number;
  nightsAfter: number;
  /** Nights trimmed off the start of the stay (guest arrives later). */
  nightsRemovedFront: number;
  /** Nights trimmed off the end of the stay (guest leaves earlier). */
  nightsRemovedBack: number;
  /** Total nights freed for resale. */
  nightsRemoved: number;
}

export type ShortenResult =
  | { ok: true; plan: ShortenPlan }
  | { ok: false; error: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value: string): boolean {
  return ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/**
 * Validate a proposed shortening and describe what it frees.
 *
 * `today` is Prague's date — the caller passes it in so this stays pure and
 * testable (and so the server can't be talked into a different "today").
 */
export function planShortening(
  current: StaySpan,
  next: StaySpan,
  opts: { today: string },
): ShortenResult {
  for (const d of [current.arrival, current.departure, next.arrival, next.departure]) {
    if (!isIsoDate(d)) return { ok: false, error: `Not a valid date: "${d}" (expected YYYY-MM-DD)` };
  }

  // Trim only. Extending a stay needs an availability check and a price the
  // guest agreed to — a different feature, deliberately not this one.
  if (next.arrival < current.arrival) {
    return {
      ok: false,
      error: `This only shortens a stay — the new check-in can't be before ${current.arrival}.`,
    };
  }
  if (next.departure > current.departure) {
    return {
      ok: false,
      error: `This only shortens a stay — the new check-out can't be after ${current.departure}.`,
    };
  }
  if (next.arrival >= next.departure) {
    return {
      ok: false,
      error: "A shortened stay has to keep at least one night. Use “Mark as non-arrival” to drop it entirely.",
    };
  }
  if (next.arrival === current.arrival && next.departure === current.departure) {
    return { ok: false, error: "Nothing to shorten — the dates are unchanged." };
  }

  // Once the guest is in the room, the arrival is history: moving it would
  // rewrite a night they actually slept in (and free it for someone else).
  // An in-house guest can still leave early, so the departure stays editable.
  if (current.arrival <= opts.today && next.arrival !== current.arrival) {
    return {
      ok: false,
      error: `The stay has already started (check-in ${current.arrival}) — only the check-out date can move.`,
    };
  }

  const nightsRemovedFront = nightsBetween(current.arrival, next.arrival);
  const nightsRemovedBack = nightsBetween(next.departure, current.departure);

  return {
    ok: true,
    plan: {
      fromArrival: current.arrival,
      fromDeparture: current.departure,
      toArrival: next.arrival,
      toDeparture: next.departure,
      nightsBefore: nightsBetween(current.arrival, current.departure),
      nightsAfter: nightsBetween(next.arrival, next.departure),
      nightsRemovedFront,
      nightsRemovedBack,
      nightsRemoved: nightsRemovedFront + nightsRemovedBack,
    },
  };
}

/** "1 night" / "2 nights" — used in confirmations, notices and the audit trail. */
export function nightsLabel(n: number): string {
  return `${n} night${n === 1 ? "" : "s"}`;
}

/** Human summary of what a plan does, e.g. "3 nights → 2 nights (1 night freed)". */
export function describeShortening(plan: ShortenPlan): string {
  const parts: string[] = [];
  if (plan.nightsRemovedFront > 0) parts.push(`${nightsLabel(plan.nightsRemovedFront)} off the start`);
  if (plan.nightsRemovedBack > 0) parts.push(`${nightsLabel(plan.nightsRemovedBack)} off the end`);
  return `${nightsLabel(plan.nightsBefore)} → ${nightsLabel(plan.nightsAfter)} (${parts.join(", ")})`;
}

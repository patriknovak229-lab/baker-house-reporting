import type { Issue } from "@/types/reservation";

/**
 * A web booking Beds24 saved WITH warnings, reported by the rental site.
 *
 * Beds24 answers `success: false` whenever a row has a warning, even when it
 * saved the booking next to the new id (BH-95579179, 2 Nov 2026: a
 * `status: invalid value` warning). The rental site now confirms such a
 * booking to the guest, and reports the warning here so someone checks it in
 * Beds24. Not urgent — the booking stands — so it is a Pending task on the
 * reservation, not a Telegram alert.
 */

/** One task per booking: a repeated report finds this id and adds nothing. */
export function webBookingWarningIssueId(bookingId: string): string {
  return `web-warning-${bookingId}`;
}

/** Beds24 booking ids are plain digits; anything else is not a booking we created. */
export function parseWebBookingId(raw: unknown): string | null {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  return /^\d{5,12}$/.test(s) ? s : null;
}

export function buildWebBookingWarningIssue(
  bookingId: string,
  warning: string,
  today: string,
  nowIso: string,
): Issue {
  const clean = warning.replace(/\s+/g, " ").trim().slice(0, 300) || "no detail given";
  return {
    id: webBookingWarningIssueId(bookingId),
    category: "problem",
    text: `Web booking saved with a Beds24 warning: "${clean}". The guest has their confirmation; check the booking in Beds24.`,
    actionableDate: today,
    resolved: false,
    createdAt: nowIso,
  };
}

/** Adds the task unless this booking already has one (resolved or not). */
export function appendWebBookingWarningIssue(existing: Issue[], issue: Issue): Issue[] | null {
  if (existing.some((i) => i.id === issue.id)) return null;
  return [...existing, issue];
}

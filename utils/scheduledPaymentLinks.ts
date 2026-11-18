/**
 * Decision engine for scheduled payment links — pure, so the daily cron is a
 * thin I/O shell around it (app/api/cron/send-scheduled-payments) and the
 * rules are unit-tested (scheduledPaymentLinks.test.ts).
 *
 * Operator's rules (2026-11-18):
 *  1. On the send day, re-check every booking. A direct booking waiting for
 *     payment is owed its FULL price; if what's owed differs from the
 *     scheduled amount (part-paid, price changed, cancelled…) do NOT send —
 *     alert in the app only (no Telegram). Extras (second parking…) are
 *     handled by hand.
 *  2. Link unpaid after a day → send ONE reminder with a fresh link. Reminder
 *     unpaid after another day → alert in the app AND Telegram to operations.
 *  3. Email only. No usable guest email → don't send; the operator uses
 *     Request Payment by hand.
 */
import type { ScheduledPaymentLink } from "@/types/scheduledPaymentLink";
import { isRelayEmail } from "@/utils/stayChains";

/** What the cron learned about one booking on the day, from Beds24 + our payments. */
export interface BookingFacts {
  reservationNumber: string;
  /** Beds24 returned the booking. */
  found: boolean;
  cancelled: boolean;
  /** Current Beds24 total; null when unknown. */
  price: number | null;
  /** Already paid: Beds24 deposit + payment links (net of refunds), excluding THIS schedule's own link. */
  paidCzk: number;
}

export type ScheduledLinkStep =
  | { kind: "wait" }
  | { kind: "send" }
  | { kind: "remind" }
  | { kind: "mark-paid" }
  | { kind: "block"; reason: string }
  | { kind: "overdue"; reason: string };

/** 1 Kč tolerance, like utils/paymentReconcile decideStatus (haléř drift). */
const TOLERANCE_CZK = 1;

const kc = (n: number) => `${Math.round(n).toLocaleString("cs-CZ")} Kč`;

/**
 * Why this link must NOT go out today, or null when it may.
 * Called on the send day and again before the reminder.
 *
 * `link.allocations` holds the amount scheduled per booking; `bookings` has
 * one BookingFacts per allocation (same order). Use TOLERANCE_CZK for amount
 * comparisons and `kc()` to format amounts in the reason (operator-facing).
 */
export function blockReason(link: ScheduledPaymentLink, bookings: BookingFacts[]): string | null {
  // Rule 3 — email only; anything else is the operator's Request Payment.
  if (!link.guestEmail.trim() || isRelayEmail(link.guestEmail)) {
    return "No usable guest email (missing, or a Booking.com/Airbnb relay address) — send the link yourself with Request Payment";
  }
  // Rule 1 — every booking must still owe exactly what was scheduled, its full price.
  // Checks run most-decisive first; only the first reason is shown.
  for (const b of bookings) {
    const rn = b.reservationNumber;
    const scheduled = link.allocations.find((a) => a.reservationNumber === rn)?.amountCzk ?? 0;
    if (!b.found) return `${rn}: booking not found in Beds24`;
    if (b.cancelled) return `${rn}: booking is cancelled`;
    if (b.price === null) return `${rn}: booking total is missing in Beds24`;
    if (b.paidCzk > TOLERANCE_CZK) {
      return `${rn}: ${kc(b.paidCzk)} of ${kc(b.price)} already paid — send what's left yourself with Request Payment`;
    }
    if (Math.abs(b.price - scheduled) > TOLERANCE_CZK) {
      return `${rn}: booking total is now ${kc(b.price)}, but ${kc(scheduled)} was scheduled — check the price and reschedule`;
    }
  }
  return null;
}

/** Prague calendar date of an ISO timestamp. */
export function pragueDateOf(isoTs: string): string {
  return new Date(isoTs).toLocaleDateString("sv-SE", { timeZone: "Europe/Prague" });
}

/**
 * The one thing to do with a link on this run.
 *
 * @param paymentPaid the link's current AdditionalPayment has been paid
 * @param today Prague YYYY-MM-DD
 */
export function nextStep(
  link: ScheduledPaymentLink,
  bookings: BookingFacts[],
  paymentPaid: boolean,
  today: string,
): ScheduledLinkStep {
  switch (link.status) {
    case "scheduled": {
      if (link.sendDate > today) return { kind: "wait" };
      const reason = blockReason(link, bookings);
      return reason ? { kind: "block", reason } : { kind: "send" };
    }
    case "sent": {
      if (paymentPaid) return { kind: "mark-paid" };
      // A link lives 23 h; the cron runs once a day, so "a later Prague day" = expired.
      if (!link.sentAt || pragueDateOf(link.sentAt) >= today) return { kind: "wait" };
      const reason = blockReason(link, bookings);
      return reason ? { kind: "block", reason: `Reminder not sent — ${reason}` } : { kind: "remind" };
    }
    case "reminded": {
      if (paymentPaid) return { kind: "mark-paid" };
      if (!link.reminderSentAt || pragueDateOf(link.reminderSentAt) >= today) return { kind: "wait" };
      return { kind: "overdue", reason: "Not paid after the link and one reminder" };
    }
    default:
      return { kind: "wait" };
  }
}

/** Statuses the cron still works on. */
export function isLive(link: ScheduledPaymentLink): boolean {
  return link.status === "scheduled" || link.status === "sent" || link.status === "reminded";
}

import type { PaymentAllocation } from "./additionalPayment";

/**
 * A payment link the operator scheduled to be emailed on a later date.
 * Stripe Checkout sessions die after 23 h, so only the intent is stored; the
 * daily cron (/api/cron/send-scheduled-payments) creates the link on the day.
 *
 * Lifecycle (utils/scheduledPaymentLinks.ts decides each step):
 *   scheduled ─ send day, checks pass ─→ sent ─ next day, unpaid ─→ reminded ─ next day, unpaid ─→ unpaid ⚠
 *       │                                 └──────────── paid (any time) ──────────→ paid
 *       └─ send day, checks fail ─→ blocked ⚠          (operator) ─→ cancelled
 * ⚠ = shown to the operator in the app until dismissed; `unpaid` also goes to
 * the operations Telegram group. `failed` ⚠ = technical errors on 3 runs.
 */
export type ScheduledLinkStatus =
  | "scheduled"
  | "sent"
  | "reminded"
  | "paid"
  | "blocked"
  | "unpaid"
  | "failed"
  | "cancelled";

/** Statuses that need the operator — shown in the Transactions alert pill. */
export const SCHEDULED_LINK_ALERT_STATUSES: ScheduledLinkStatus[] = ["blocked", "unpaid", "failed"];

export interface ScheduledPaymentLink {
  id: string;
  /** First booking of the payment — the one it is filed under. */
  reservationNumber: string;
  /** Every booking it covers with its amount (one entry for a single booking). */
  allocations: PaymentAllocation[];
  amountCzk: number;
  description: string;
  isMainPayment: boolean;
  /** Prague date (YYYY-MM-DD) the first email goes out. */
  sendDate: string;
  guestEmail: string;
  guestName?: string;
  guestPhone?: string;
  status: ScheduledLinkStatus;
  /** The AdditionalPayment (= current Stripe session) id once a link exists. */
  paymentId?: string;
  sentAt?: string;
  reminderSentAt?: string;
  /** Why it needs the operator (blocked / unpaid / failed). */
  alertReason?: string;
  alertAt?: string;
  /** Operator acknowledged the alert — hides it from the pill. */
  dismissedAt?: string;
  failureCount?: number;
  createdAt: string;
  createdBy?: string;
}

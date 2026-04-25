/**
 * A scheduled split payment — represents one part of a multi-payment booking.
 *
 * Lifecycle:
 *   1. Created with status="scheduled" when the operator submits the booking with split payments enabled.
 *      For immediate payments (sendDate === today), the API immediately mints a Stripe Checkout
 *      session and flips status to "sent" within the same request.
 *   2. The daily cron (/api/cron/send-scheduled-payments) finds rows where status="scheduled"
 *      and sendDate <= today, mints a Stripe session, emails the link to the guest, and flips
 *      status to "sent". On error: status stays "scheduled" with failureReason set; retried next run.
 *   3. Once status="sent" we ALSO create a parallel AdditionalPayment record keyed by stripeSessionId,
 *      which is what the Stripe webhook updates to "paid". The SplitPayment record itself is
 *      historical/scheduling only and is not updated past the "sent" state.
 *
 * Stripe Checkout sessions expire 24h after creation, so we cannot pre-mint links for future dates.
 * That's why scheduled rows store only intent (amount, sendDate) and create the Stripe session on the fly.
 */

export type SplitPaymentStatus = "scheduled" | "sent" | "failed";

export interface SplitPayment {
  id: string;                    // generated UUID, stable
  reservationNumber: string;
  paymentNumber: number;         // 1-indexed (1, 2, 3)
  totalPayments: number;         // total in this split (2 or 3)
  description: string;           // e.g. "Baker House — reservation BH-12345 — Payment 2 of 3"
  amountCzk: number;
  sendDate: string;              // YYYY-MM-DD — when to email link to guest
  guestEmail?: string;
  guestName?: string;
  guestPhone?: string;
  status: SplitPaymentStatus;
  stripeSessionId?: string;      // populated when status = "sent"
  sentAt?: string;               // ISO timestamp when link was sent/created
  failureReason?: string;        // populated on failure (status stays "scheduled" — cron retries)
  failureCount?: number;         // number of failed send attempts
  createdAt: string;             // ISO timestamp
}

export type AdditionalPaymentStatus =
  | "unpaid"
  | "paid"
  | "partially-refunded"  // some money returned, some kept (paid - refunded > 0)
  | "refunded";            // fully refunded (paid - refunded === 0)

/**
 * A single refund event against a paid AdditionalPayment. One payment can
 * accumulate multiple partial refunds — sum to determine remaining balance.
 * The Stripe refund object is the source of truth; this is our local mirror
 * kept in sync via the charge.refunded webhook.
 */
export interface PaymentRefund {
  /** Stripe refund id (re_…) — unique key. */
  id: string;
  /** Amount in CZK that was returned to the guest. Always positive. */
  amountCzk: number;
  /** ISO timestamp Stripe reported the refund created at. */
  refundedAt: string;
  /** Free-text note the operator entered when initiating (optional). */
  reason?: string;
  /** Operator email from the auth session when initiated via our app.
   *  Empty when the refund was issued from the Stripe dashboard directly. */
  refundedBy?: string;
  /** Mirrors Stripe's refund.status. Most refunds go pending → succeeded
   *  within seconds; failed is rare but possible (e.g. closed card account). */
  status: 'pending' | 'succeeded' | 'failed' | 'canceled';
  /** Stripe's failure_reason when status === 'failed'. */
  failureReason?: string;
}

export interface AdditionalPayment {
  id: string;               // Stripe sessionId — unique key
  reservationNumber: string;
  description: string;
  amountCzk: number;
  guestEmail?: string;
  guestName?: string;
  status: AdditionalPaymentStatus;
  createdAt: string;        // ISO timestamp
  paidAt?: string;          // ISO timestamp — set by webhook on payment
  invoiceId?: string;       // revenue invoice id — set after auto-create
  /**
   * Stripe processing fee in CZK for this specific payment (Stripe charges
   * a percentage + fixed fee per transaction). Pulled from the BalanceTransaction
   * linked to the Charge after settlement. Aggregated up to
   * Reservation.paymentChargeAmount in TransactionsPage so it shows in the
   * existing PaymentBreakdown like OTA payment-charge fees.
   */
  stripeFeeCzk?: number;
  /**
   * When true, this payment covers the main booking cost (e.g. a phone
   * reservation paid via Stripe link). Displayed differently from additional
   * service charges — shown inline in the Payment section rather than the
   * "Additional Payments" sub-list.
   */
  isMainPayment?: boolean;
  /**
   * Refund history. Empty/undefined for unrefunded payments. Synced
   * automatically from Stripe via the charge.refunded webhook so both
   * app-initiated AND dashboard-initiated refunds stay in sync.
   */
  refunds?: PaymentRefund[];
}

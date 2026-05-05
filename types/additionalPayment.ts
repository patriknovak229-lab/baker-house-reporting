export type AdditionalPaymentStatus = "unpaid" | "paid";

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
}

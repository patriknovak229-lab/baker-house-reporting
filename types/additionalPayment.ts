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
}

export type RevenueInvoiceSource   = 'issued' | 'manual';
export type RevenueInvoiceCategory = 'accommodation_direct' | 'other_services' | 'mistake';
export type RevenueInvoiceStatus   = 'pending' | 'reconciled';

export interface RevenueInvoice {
  id: string;
  sourceType: RevenueInvoiceSource;
  category: RevenueInvoiceCategory;
  status: RevenueInvoiceStatus;
  invoiceNumber: string;       // e.g. INV-2026-001
  invoiceDate: string;         // YYYY-MM-DD
  amountCZK: number;

  // issued source (from Transactions tab)
  reservationNumber?: string;
  guestName?: string;

  // manual source
  clientName?: string;
  description?: string;

  // bank reconciliation
  bankTransactionId?: string;
  reconciledAt?: string;       // ISO timestamp

  createdAt: string;           // ISO timestamp
}

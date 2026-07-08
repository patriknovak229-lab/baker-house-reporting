export type RevenueInvoiceSource   = 'issued' | 'manual' | 'ota';
/** 'ota_gross' = gross booking volume auto-created from an OTA settlement (Airbnb/Booking) */
export type RevenueInvoiceCategory = 'accommodation_direct' | 'other_services' | 'ota_gross' | 'mistake';
export type RevenueInvoiceStatus   = 'pending' | 'reconciled';

export interface RevenueInvoice {
  id: string;
  sourceType: RevenueInvoiceSource;
  category: RevenueInvoiceCategory;
  status: RevenueInvoiceStatus;
  invoiceNumber: string;       // e.g. INV-2026-001
  invoiceDate: string;         // YYYY-MM-DD
  dueDate?: string;            // YYYY-MM-DD; falls back to invoiceDate when not set
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
  /** SettlementGroup.id — set for OTA gross records auto-created from a settlement report */
  settlementGroupId?: string;

  // Google Drive (manual uploads)
  driveFileId?: string;
  driveFileName?: string;
  driveUrl?: string;

  createdAt: string;           // ISO timestamp
}

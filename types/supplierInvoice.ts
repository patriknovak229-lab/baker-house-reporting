/** Category is now a dynamic string — managed via the categories API */
export type SupplierInvoiceCategory = string;

/** A user-defined invoice category stored in Redis */
export interface InvoiceCategory {
  id: string;
  label: string;
}

export type SupplierInvoiceStatus = 'pending' | 'reconciled';

export type SupplierInvoiceSource = 'email' | 'upload' | 'manual';

export interface SupplierInvoice {
  id: string;
  supplierName: string;
  supplierICO?: string;
  invoiceNumber: string;
  invoiceDate: string;       // YYYY-MM-DD
  dueDate?: string;          // YYYY-MM-DD
  amountCZK: number;
  vatAmountCZK?: number;
  category: SupplierInvoiceCategory;
  rooms?: string[];          // e.g. ['K.201', 'K.202']
  description?: string;
  status: SupplierInvoiceStatus;
  sourceType: SupplierInvoiceSource;
  driveFileId?: string;
  driveFileName?: string;
  driveUrl?: string;
  gmailMessageId?: string;   // prevents duplicate import
  createdAt: string;         // ISO timestamp
  // Phase 2 — bank reconciliation (unused in Phase 1)
  bankTransactionId?: string;
  reconciledAt?: string;
}

/** Shape returned by the Claude extraction endpoint */
export interface ExtractedInvoiceData {
  supplierName: string | null;
  supplierICO: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;   // YYYY-MM-DD
  dueDate: string | null;
  amountCZK: number | null;
  vatAmountCZK: number | null;
  suggestedCategory: string | null;
}

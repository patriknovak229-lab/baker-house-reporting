/** Category is now a dynamic string — managed via the categories API */
export type SupplierInvoiceCategory = string;

/** A user-defined invoice category stored in Redis */
export interface InvoiceCategory {
  id: string;
  label: string;
  color: string; // background hex, e.g. '#DBEAFE' — paired text colour via textColorFor()
}

/** A whitelisted supplier — invoices from this supplier are auto-processed */
export interface WhitelistedSupplier {
  id: string;
  supplierName: string;  // matched case-insensitively against extracted supplierName
  category: string;      // applied automatically on save
  addedAt: string;       // ISO timestamp
}

export type SupplierInvoiceStatus = 'pending' | 'reconciled';

export type SupplierInvoiceSource = 'email' | 'upload' | 'portal' | 'manual';

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
  autoProcessed?: boolean;   // true when saved automatically via whitelist
  createdAt: string;         // ISO timestamp
  invoiceCurrency?: string;      // e.g. 'USD', 'EUR' — absent or 'CZK' means CZK
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
  amountCZK: number | null;     // amount in the invoice's original currency (may not be CZK)
  vatAmountCZK: number | null;
  invoiceCurrency: string | null; // e.g. 'CZK', 'USD', 'EUR'
  suggestedCategory: string | null;
}

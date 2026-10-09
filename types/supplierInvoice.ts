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
  supplierICO?: string;  // matched against extracted IČO — robust to name OCR variance
  category: string;      // applied automatically on save
  addedAt: string;       // ISO timestamp
}

export type SupplierInvoiceStatus = 'pending' | 'reconciled' | 'review_needed';

export type SupplierInvoiceSource = 'email' | 'upload' | 'portal' | 'manual' | 'drive';

/** 'credit_note' = dobropis / opravný daňový doklad — stored with NEGATIVE amounts. Absent = invoice. */
export type SupplierDocumentType = 'invoice' | 'credit_note';

export interface SupplierInvoice {
  id: string;
  supplierName: string;
  supplierICO?: string;
  invoiceNumber: string;
  invoiceDate: string;       // YYYY-MM-DD
  /** DUZP / taxable-supply date (YYYY-MM-DD). Preferred over invoiceDate for accrual periodization. */
  duzpDate?: string;
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
  gmailMessageId?: string;   // prevents duplicate Gmail import
  icloudFileName?: string;   // prevents duplicate iCloud folder import (legacy — iCloud source retired)
  /** Drive file ID of the source file in the inbox — prevents duplicate Drive-folder import */
  driveSourceFileId?: string;
  autoProcessed?: boolean;   // true when saved automatically via whitelist
  createdAt: string;         // ISO timestamp
  invoiceCurrency?: string;      // e.g. 'USD', 'EUR' — absent or 'CZK' means CZK
  /** Absent = 'invoice'. Credit notes carry negative amountCZK / vatAmountCZK. */
  documentType?: SupplierDocumentType;
  /** Credit notes: the original invoice number as printed on the dobropis */
  originalInvoiceNumber?: string;
  /** Credit notes: id of the original SupplierInvoice (several credit notes may point at one invoice) */
  relatedInvoiceId?: string;
  // Phase 2 — bank reconciliation (unused in Phase 1)
  bankTransactionId?: string;
  reconciledAt?: string;
  /** For OTA net-settlement: IDs of credit bank transactions that collectively cover this invoice */
  settlementTransactionIds?: string[];
  /** SettlementGroup.id — set when this invoice is attached to a settlement group */
  settlementGroupId?: string;
}

/** A single fee row extracted from a multi-reservation fee statement (e.g. Airbnb monthly) */
export interface ExtractedLineItem {
  description: string;  // reservation ref or guest name
  amount: number;       // fee for that row
}

/** One row of the document's VAT recap ("Rekapitulace DPH" / "Přehled DPH") */
export interface ExtractedVatRow {
  rate: number;          // percent, e.g. 21
  base: number | null;   // amount without VAT
  vat: number | null;
}

/** Shape returned by the Claude extraction endpoint */
export interface ExtractedInvoiceData {
  supplierName: string | null;
  supplierICO: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;   // YYYY-MM-DD
  /** DUZP / taxable-supply date when printed separately from the issue date */
  duzpDate?: string | null;
  dueDate: string | null;
  amountCZK: number | null;     // amount in the invoice's original currency (may not be CZK); negative for credit notes
  vatAmountCZK: number | null;  // negative for credit notes
  invoiceCurrency: string | null; // e.g. 'CZK', 'USD', 'EUR'
  suggestedCategory: string | null;
  /** Per-reservation fee rows from multi-row fee statements; null for single-total invoices */
  lineItems?: ExtractedLineItem[] | null;
  documentType?: SupplierDocumentType;
  /** Credit notes: the original invoice number printed on the dobropis */
  originalInvoiceNumber?: string | null;
  vatBreakdown?: ExtractedVatRow[] | null;
  /** Set when the supplier matched utils/supplierRegistry — name, IČO and category are then authoritative */
  knownSupplierId?: string | null;
}

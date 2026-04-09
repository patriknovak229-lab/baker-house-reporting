export type BankTransactionDirection = 'debit' | 'credit';

export type BankTransactionState =
  | 'unmatched'      // outgoing, not yet linked to a supplier invoice
  | 'reconciled'     // linked to a SupplierInvoice
  | 'ignored'        // tagged as non-invoice cost (salary, tax, etc.)
  | 'non_deductible' // cost that does not qualify for tax deduction / receipt lost
  | 'revenue'        // incoming payment — not yet categorised
  | 'refund'          // incoming payment that fully refunds a prior debit
  | 'partial_refund'  // incoming payment that partially refunds a prior debit
  | 'net_settlement'; // incoming payment where OTA/platform deducted fees before remitting

export const IGNORE_CATEGORIES = [
  { id: 'salary',   label: 'Salary / wages' },
  { id: 'tax',      label: 'Tax / social / health insurance' },
  { id: 'rent',     label: 'Rent / lease' },
  { id: 'transfer', label: 'Account transfer' },
  { id: 'other',    label: 'Other' },
] as const;

export type IgnoreCategoryId = typeof IGNORE_CATEGORIES[number]['id'];

export interface BankTransaction {
  /** Deterministic ID derived from date, amount, direction, counterparty account, and VS */
  id: string;
  date: string;          // YYYY-MM-DD
  valueDate?: string;    // YYYY-MM-DD
  /** Always positive — use `direction` to determine in/out */
  amount: number;
  direction: BankTransactionDirection;
  currency: string;
  counterpartyAccount?: string;
  counterpartyName?: string;
  variableSymbol?: string;
  constantSymbol?: string;
  specificSymbol?: string;
  description?: string;
  myDescription?: string;
  transactionType?: string;
  /** Original amount before currency conversion (set when transaction was in a foreign currency) */
  originalAmount?: number;
  /** Original currency code, e.g. 'USD', 'EUR' (set when different from account currency) */
  originalCurrency?: string;
  state: BankTransactionState;
  /** SupplierInvoice.id — set when state === 'reconciled' */
  invoiceId?: string;
  /** BankTransaction.id of the debit being refunded — set when state === 'refund' | 'partial_refund' */
  linkedTransactionId?: string;
  /** Total guest-facing amount before OTA deducted fees — set when state === 'net_settlement' */
  grossAmount?: number;
  /** SupplierInvoice ids deducted from this settlement — set when state === 'net_settlement' */
  deductedInvoiceIds?: string[];
  /** RevenueInvoice.id — set when this credit is linked to a revenue invoice */
  revenueInvoiceId?: string;
  /** IGNORE_CATEGORIES id — set when state === 'ignored' */
  ignoreCategory?: IgnoreCategoryId;
  ignoreNote?: string;
  reconciledAt?: string;  // ISO timestamp
  ignoredAt?: string;     // ISO timestamp
  importedAt: string;     // ISO timestamp
}

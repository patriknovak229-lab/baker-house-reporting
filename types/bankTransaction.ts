export type BankTransactionDirection = 'debit' | 'credit';

export type BankTransactionState =
  | 'unmatched'   // outgoing, not yet linked to a supplier invoice
  | 'reconciled'  // linked to a SupplierInvoice
  | 'ignored'     // tagged as non-invoice cost (salary, tax, etc.)
  | 'revenue';    // incoming payment — reserved for Phase 3

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
  state: BankTransactionState;
  /** SupplierInvoice.id — set when state === 'reconciled' */
  invoiceId?: string;
  /** IGNORE_CATEGORIES id — set when state === 'ignored' */
  ignoreCategory?: IgnoreCategoryId;
  ignoreNote?: string;
  reconciledAt?: string;  // ISO timestamp
  ignoredAt?: string;     // ISO timestamp
  importedAt: string;     // ISO timestamp
}

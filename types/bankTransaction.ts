export type BankTransactionDirection = 'debit' | 'credit';

export type BankTransactionState =
  | 'unmatched'      // outgoing, not yet linked to a supplier invoice
  | 'reconciled'     // linked to a SupplierInvoice
  | 'recurring_cost' // contractual/standing-order cost with no invoice (rent, parking) — counts in P&L
  | 'ignored'        // tagged as non-invoice, non-cost (transfer, etc.) — excluded from P&L
  | 'non_deductible' // cost that does not qualify for tax deduction / receipt lost
  | 'revenue'        // incoming payment — not yet categorised
  | 'refund'          // incoming payment that fully refunds a prior debit
  | 'partial_refund'  // incoming payment that partially refunds a prior debit
  | 'net_settlement' // incoming payment where OTA/platform deducted fees before remitting
  | 'grouped';       // credit transaction is part of a named settlement group

export const IGNORE_CATEGORIES = [
  { id: 'salary',   label: 'Salary / wages' },
  { id: 'tax',      label: 'Tax / social / health insurance' },
  { id: 'rent',     label: 'Rent / lease' },
  { id: 'transfer', label: 'Account transfer' },
  { id: 'other',    label: 'Other' },
] as const;

export type IgnoreCategoryId = typeof IGNORE_CATEGORIES[number]['id'];

/**
 * Categories for `recurring_cost` — contractual payments that have no supplier
 * invoice but are real, deductible costs (e.g. rent to owners, parking lease).
 * All currently map to the P&L "Ostatní provozní náklady" (other operating) section.
 */
export const RECURRING_COST_CATEGORIES = [
  { id: 'rent',    label: 'Rent / lease' },
  { id: 'parking', label: 'Parking' },
  { id: 'other',   label: 'Other' },
] as const;

export type RecurringCostCategoryId = typeof RECURRING_COST_CATEGORIES[number]['id'];

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
  /** SupplierInvoice.id — set when state === 'reconciled'. For a single-invoice
   *  match this is the invoice; for a multi-invoice match it mirrors invoiceIds[0]
   *  (kept for backward compatibility with readers that expect one id). */
  invoiceId?: string;
  /** SupplierInvoice.ids — set when state === 'reconciled' and one payment covers
   *  several invoices (e.g. an order split into multiple deliveries/invoices). */
  invoiceIds?: string[];
  /** BankTransaction.id of the debit being refunded — set when state === 'refund' | 'partial_refund' */
  linkedTransactionId?: string;
  /** Total guest-facing amount before OTA deducted fees — set when state === 'net_settlement' */
  grossAmount?: number;
  /** SupplierInvoice ids deducted from this settlement — set when state === 'net_settlement' */
  deductedInvoiceIds?: string[];
  /** RevenueInvoice.id — set when this credit is linked to a revenue invoice */
  revenueInvoiceId?: string;
  /** CommissionSettlement.id — set when this debit is the owner payout matching
   *  a commission settlement. Purely a record-keeping link; does NOT change the
   *  transaction's `state` or its P&L treatment. */
  commissionSettlementId?: string;
  /** SettlementGroup.id — set when state === 'grouped' */
  settlementGroupId?: string;
  /** IGNORE_CATEGORIES id — set when state === 'ignored' */
  ignoreCategory?: IgnoreCategoryId;
  ignoreNote?: string;
  /** RECURRING_COST_CATEGORIES id — set when state === 'recurring_cost' */
  costCategory?: RecurringCostCategoryId;
  /** Free note for a recurring cost — set when state === 'recurring_cost' */
  costNote?: string;
  /** true when the user dismissed the auto-suggested invoice match ("not a match") — hides the list hint */
  suggestionDismissed?: boolean;
  reconciledAt?: string;  // ISO timestamp
  ignoredAt?: string;     // ISO timestamp
  importedAt: string;     // ISO timestamp
}

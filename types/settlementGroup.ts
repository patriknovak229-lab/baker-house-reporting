export interface SettlementGroup {
  id: string;               // uuid
  name: string;             // user-defined, e.g. "Airbnb April 2026"
  transactionIds: string[]; // BankTransaction IDs (credits)
  invoiceIds: string[];     // SupplierInvoice IDs attached to the group
  createdAt: string;        // ISO timestamp
}

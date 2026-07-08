/** Which OTA / channel an earnings-report settlement is from */
export type SettlementSource = 'airbnb' | 'booking' | 'other';

export interface SettlementGroup {
  id: string;               // uuid
  name: string;             // user-defined, e.g. "Airbnb May 2026"
  transactionIds: string[]; // BankTransaction IDs (credits) — the payouts that settle this report
  invoiceIds: string[];     // SupplierInvoice IDs attached to the group
  createdAt: string;        // ISO timestamp

  // ─── OTA earnings-report data (revenue-side settlements) ──────────────────
  // Present when the group was created from an uploaded OTA earnings report.
  // These drive accrual P&L: gross → revenue, commission → cost, dated by period.

  /** Which OTA the settlement is from */
  source?: SettlementSource;
  /** Reporting period the settlement COVERS (accrual basis, independent of payout date) — YYYY-MM-DD */
  periodStart?: string;
  periodEnd?: string;
  /** Gross earnings (guest-facing booking volume) before OTA fees — booked as revenue (line I.) */
  grossAmount?: number;
  /** OTA service fee / commission deducted before remitting — booked as a cost (A. Výkonová spotřeba) */
  commissionAmount?: number;
  /** Net payout total (= gross − commission) that reaches the bank across all transactionIds */
  netAmount?: number;
  /** Adjustments line from the report summary (reservation changes, cancellations) — optional */
  adjustmentsAmount?: number;
  /** Tax withheld line from the report summary — optional */
  taxWithheld?: number;
  /** Google Drive copy of the uploaded earnings/settlement report */
  reportFileId?: string;
  reportFileName?: string;
  reportUrl?: string;
  /** RevenueInvoice.id auto-created for the gross booking volume (the cost record is in invoiceIds) */
  revenueInvoiceId?: string;
}

/** A group that carries OTA earnings-report data (created from an uploaded report) */
export function isReportSettlement(g: SettlementGroup): boolean {
  return !!g.source || g.grossAmount != null;
}

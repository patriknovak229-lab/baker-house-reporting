/**
 * VAT (DPH) section — shared types for the engine, the API routes and the UI.
 *
 * All money is integer haléře (`Hal`) — see utils/vat/money.ts. The VAT return
 * (DPHDP3) rows are whole crowns, as filed.
 */
import type { Hal } from '@/utils/vat/money';

export type { Hal };

/** 'live' = the company is a VAT payer for (part of) the month; 'simulation' = a what-if before registration. */
export type VatMode = 'simulation' | 'live';
export type VatSeverity = 'error' | 'warning' | 'info';

/** Company + filing identity used in the XML headers (VetaD / VetaP). */
export interface VatConfig {
  /** ISO date the company became a VAT payer. null → every month is a simulation. */
  payerFrom: string | null;
  /** DIČ digits without the "CZ" prefix. */
  dic: string;
  companyName: string;
  street: string;
  houseNumber: string;
  orientationNumber: string;
  city: string;
  zip: string;
  /** Country name as the EPO code list spells it. */
  country: string;
  /** Finanční úřad code (461 = FÚ pro Jihomoravský kraj). */
  cUfo: string;
  /** Územní pracoviště code (3003 = Brno III). */
  cPracufo: string;
  /** Main activity CZ-NACE (6 digits) for the VAT return header. */
  okec: string;
  /** Person signing for the company (jednatel). */
  signerFirstName: string;
  signerLastName: string;
  signerPosition: string;
  /** Person who prepared the filing (contact for the tax office). */
  compilerFirstName: string;
  compilerLastName: string;
  compilerPhone: string;
  email: string;
}

/** A Booking.com / Airbnb tax document (commission invoice / VAT invoice) entered by hand. */
export interface OtaTaxDocument {
  number: string;
  /** ISO date of the taxable supply printed on the document. */
  date: string;
  /** Amount WITHOUT VAT, in haléře (reverse-charge base). */
  amountHal: Hal;
}

export type VatDecision = 'merge' | 'separate' | 'include' | 'exclude';

export interface VatSettings {
  config: VatConfig;
  /** settlementGroupId → the OTA's own tax documents for that settlement. */
  otaDocuments: Record<string, OtaTaxDocument[]>;
  /** Flag decision key → the operator's choice (overrides the default). */
  decisions: Record<string, VatDecision>;
  updatedAt?: string;
  updatedBy?: string;
}

export interface VatRateTotals {
  base21Hal: Hal;
  vat21Hal: Hal;
  base12Hal: Hal;
  vat12Hal: Hal;
}

export type RevenueSource = 'booking' | 'airbnb' | 'ota_other' | 'invoice' | 'stripe' | 'refund';

/** One revenue item (accommodation sale) and how it is taxed. */
export interface VatRevenueLine {
  id: string;
  source: RevenueSource;
  label: string;
  /** Document / payment reference (invoice number, Stripe session, settlement name). */
  ref: string;
  reservationNumber?: string;
  /** The date the VAT obligation arises for this item. */
  taxPoint: string;
  /** Why that date (shown to the user and the accountant). */
  taxPointRule: string;
  ratePct: 12 | 21;
  grossHal: Hal;
  baseHal: Hal;
  vatHal: Hal;
  section: 'A.4' | 'A.5';
  note?: string;
}

export type A2Kind = 'goods_eu' | 'services_eu' | 'services_non_eu';

/** A purchase from a foreign supplier where WE self-assess the VAT (KH A.2). */
export interface VatA2Row {
  id: string;
  supplier: string;
  /** ISO country code for the VAT ID (k_stat); null for non-EU suppliers. */
  countryCode: string | null;
  /** VAT ID without the country prefix (vatid_dod); null when there is none. */
  vatId: string | null;
  /** Supplier's own document number; null = not entered yet (placeholder in the KH). */
  documentNumber: string | null;
  /** Date the obligation to declare tax arose (DPPD). */
  dppd: string;
  currency: string;
  /** Net amount in the invoice currency's minor units (cents). */
  originalMinor: number;
  /** ČNB rate used (CZK per `fxUnit` units), null for CZK. */
  fxRate: number | null;
  fxUnit: number;
  fxFixingDate: string | null;
  baseHal: Hal;
  vatHal: Hal;
  kind: A2Kind;
  /** VAT return row: 3 = goods from the EU, 5 = services from the EU, 12 = other (non-EU). */
  dapRow: 3 | 5 | 12;
  source: 'ota_settlement' | 'ota_document' | 'supplier_invoice';
  /** VAT the supplier charged on top (not deductible — means they don't have our VAT ID). */
  foreignVatChargedHal: Hal;
  supplierInvoiceId?: string;
  settlementGroupId?: string;
  /** OTA rows: the reverse-charge base according to the settlement report (for comparison with entered documents). */
  settlementExpectedHal?: Hal;
  note?: string;
}

/** A domestic purchase with Czech VAT (KH B.2 if > 10 000 Kč incl. VAT, else part of the B.3 total). */
export interface VatPurchaseDoc {
  id: string;
  supplier: string;
  ico: string | null;
  documentNumber: string;
  date: string;
  category: string;
  totalHal: Hal;
  base21Hal: Hal;
  vat21Hal: Hal;
  base12Hal: Hal;
  vat12Hal: Hal;
  creditNote: boolean;
  section: 'B.2' | 'B.3';
  /** True when the rate split was derived from the totals (no saved breakdown). */
  splitDerived: boolean;
}

export type ExcludedReason =
  | 'no_vat'
  | 'marketplace'
  | 'legacy_ota'
  | 'fx_missing'
  | 'split_missing'
  | 'unknown_supplier'
  | 'non_eu_goods'
  | 'duplicate';

/** A supplier document in the month that does NOT enter the VAT return — and why. */
export interface VatExcludedDoc {
  id: string;
  supplier: string;
  documentNumber: string;
  date: string;
  totalHal: Hal;
  vatHal: Hal;
  currency: string;
  reason: ExcludedReason;
  reasonLabel: string;
}

/** One row of the VAT return (přiznání k DPH), whole crowns. */
export interface VatDapRow {
  row: string;
  label: string;
  baseCzk: number | null;
  taxCzk: number | null;
}

export type DapValueKey =
  | 'r1b' | 'r1t' | 'r2b' | 'r2t' | 'r3b' | 'r3t' | 'r5b' | 'r5t' | 'r12b' | 'r12t'
  | 'r40b' | 'r40t' | 'r41b' | 'r41t' | 'r43b' | 'r43t' | 'r46' | 'r62' | 'r63' | 'r64' | 'r65';

/** Control statement section C (kontrolní řádky), haléře. */
export interface VatKhC {
  obrat23: Hal;
  obrat5: Hal;
  pln23: Hal;
  pln5: Hal;
  rezPren23: Hal;
  rezPren5: Hal;
  plnRezPren: Hal;
  celkZdA2: Hal;
}

export interface VatFlagItem {
  label: string;
  detail?: string;
  amountHal?: Hal;
  date?: string;
  /** Settings key for an operator decision on this item. */
  decisionKey?: string;
  /** The decision currently applied (default or chosen). */
  decision?: VatDecision;
  /** Whether `decision` was chosen by the operator (vs. the engine default). */
  decided?: boolean;
  options?: VatDecision[];
}

export interface VatFlag {
  code: string;
  severity: VatSeverity;
  title: string;
  detail?: string;
  items?: VatFlagItem[];
}

export interface VatTotals {
  /** Output VAT on our sales (A.4 + A.5). */
  revenueVatHal: Hal;
  /** VAT we self-assess on foreign purchases (A.2) — deducted again below. */
  reverseChargeVatHal: Hal;
  outputVatHal: Hal;
  domesticDeductionHal: Hal;
  reverseChargeDeductionHal: Hal;
  deductionHal: Hal;
  /** Positive = to pay; negative = excess deduction (refund). */
  payableHal: Hal;
  /** VAT foreign suppliers charged us this month (lost — they don't have our VAT ID). */
  foreignVatChargedHal: Hal;
  grossRevenueHal: Hal;
}

export interface VatMonthResult {
  month: string;
  mode: VatMode;
  /** First day counted (later than the 1st when the company registered mid-month). */
  periodStart: string;
  periodEnd: string;
  payerFrom: string | null;
  deadline: string;
  daysToDeadline: number;
  revenue: { lines: VatRevenueLine[]; totals: VatRateTotals };
  a2: VatA2Row[];
  a4: VatRevenueLine[];
  a5: VatRateTotals;
  b2: VatPurchaseDoc[];
  b3: { totals: VatRateTotals; docs: VatPurchaseDoc[] };
  excluded: VatExcludedDoc[];
  dap: {
    rows: VatDapRow[];
    /** Whole-Kč values by row: r1b/r1t (base/tax) … r46, r62, r63, r64, r65 — feeds the DPHDP3 XML. */
    values: Record<DapValueKey, number>;
    outputTaxCzk: number;
    deductionCzk: number;
    payableCzk: number;
    refundCzk: number;
  };
  khC: VatKhC;
  totals: VatTotals;
  flags: VatFlag[];
  generatedAt: string;
}

export interface VatOverviewMonth {
  month: string;
  mode: VatMode;
  grossRevenueHal: Hal;
  outputVatHal: Hal;
  deductionHal: Hal;
  payableHal: Hal;
  errors: number;
  warnings: number;
  deadline: string;
}

export interface VatThresholdPoint {
  month: string;
  grossHal: Hal;
  cumulativeHal: Hal;
}

export interface VatThreshold {
  year: number;
  points: VatThresholdPoint[];
  /** Month the cumulative turnover first exceeded 2 000 000 Kč (payer from 1 Jan next year). */
  crossedStandard: string | null;
  /** Month it first exceeded 2 536 500 Kč (payer from the day after). */
  crossedImmediate: string | null;
  standardLimitHal: Hal;
  immediateLimitHal: Hal;
}

export interface VatOverview {
  year: number;
  months: VatOverviewMonth[];
  threshold: VatThreshold;
  payerFrom: string | null;
}

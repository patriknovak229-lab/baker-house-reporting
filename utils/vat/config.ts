/**
 * VAT section constants and defaults.
 *
 * Everything here is public business information (ARES, VIES, the tax
 * administration's code lists) — no personal data. Signer / contact names are
 * entered in the VAT settings and stored in the database, never in this repo.
 */
import type { VatConfig } from '@/types/vat';
import { toHal } from './money';

export const DEFAULT_VAT_CONFIG: VatConfig = {
  payerFrom: null,
  dic: '19876106',
  companyName: 'TRUTHSEEKER s.r.o.',
  street: 'Šumavská',
  houseNumber: '493',
  orientationNumber: '10',
  city: 'Brno',
  zip: '60200',
  country: 'ČESKÁ REPUBLIKA',
  cUfo: '461',      // Finanční úřad pro Jihomoravský kraj
  cPracufo: '3003', // Územní pracoviště Brno III
  okec: '552000',   // CZ-NACE 55.20 — short-stay accommodation
  signerFirstName: '',
  signerLastName: '',
  signerPosition: 'jednatel',
  compilerFirstName: '',
  compilerLastName: '',
  compilerPhone: '',
  email: '',
};

/** Where the filings and the money go (FÚ pro Jihomoravský kraj). */
export const TAX_OFFICE = {
  name: 'Finanční úřad pro Jihomoravský kraj',
  dataBoxId: 'qdhny4c',
  vatAccount: '705-77628621/0710',
  vatIban: 'CZ5207100007050077628621',
} as const;

/** Registration thresholds (§ 6 ZDPH, calendar-year turnover, since 2025). */
export const THRESHOLD_STANDARD_HAL = toHal(2_000_000);   // → payer from 1 January of the next year
export const THRESHOLD_IMMEDIATE_HAL = toHal(2_536_500);  // → payer from the day after it is exceeded

/** KH detail threshold: a document is itemised (A.4/B.2) when its total incl. VAT is OVER this. */
export const KH_DETAIL_LIMIT_HAL = toHal(10_000);

export const RATE_STANDARD = 21;
export const RATE_REDUCED = 12;

/** The two OTAs whose commission arrives through settlement reports. */
export const OTA_IDENTITY = {
  booking: { name: 'Booking.com B.V.', countryCode: 'NL', vatId: '805734958B01' },
  airbnb: { name: 'Airbnb Ireland UC', countryCode: 'IE', vatId: '9827384L' },
} as const;

/**
 * Airbnb host fee as a share of gross when Airbnb adds 21 % VAT on top
 * (host-only fee 15.5 % × 1.21, split fee 3 % × 1.21). Seeing one of these
 * ratios means the fee INCLUDES VAT — Airbnb doesn't have our VAT ID.
 */
export const AIRBNB_VAT_INCLUDED_RATIOS = [0.155 * 1.21, 0.03 * 1.21];
export const AIRBNB_RATIO_TOLERANCE = 0.0015;

/**
 * Known foreign vendors whose stored identifiers are missing or inconsistent.
 * Matched by a case-insensitive name fragment. country null = outside the EU.
 */
export const KNOWN_FOREIGN_VENDORS: Array<{ match: RegExp; countryCode: string | null; vatId: string | null }> = [
  { match: /google cloud emea/i, countryCode: 'IE', vatId: '3668997OH' },
  { match: /beds24/i, countryCode: 'DE', vatId: '328454604' },
  { match: /artgeist/i, countryCode: 'PL', vatId: '7262622485' },
  { match: /chal-?tec/i, countryCode: 'DE', vatId: '814529349' },
  { match: /pricelabs/i, countryCode: null, vatId: null },
  { match: /vercel/i, countryCode: null, vatId: null },
];

/** Marketplaces that collect import VAT themselves (IOSS) — that VAT is never deductible. */
export const MARKETPLACE_RE = /\b(temu|aliexpress|shein|wish\.com|joom)\b/i;

/** Supplier categories treated as goods (vs services) for EU purchases (VAT return row 3 vs 5). */
export const GOODS_CATEGORIES = new Set(['equipment', 'consumables']);

/** Categories where a 12 % rate is unusual enough to flag (12 % fits food, books, accommodation…). */
export const UNUSUAL_REDUCED_RATE_CATEGORIES = new Set([
  'equipment', 'software', 'services', 'maintenance', 'laundry', 'cleaning', 'distribution-fees',
]);

export const EU_COUNTRY_CODES = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES', 'FI', 'FR', 'HR', 'HU', 'IE', 'IT',
  'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'XI',
]);

/** Legal-form markers of a Czech legal person — without one, a supplier is likely a natural person. */
export const CZ_LEGAL_FORM_RE = /\b(s\.\s?r\.\s?o\.|spol\.|a\.\s?s\.|v\.\s?o\.\s?s\.|k\.\s?s\.|z\.\s?s\.|o\.\s?p\.\s?s\.|družstvo|s\.\s?p\.|z\.\s?ú\.)/i;

/** Months after the due date when an unpaid supplier invoice forces a deduction reversal (§ 74b). */
export function unpaidReversalMonths(onDate: string): number {
  return onDate >= '2027-01-01' ? 3 : 6;
}

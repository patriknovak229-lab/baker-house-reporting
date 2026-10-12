/**
 * Classify a supplier document for VAT: which part of the return / control
 * statement it belongs to, if any.
 *
 *   ota_settlement — Booking.com / Airbnb fee record owned by a settlement (handled from the settlement)
 *   ota_legacy     — an OTA invoice NOT owned by a settlement (would double-count the commission)
 *   marketplace    — Temu & co.: import VAT collected by the marketplace (IOSS), never deductible
 *   domestic       — Czech supplier (IČO / CZ DIČ) → B.2 / B.3 when it carries VAT
 *   foreign        — EU or non-EU supplier → reverse charge, KH A.2
 *   unknown        — no identifier we can trust
 */
import { isOtaSupplier } from '@/utils/otaSupplier';
import { EU_COUNTRY_CODES, KNOWN_FOREIGN_VENDORS, MARKETPLACE_RE } from './config';

export interface SupplierIdentityInput {
  supplierName: string;
  supplierIco: string | null;
  currency: string;
  settlementGroupId: string | null;
}

export type SupplierClass =
  | { cls: 'ota_settlement' }
  | { cls: 'ota_legacy' }
  | { cls: 'marketplace' }
  | { cls: 'domestic'; ico: string | null }
  | { cls: 'foreign'; eu: boolean; countryCode: string | null; vatId: string | null; idSource: 'stored' | 'known' | 'none' }
  | { cls: 'unknown' };

/** Foreign legal-form markers in a supplier name. */
const FOREIGN_LEGAL_FORM_RE =
  /\b(gmbh|ag|ltd|limited|inc|llc|pbc|b\.?v\.?|uc|s\.a\.|sas|sarl|s\.r\.l\.|spółka|sp\. z o\.o\.|oy|ab|aps|plc|pte)\b|\bgmbh\b/i;

export function normalizeTaxId(raw: string | null | undefined): string {
  return (raw ?? '').toUpperCase().replace(/[\s.]/g, '');
}

export function classifySupplier(input: SupplierIdentityInput): SupplierClass {
  const name = input.supplierName ?? '';
  const id = normalizeTaxId(input.supplierIco);
  const currency = (input.currency || 'CZK').toUpperCase();

  if (isOtaSupplier(name, id)) {
    return input.settlementGroupId ? { cls: 'ota_settlement' } : { cls: 'ota_legacy' };
  }
  if (MARKETPLACE_RE.test(name)) return { cls: 'marketplace' };

  const known = KNOWN_FOREIGN_VENDORS.find((v) => v.match.test(name));
  if (known) {
    return {
      cls: 'foreign',
      eu: known.countryCode !== null && EU_COUNTRY_CODES.has(known.countryCode),
      countryCode: known.countryCode,
      vatId: known.vatId,
      idSource: 'known',
    };
  }

  // EU VAT ID with a country prefix (GR is written EL in VIES)
  const prefixed = /^([A-Z]{2})([0-9A-Z]{2,13})$/.exec(id);
  if (prefixed) {
    const cc = prefixed[1] === 'GR' ? 'EL' : prefixed[1];
    if (cc === 'CZ') return { cls: 'domestic', ico: /^\d{8}$/.test(prefixed[2]) ? prefixed[2] : null };
    if (cc === 'EU') return { cls: 'foreign', eu: false, countryCode: null, vatId: null, idSource: 'stored' }; // non-Union OSS number
    if (EU_COUNTRY_CODES.has(cc)) {
      return { cls: 'foreign', eu: true, countryCode: cc, vatId: prefixed[2], idSource: 'stored' };
    }
  }
  // US EIN (e.g. 41-4535625)
  if (/^\d{2}-\d{7}$/.test(id)) return { cls: 'foreign', eu: false, countryCode: null, vatId: null, idSource: 'stored' };

  // Czech IČO
  if (/^\d{8}$/.test(id) && currency === 'CZK') return { cls: 'domestic', ico: id };

  if (currency !== 'CZK' || FOREIGN_LEGAL_FORM_RE.test(name) || /^\d{9,12}$/.test(id)) {
    return { cls: 'foreign', eu: false, countryCode: null, vatId: null, idSource: 'none' };
  }
  return { cls: 'unknown' };
}

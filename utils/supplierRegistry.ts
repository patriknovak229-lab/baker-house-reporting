/**
 * Known recurring suppliers — deterministic identity + category.
 *
 * The extraction model reads names inconsistently ("ACTION", "Action",
 * "ACTION / Action Retail Czech s.r.o.") and sometimes misreads or omits the
 * IČO, which broke whitelist auto-processing and duplicate detection. For the
 * suppliers below we don't trust the model: once a document is recognised (by
 * IČO first, then by name), its canonical name, IČO and category are applied.
 *
 * Shared by the extract route (server) and the whitelist matching (client).
 * To add a supplier: append an entry; `category` must be an existing
 * invoice-category id (see the Categories manager in Accounting).
 */

export interface KnownSupplier {
  id: string;
  /** Canonical legal name stored on the invoice */
  name: string;
  /** Canonical IČO (Czech, 8 digits) or foreign VAT id; omit to keep whatever was extracted */
  ico?: string;
  /** Matched against the extracted supplier name */
  namePattern: RegExp;
  category: string;
}

export const KNOWN_SUPPLIERS: KnownSupplier[] = [
  { id: 'ikea',      name: 'IKEA Česká republika, s.r.o.',  ico: '27081052',    namePattern: /\bikea\b/i,             category: 'equipment' },
  { id: 'alza',      name: 'Alza.cz a.s.',                  ico: '27082440',    namePattern: /\balza\b/i,             category: 'consumables' },
  { id: 'action',    name: 'Action Retail Czech s.r.o.',    ico: '03439747',    namePattern: /\baction\b/i,           category: 'consumables' },
  { id: 'makro',     name: 'MAKRO Cash & Carry ČR s.r.o.',  ico: '26450691',    namePattern: /\bma[ck]ro\b/i,         category: 'consumables' },
  { id: 'google',    name: 'Google Cloud EMEA Limited',                         namePattern: /\bgoogle\b/i,           category: 'software' },
  { id: 'beds24',    name: 'Beds24 GmbH',                   ico: 'DE328454604', namePattern: /\bbeds\s?24\b/i,        category: 'software' },
  { id: 'anthropic', name: 'Anthropic, PBC',                                    namePattern: /\banthropic\b/i,        category: 'software' },
];

/** Normalise an IČO / VAT id for comparison: drop spaces, uppercase, strip a leading "CZ". */
export function normalizeIco(ico: string | null | undefined): string {
  return (ico ?? '').replace(/\s+/g, '').toUpperCase().replace(/^CZ(?=\d{8}$)/, '');
}

/** Find the known supplier for an extracted name / IČO. IČO wins over name. */
export function findKnownSupplier(
  name: string | null | undefined,
  ico: string | null | undefined,
): KnownSupplier | null {
  const normIco = normalizeIco(ico);
  if (normIco) {
    const byIco = KNOWN_SUPPLIERS.find((s) => s.ico && normalizeIco(s.ico) === normIco);
    if (byIco) return byIco;
  }
  if (name) {
    const byName = KNOWN_SUPPLIERS.find((s) => s.namePattern.test(name));
    if (byName) return byName;
  }
  return null;
}

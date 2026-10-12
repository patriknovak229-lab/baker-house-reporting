/**
 * VAT money arithmetic in integer haléře (1 Kč = 100 h).
 *
 * Every amount in the VAT engine is an integer number of haléře — never a float
 * of crowns. Floats are only parsed at the edge (store records) and only
 * rendered at the edge (UI / XML / CSV). Rounding is "matematické zaokrouhlení"
 * (half away from zero), the rule Czech VAT documents use.
 */

/** An integer amount in haléře (or in the minor unit of a foreign currency). */
export type Hal = number;

/** Round half away from zero, tolerant of binary noise (2.4999999999 → 2.5 → 3). */
export function roundHalfAway(x: number): number {
  const clean = Math.round(x * 1e6) / 1e6;
  return clean < 0 ? -Math.round(-clean) : Math.round(clean);
}

/** Parse a stored amount (number or numeric string, crowns) into haléře. */
export function toHal(value: number | string | null | undefined): Hal {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) throw new Error(`Not a valid amount: ${String(value)}`);
  return roundHalfAway(n * 100);
}

/** Integer division with half-away-from-zero rounding. `den` must be a positive integer. */
export function roundDiv(num: number, den: number): number {
  if (!Number.isInteger(num) || !Number.isInteger(den) || den <= 0) {
    throw new Error(`roundDiv expects integers and a positive divisor (got ${num}/${den})`);
  }
  const q = Math.trunc(num / den);
  const r = num - q * den;
  return 2 * Math.abs(r) >= den ? q + Math.sign(num) : q;
}

/** VAT on a tax base at a whole-percent rate: base × rate / 100, rounded. */
export function vatOnBase(base: Hal, ratePct: number): Hal {
  return roundDiv(base * ratePct, 100);
}

/**
 * Split an amount that INCLUDES VAT into base + VAT ("výpočet shora"):
 * base = gross × 100 / (100 + rate), VAT = gross − base. Base and VAT always
 * add back to the gross exactly.
 */
export function splitGross(gross: Hal, ratePct: number): { base: Hal; vat: Hal } {
  const base = roundDiv(gross * 100, 100 + ratePct);
  return { base, vat: gross - base };
}

/**
 * Convert a foreign-currency amount (in its minor units) to haléře.
 * `rateMilli` = ČNB rate × 1000 for `unit` units of the currency (e.g. EUR:
 * 24 250 for 1 EUR; JPY: 13 141 for 100 JPY).
 */
export function fxToHal(minor: number, rateMilli: number, unit = 1): Hal {
  return roundDiv(minor * rateMilli, 1000 * unit);
}

/** Whole crowns (the VAT return / DPHDP3 is filed in whole Kč). */
export function toWholeCzk(h: Hal): number {
  return roundDiv(h, 100);
}

/** Exact decimal string with 2 places for XML/CSV: 1234567 → "12345.67", -5 → "-0.05". */
export function halToDecimal(h: Hal): string {
  const sign = h < 0 ? '-' : '';
  const abs = Math.abs(h);
  const crowns = Math.floor(abs / 100);
  const hal = abs % 100;
  return `${sign}${crowns}.${hal.toString().padStart(2, '0')}`;
}

/** Czech display format: 1234567 → "12 345,67" (narrow spacing as plain space). */
export function formatHal(h: Hal, opts: { decimals?: 0 | 2 } = {}): string {
  const decimals = opts.decimals ?? 2;
  if (decimals === 0) {
    const whole = toWholeCzk(h);
    return groupThousands(Math.abs(whole).toString(), whole < 0);
  }
  const [crowns, hal] = halToDecimal(h).replace('-', '').split('.');
  return `${groupThousands(crowns, h < 0)},${hal}`;
}

function groupThousands(digits: string, negative: boolean): string {
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return negative ? `−${grouped}` : grouped;
}

export function sumHal(values: Hal[]): Hal {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

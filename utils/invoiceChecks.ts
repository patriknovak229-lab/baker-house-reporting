/**
 * Sanity checks for supplier invoices — pure functions shared by the extract
 * route (server), the whitelist auto-save gate and the review drawer (client).
 *
 * Any issue blocks whitelist auto-save: the invoice opens in the review drawer
 * with the problems listed instead of being saved silently.
 */
import { normalizeIco } from './supplierRegistry';

/** Our own company (Truthseeker s.r.o.) — the BUYER on every supplier invoice. */
export const OUR_ICO = '19876106';

/** Czech VAT rates since 2024 (plus 0 for exempt rows). */
export const CZ_VAT_RATES = [21, 12, 0];

export interface VatRow {
  /** Percent, e.g. 21 */
  rate: number;
  base: number | null;
  vat: number | null;
}

export interface InvoiceIssue {
  field: 'amount' | 'vat' | 'date' | 'supplier' | 'link';
  message: string;
}

/** Round money to 2 decimals (kills float noise like 2815.6000000000004). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function round2OrNull(n: number | null | undefined): number | null {
  return n == null || !Number.isFinite(n) ? null : round2(n);
}

/** Czech IČO checksum (8 digits, mod-11). */
export function isValidCzechIco(ico: string): boolean {
  if (!/^\d{8}$/.test(ico)) return false;
  const weights = [8, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((s, w, i) => s + w * Number(ico[i]), 0);
  const check = (11 - (sum % 11)) % 10;
  return check === Number(ico[7]);
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Receipts like Action's e-receipt print "Středa 19. srpna" — day, month and
 * weekday but NO year, so the model guesses (and guessed 2024/2025 for Q3 2026
 * receipts). Pick the most recent year, not after `today`, in which that
 * day/month falls on the printed weekday (or just the most recent such year when
 * no weekday is given).
 */
export function resolveMissingYear(
  isoDate: string,
  weekday: string | null | undefined,
  today: Date = new Date(),
): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const wantDow = weekday ? WEEKDAYS.indexOf(weekday.trim().toLowerCase()) : -1;
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  for (let year = today.getFullYear(); year >= today.getFullYear() - 6; year--) {
    const t = Date.UTC(year, month - 1, day);
    if (t > todayUtc) continue;
    if (wantDow >= 0 && new Date(t).getUTCDay() !== wantDow) continue;
    return `${year}-${m[1]}-${m[2]}`;
  }
  return isoDate;
}

interface CheckInput {
  supplierName?: string | null;
  supplierICO?: string | null;
  invoiceDate?: string | null;
  amount: number | null;
  vat: number | null;
  currency?: string | null;
  documentType?: string | null;
  vatBreakdown?: VatRow[] | null;
  /** Credit notes only: is it linked to, or does it print the number of, the original invoice? */
  hasOriginalInvoice?: boolean;
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/** Run every check; an empty array means the invoice looks consistent. */
export function checkInvoice(inv: CheckInput, today: Date = new Date()): InvoiceIssue[] {
  const issues: InvoiceIssue[] = [];
  const isCredit = inv.documentType === 'credit_note';
  const amount = inv.amount;
  const vat = inv.vat;

  // ── Amount sign ──
  if (amount == null || !Number.isFinite(amount)) {
    issues.push({ field: 'amount', message: 'No total amount found.' });
  } else if (isCredit && amount >= 0) {
    issues.push({ field: 'amount', message: 'A credit note (dobropis) must have a negative amount.' });
  } else if (!isCredit && amount <= 0) {
    issues.push({ field: 'amount', message: 'Total must be greater than 0 — check it is not a prepaid "k úhradě 0" line.' });
  }

  // ── VAT ──
  const isCzk = !inv.currency || inv.currency === 'CZK';
  if (amount != null && vat != null && vat !== 0) {
    if (Math.abs(vat) >= Math.abs(amount)) {
      issues.push({ field: 'vat', message: 'VAT is not smaller than the total.' });
    } else if (inv.vatBreakdown && inv.vatBreakdown.length > 0) {
      const rows = inv.vatBreakdown;
      for (const r of rows) {
        if (isCzk && !CZ_VAT_RATES.includes(r.rate)) {
          issues.push({ field: 'vat', message: `VAT rate ${r.rate} % is not a Czech rate (21 % / 12 %).` });
        } else if (r.base != null && r.vat != null) {
          const expected = (Math.abs(r.base) * r.rate) / 100;
          if (!near(Math.abs(r.vat), expected, Math.max(1, expected * 0.01))) {
            issues.push({ field: 'vat', message: `${r.rate} % row: VAT ${round2(r.vat)} ≠ ${r.rate} % of ${round2(r.base)} (${round2(expected)}).` });
          }
        }
      }
      const rowVat = rows.reduce((s, r) => s + Math.abs(r.vat ?? 0), 0);
      if (rows.every((r) => r.vat != null) && !near(rowVat, Math.abs(vat), 1)) {
        issues.push({ field: 'vat', message: `VAT ${round2(Math.abs(vat))} ≠ sum of the VAT table rows (${round2(rowVat)}).` });
      }
      if (rows.every((r) => r.base != null && r.vat != null)) {
        const rowTotal = rows.reduce((s, r) => s + Math.abs(r.base ?? 0) + Math.abs(r.vat ?? 0), 0);
        // Cash rounding (zaokrouhlení) may legally add up to ±1 Kč
        if (!near(rowTotal, Math.abs(amount), 1.01)) {
          issues.push({ field: 'amount', message: `Total ${round2(Math.abs(amount))} ≠ base + VAT from the VAT table (${round2(rowTotal)}).` });
        }
      }
    } else if (isCzk) {
      // No VAT table: the implied rate must be 12 % or 21 %. In between means a
      // mixed basket — then the per-rate split is required (the VAT report needs it).
      const net = Math.abs(amount) - Math.abs(vat);
      const ratePct = net > 0 ? (Math.abs(vat) / net) * 100 : 0;
      if (ratePct < 11.5 || ratePct > 21.5) {
        issues.push({ field: 'vat', message: `VAT is ${round2(ratePct)} % of the net amount — expected 21 % or 12 %.` });
      } else if (!singleRateOf(net, Math.abs(vat))) {
        issues.push({ field: 'vat', message: 'VAT mixes 12 % and 21 % — add the amount for each rate under "VAT by rate".' });
      }
    }
  }

  // ── Dates ──
  if (!inv.invoiceDate) {
    issues.push({ field: 'date', message: 'No invoice date found.' });
  } else {
    const d = new Date(`${inv.invoiceDate}T00:00:00Z`).getTime();
    const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    if (Number.isNaN(d)) {
      issues.push({ field: 'date', message: `Invoice date "${inv.invoiceDate}" is not a valid date.` });
    } else if (d > todayUtc + 86_400_000) {
      issues.push({ field: 'date', message: 'Invoice date is in the future — check the year.' });
    } else if (todayUtc - d > 400 * 86_400_000) {
      issues.push({ field: 'date', message: 'Invoice date is over a year old — check the year.' });
    }
  }

  // ── Supplier ──
  const ico = normalizeIco(inv.supplierICO);
  if (ico === OUR_ICO) {
    issues.push({ field: 'supplier', message: `IČO ${OUR_ICO} is OUR company (the buyer), not the supplier.` });
  } else if (/^\d{8}$/.test(ico) && !isValidCzechIco(ico)) {
    issues.push({ field: 'supplier', message: `IČO ${ico} fails the Czech checksum — likely misread.` });
  }

  // ── Credit-note link ──
  if (isCredit && !inv.hasOriginalInvoice) {
    issues.push({ field: 'link', message: 'Credit note does not say which invoice it corrects — pick or type the original invoice.' });
  }

  return issues;
}

/**
 * The one VAT rate that explains the whole VAT on this net amount, or null when
 * it takes a mix of rates. Strict: the VAT must equal net × rate to within 1 Kč
 * (0.1 % on large invoices) — a percentage window is too loose, e.g. an Action
 * receipt mostly at 21 % with a little at 12 % implies 20.5 %.
 */
function singleRateOf(net: number, vat: number): 21 | 12 | null {
  for (const rate of [21, 12] as const) {
    const expected = (net * rate) / 100;
    if (Math.abs(vat - expected) <= Math.max(1, expected * 0.001)) return rate;
  }
  return null;
}

/** Drop empty VAT-table rows (e.g. the printed "0 % · 0,00 · 0,00" line); a real 0 % row with a base stays */
export function meaningfulVatRows(rows: VatRow[] | null | undefined): VatRow[] {
  return (rows ?? []).filter((r) => Math.abs(r.base ?? 0) >= 0.005 || Math.abs(r.vat ?? 0) >= 0.005);
}

/**
 * The per-rate VAT split when it follows from the totals alone: the whole VAT
 * is at ONE rate (21 % or 12 %). Returns null for no VAT, or for a mixed
 * 12 %/21 % basket — those need the document's VAT table. Rows carry the sign
 * of the amount (negative on credit notes).
 */
export function deriveVatBreakdown(amount: number, vat: number | null | undefined): VatRow[] | null {
  if (vat == null || vat === 0 || !Number.isFinite(amount)) return null;
  const net = Math.abs(amount) - Math.abs(vat);
  if (net <= 0) return null;
  const rate = singleRateOf(net, Math.abs(vat));
  if (!rate) return null;
  const sign = amount < 0 ? -1 : 1;
  return [{ rate, base: round2(sign * net), vat: round2(sign * Math.abs(vat)) }];
}

/**
 * Normalise money before persisting: 2 decimals, credit notes always negative
 * (amount, VAT and the per-rate rows), and the per-rate VAT split filled in
 * when it follows from a single rate. Applied by the save routes so manual
 * edits and client-side sums can't store float noise or an unsplit invoice.
 */
export function normalizeInvoiceAmounts<T extends {
  amountCZK: number;
  vatAmountCZK?: number;
  documentType?: string;
  vatBreakdown?: VatRow[];
}>(inv: T): T {
  const isCredit = inv.documentType === 'credit_note';
  const sign = (n: number) => (isCredit ? -Math.abs(n) : n);
  const amountCZK = round2(sign(inv.amountCZK));
  const vatAmountCZK = inv.vatAmountCZK == null ? inv.vatAmountCZK : round2(sign(inv.vatAmountCZK));
  const rows = meaningfulVatRows(inv.vatBreakdown)
    .map((r) => ({ rate: r.rate, base: r.base == null ? null : round2(sign(r.base)), vat: r.vat == null ? null : round2(sign(r.vat)) }));
  const vatBreakdown = rows.length > 0 ? rows : deriveVatBreakdown(amountCZK, vatAmountCZK) ?? undefined;
  return { ...inv, amountCZK, vatAmountCZK, vatBreakdown };
}

interface DupCandidate {
  id: string;
  supplierName: string;
  supplierICO?: string | null;
  invoiceNumber: string;
  invoiceDate: string;
  amountCZK: number;
  documentType?: string;
}

/**
 * An already-saved invoice that is the same document: same supplier (name or
 * IČO) AND either the same invoice number, or — for invoices, not credit notes —
 * the same date and amount (catches a receipt re-imported with a different or
 * placeholder number).
 */
export function findDuplicateInvoice<T extends DupCandidate>(inv: DupCandidate, existing: T[]): T | null {
  const norm = (s?: string | null) => (s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
  const name = norm(inv.supplierName);
  const ico = normalizeIco(inv.supplierICO);
  const invNo = norm(inv.invoiceNumber);
  return existing.find((e) => {
    if (e.id === inv.id) return false;
    const sameSupplier = (!!name && norm(e.supplierName) === name) || (!!ico && normalizeIco(e.supplierICO) === ico);
    if (!sameSupplier) return false;
    if (!!invNo && norm(e.invoiceNumber) === invNo) return true;
    return inv.documentType !== 'credit_note' && e.documentType !== 'credit_note' &&
      !!inv.invoiceDate && e.invoiceDate === inv.invoiceDate &&
      Math.abs(e.amountCZK - inv.amountCZK) < 0.01;
  }) ?? null;
}

/**
 * The original invoice a credit note corrects: same supplier (name or IČO) and
 * invoice number equal to the number printed on the dobropis.
 */
export function findOriginalInvoice<T extends DupCandidate>(
  supplierName: string | null | undefined,
  supplierICO: string | null | undefined,
  originalInvoiceNumber: string | null | undefined,
  existing: T[],
): T | null {
  const norm = (s?: string | null) => (s ?? '').toLowerCase().replace(/\s+/g, '');
  const target = norm(originalInvoiceNumber);
  if (!target) return null;
  const name = (supplierName ?? '').toLowerCase().trim();
  const ico = normalizeIco(supplierICO);
  return existing.find((e) =>
    e.documentType !== 'credit_note' &&
    norm(e.invoiceNumber) === target &&
    ((!!name && e.supplierName.toLowerCase().trim() === name) || (!!ico && normalizeIco(e.supplierICO) === ico)),
  ) ?? null;
}

/**
 * EPO XML builders — kontrolní hlášení (DPHKH1) and přiznání k DPH (DPHDP3).
 *
 * Structures: https://adisspr.mfcr.cz/dpr/adis/idpr_pub/epo2_info/popis_struktury_detail.faces?zkratka=DPHKH1
 * (and ?zkratka=DPHDP3). The official XSDs are vendored in utils/vat/xsd/ and
 * the unit tests validate generated files against them.
 *
 * A file that doesn't match the published structure is legally "neúčinné"
 * (treated as never filed, § 101a(4) ZDPH) — so `khXmlIssues` checks every
 * value against the XSD facets up front and the engine raises them as errors.
 *
 * Rules: all data in attributes, fixed element order, DIČ digits only (no
 * "CZ"), dates DD.MM.RRRR, decimal point "." — KH amounts in haléře precision,
 * DP3 amounts in whole crowns. Zero optional amounts are omitted.
 */
import type { VatConfig, VatMonthResult } from '@/types/vat';
import { halToDecimal } from './money';
import { toCzechDate } from './czechCalendar';

export interface XmlIssue {
  label: string;
  detail: string;
}

export type KhForm = 'B' | 'O' | 'N' | 'E';
export type DpForm = 'B' | 'O' | 'D' | 'E';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

type AttrValue = string | number | null | undefined;

function attrs(pairs: Array<[string, AttrValue]>): string {
  return pairs
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}="${esc(String(v))}"`)
    .join(' ');
}

/** Haléře → "123.45", omitted when zero. */
const amt = (h: number): string | null => (h === 0 ? null : halToDecimal(h));
/** Whole crowns, omitted when zero. */
const czk = (n: number): string | null => (n === 0 ? null : String(n));

function header(r: VatMonthResult, kind: string): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  if (r.mode === 'simulation') {
    lines.push(`<!-- SIMULATION ${kind} ${r.month}: the company is not a VAT payer for this period. Not a filing. -->`);
  }
  return lines.join('\n');
}

function vetaP(cfg: VatConfig): string {
  return `<VetaP ${attrs([
    ['c_ufo', cfg.cUfo], ['c_pracufo', cfg.cPracufo], ['dic', cfg.dic], ['typ_ds', 'P'],
    ['zkrobchjm', cfg.companyName], ['ulice', cfg.street], ['c_pop', cfg.houseNumber], ['c_orient', cfg.orientationNumber],
    ['naz_obce', cfg.city], ['psc', cfg.zip], ['stat', cfg.country], ['email', cfg.email],
    ['opr_jmeno', cfg.signerFirstName], ['opr_prijmeni', cfg.signerLastName],
    ['opr_postaveni', cfg.signerFirstName || cfg.signerLastName ? cfg.signerPosition : ''],
    ['sest_jmeno', cfg.compilerFirstName], ['sest_prijmeni', cfg.compilerLastName], ['sest_telef', cfg.compilerPhone],
  ])}/>`;
}

// ─── DPHKH1 ──────────────────────────────────────────────────────────────────

export function buildKhXml(
  r: VatMonthResult,
  cfg: VatConfig,
  opts: { form?: KhForm; preparedOn: string; software?: string; version?: string },
): string {
  const [year, month] = r.month.split('-').map(Number);
  const body: string[] = [];
  body.push(`<VetaD ${attrs([
    ['dokument', 'KH1'], ['k_uladis', 'DPH'], ['rok', year], ['mesic', month],
    ['khdph_forma', opts.form ?? 'B'], ['d_poddp', toCzechDate(opts.preparedOn)],
  ])}/>`);
  body.push(vetaP(cfg));

  r.a2.forEach((row, i) => {
    body.push(`<VetaA2 ${attrs([
      ['c_radku', i + 1],
      ['k_stat', row.countryCode && row.vatId ? row.countryCode : null],
      ['vatid_dod', row.countryCode && row.vatId ? row.vatId : null],
      ['c_evid_dd', row.documentNumber],
      ['dppd', toCzechDate(row.dppd)],
      ['zakl_dane1', amt(row.baseHal)], ['dan1', amt(row.vatHal)],
    ])}/>`);
  });

  const a5 = attrs([
    ['zakl_dane1', amt(r.a5.base21Hal)], ['dan1', amt(r.a5.vat21Hal)],
    ['zakl_dane2', amt(r.a5.base12Hal)], ['dan2', amt(r.a5.vat12Hal)],
  ]);
  if (a5) body.push(`<VetaA5 ${a5}/>`);

  r.b2.forEach((d, i) => {
    body.push(`<VetaB2 ${attrs([
      ['c_radku', i + 1], ['dic_dod', d.ico], ['c_evid_dd', d.documentNumber], ['dppd', toCzechDate(d.date)],
      ['zakl_dane1', amt(d.base21Hal)], ['dan1', amt(d.vat21Hal)],
      ['zakl_dane2', amt(d.base12Hal)], ['dan2', amt(d.vat12Hal)],
      ['pomer', 'N'], ['zdph_44', 'N'],
    ])}/>`);
  });

  const b3 = r.b3.totals;
  const b3a = attrs([
    ['zakl_dane1', amt(b3.base21Hal)], ['dan1', amt(b3.vat21Hal)],
    ['zakl_dane2', amt(b3.base12Hal)], ['dan2', amt(b3.vat12Hal)],
  ]);
  if (b3a) body.push(`<VetaB3 ${b3a}/>`);

  const c = attrs([
    ['obrat23', amt(r.khC.obrat23)], ['obrat5', amt(r.khC.obrat5)],
    ['pln23', amt(r.khC.pln23)], ['pln5', amt(r.khC.pln5)],
    ['pln_rez_pren', amt(r.khC.plnRezPren)], ['rez_pren23', amt(r.khC.rezPren23)], ['rez_pren5', amt(r.khC.rezPren5)],
    ['celk_zd_a2', amt(r.khC.celkZdA2)],
  ]);
  if (c) body.push(`<VetaC ${c}/>`);

  return [
    header(r, 'DPHKH1'),
    `<Pisemnost ${attrs([['nazevSW', opts.software ?? 'baker-house-reporting'], ['verzeSW', opts.version ?? '1.0']])}>`,
    `  <DPHKH1 verzePis="03.01">`,
    ...body.map((b) => `    ${b}`),
    '  </DPHKH1>',
    '</Pisemnost>',
    '',
  ].join('\n');
}

// ─── DPHDP3 ──────────────────────────────────────────────────────────────────

export function buildDpXml(
  r: VatMonthResult,
  cfg: VatConfig,
  opts: { form?: DpForm; preparedOn: string; software?: string; version?: string },
): string {
  const [year, month] = r.month.split('-').map(Number);
  const v = r.dap.values;
  const partial = r.periodStart !== `${r.month}-01`;
  const anyData = Object.entries(v).some(([, n]) => n !== 0);
  const body: string[] = [];
  body.push(`<VetaD ${attrs([
    ['dokument', 'DP3'], ['k_uladis', 'DPH'], ['rok', year], ['mesic', month],
    ['dapdph_forma', opts.form ?? 'B'], ['typ_platce', 'P'], ['trans', anyData ? 'A' : 'N'],
    ['c_okec', /^\d{1,6}$/.test(cfg.okec) ? cfg.okec : null],
    ['zdobd_od', partial ? toCzechDate(r.periodStart) : null], ['zdobd_do', partial ? toCzechDate(r.periodEnd) : null],
    ['d_poddp', toCzechDate(opts.preparedOn)],
  ])}/>`);
  body.push(vetaP(cfg));

  const v1 = attrs([
    ['obrat23', czk(v.r1b)], ['dan23', czk(v.r1t)],
    ['obrat5', czk(v.r2b)], ['dan5', czk(v.r2t)],
    ['p_zb23', czk(v.r3b)], ['dan_pzb23', czk(v.r3t)],
    ['p_sl23_e', czk(v.r5b)], ['dan_psl23_e', czk(v.r5t)],
    ['p_sl23_z', czk(v.r12b)], ['dan_psl23_z', czk(v.r12t)],
  ]);
  if (v1) body.push(`<Veta1 ${v1}/>`);

  const v4 = attrs([
    ['pln23', czk(v.r40b)], ['odp_tuz23_nar', czk(v.r40t)],
    ['pln5', czk(v.r41b)], ['odp_tuz5_nar', czk(v.r41t)],
    ['nar_zdp23', czk(v.r43b)], ['od_zdp23', czk(v.r43t)],
    ['odp_sum_nar', czk(v.r46)],
  ]);
  if (v4) body.push(`<Veta4 ${v4}/>`);

  const v6 = attrs([
    ['dan_zocelk', czk(v.r62)], ['odp_zocelk', czk(v.r63)],
    ['dano_da', czk(v.r64)], ['dano_no', czk(v.r65)],
  ]);
  if (v6) body.push(`<Veta6 ${v6}/>`);

  return [
    header(r, 'DPHDP3'),
    `<Pisemnost ${attrs([['nazevSW', opts.software ?? 'baker-house-reporting'], ['verzeSW', opts.version ?? '1.0']])}>`,
    `  <DPHDP3 verzePis="03.01">`,
    ...body.map((b) => `    ${b}`),
    '  </DPHDP3>',
    '</Pisemnost>',
    '',
  ].join('\n');
}

// ─── Up-front validation against the XSD facets ─────────────────────────────

function maxLen(issues: XmlIssue[], label: string, value: string | null | undefined, max: number): void {
  if (value && value.length > max) issues.push({ label, detail: `“${value}” is longer than ${max} characters.` });
}

export function khXmlIssues(r: VatMonthResult, cfg: VatConfig): XmlIssue[] {
  const issues: XmlIssue[] = [];
  if (!/^\d{1,10}$/.test(cfg.dic)) issues.push({ label: 'Company DIČ', detail: 'Must be 1–10 digits without the CZ prefix.' });
  if (!/^\d{1,3}$/.test(cfg.cUfo)) issues.push({ label: 'Tax office code (c_ufo)', detail: 'Must be up to 3 digits (461 = FÚ pro JMK).' });
  if (cfg.cPracufo && !/^\d{1,4}$/.test(cfg.cPracufo)) issues.push({ label: 'Workplace code (c_pracufo)', detail: 'Must be up to 4 digits.' });
  if (cfg.houseNumber && !/^\d{1,6}$/.test(cfg.houseNumber)) issues.push({ label: 'House number (c_pop)', detail: 'Must be up to 6 digits.' });
  maxLen(issues, 'Company name', cfg.companyName, 255);
  maxLen(issues, 'Street', cfg.street, 38);
  maxLen(issues, 'Orientation number', cfg.orientationNumber, 4);
  maxLen(issues, 'City', cfg.city, 48);
  maxLen(issues, 'Postcode', cfg.zip, 10);
  maxLen(issues, 'Country', cfg.country, 25);
  maxLen(issues, 'E-mail', cfg.email, 255);
  maxLen(issues, 'Signer first name', cfg.signerFirstName, 20);
  maxLen(issues, 'Signer last name', cfg.signerLastName, 36);
  maxLen(issues, 'Signer position', cfg.signerPosition, 40);
  maxLen(issues, 'Prepared by — first name', cfg.compilerFirstName, 20);
  maxLen(issues, 'Prepared by — last name', cfg.compilerLastName, 36);
  maxLen(issues, 'Prepared by — phone', cfg.compilerPhone, 14);

  for (const row of r.a2) {
    const who = `A.2 ${row.supplier}${row.documentNumber ? ` · ${row.documentNumber}` : ''}`;
    if (row.countryCode && !/^[A-Z]{2}$/.test(row.countryCode)) issues.push({ label: who, detail: 'Country code must be 2 letters.' });
    if (row.vatId && !/^[0-9A-Z+*]{1,12}$/.test(row.vatId)) issues.push({ label: who, detail: `VAT ID “${row.vatId}” must be at most 12 characters, without the country prefix.` });
    maxLen(issues, who, row.documentNumber, 60);
  }
  for (const d of r.b2) {
    const who = `B.2 ${d.supplier} · ${d.documentNumber}`;
    if (!d.ico || !/^\d{1,10}$/.test(d.ico)) issues.push({ label: who, detail: 'The supplier’s DIČ (digits) is required for a B.2 row.' });
    if (!d.documentNumber) issues.push({ label: who, detail: 'The supplier’s document number is required.' });
    maxLen(issues, who, d.documentNumber, 60);
  }
  return issues;
}

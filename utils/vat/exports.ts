/**
 * Accountant exports for one VAT month: a document ledger (CSV, Czech Excel
 * flavour — ";" separator, decimal comma, UTF-8 BOM, CRLF) and an XLSX
 * workbook (summary, control statement, documents, flags).
 *
 * Headers are Czech on purpose: these files go to the accountant.
 */
import ExcelJS from 'exceljs';
import type { VatConfig, VatMonthResult } from '@/types/vat';
import { halToDecimal } from './money';
import { toCzechDate } from './czechCalendar';

export interface LedgerRow {
  druh: string;
  oddil: string;
  radek: string;
  datum: string;
  pravidlo: string;
  doklad: string;
  rezervace: string;
  protistrana: string;
  identifikace: string;
  zeme: string;
  mena: string;
  castkaVMene: number | null; // haléře / minor units
  kurz: string;
  datumKurzu: string;
  sazba: string;
  zaklad21: number; dan21: number; zaklad12: number; dan12: number; celkem: number; // haléře
  poznamka: string;
}

/** Czech names of the VAT return rows (as on the přiznání k DPH form) — for the accountant's documents. */
export const DAP_ROW_CS: Record<string, string> = {
  '1': 'Uskutečněná zdanitelná plnění — základní sazba',
  '2': 'Uskutečněná zdanitelná plnění — snížená sazba (ubytování)',
  '3': 'Pořízení zboží z jiného členského státu — základní sazba',
  '5': 'Přijetí služby od osoby registrované v jiném členském státě — základní sazba',
  '12': 'Ostatní plnění s povinností přiznat daň příjemcem — základní sazba',
  '40': 'Odpočet — přijatá zdanitelná plnění od plátců, základní sazba',
  '41': 'Odpočet — přijatá zdanitelná plnění od plátců, snížená sazba',
  '43': 'Odpočet — z plnění uvedených na ř. 3–13, základní sazba',
  '46': 'Odpočet daně celkem',
  '62': 'Daň na výstupu',
  '63': 'Odpočet daně',
  '64': 'Vlastní daň',
  '65': 'Nadměrný odpočet',
};

const KIND_LABEL = { goods_eu: 'Pořízení zboží z EU', services_eu: 'Služba z EU', services_non_eu: 'Služba ze 3. země' } as const;

export function ledgerRows(r: VatMonthResult): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const l of r.revenue.lines) {
    rows.push({
      druh: l.source === 'refund' ? 'Vrácení (oprava)' : 'Tržba', oddil: l.section, radek: l.ratePct === 21 ? '1' : '2',
      datum: l.taxPoint, pravidlo: l.taxPointRule, doklad: l.ref, rezervace: l.reservationNumber ?? '', protistrana: l.label,
      identifikace: '', zeme: 'CZ', mena: 'CZK', castkaVMene: null, kurz: '', datumKurzu: '', sazba: String(l.ratePct),
      zaklad21: l.ratePct === 21 ? l.baseHal : 0, dan21: l.ratePct === 21 ? l.vatHal : 0,
      zaklad12: l.ratePct === 12 ? l.baseHal : 0, dan12: l.ratePct === 12 ? l.vatHal : 0, celkem: l.grossHal, poznamka: l.note ?? '',
    });
  }
  for (const a of r.a2) {
    rows.push({
      druh: `Přenesení daňové povinnosti — ${KIND_LABEL[a.kind]}`, oddil: 'A.2', radek: `${a.dapRow} + 43`, datum: a.dppd, pravidlo: 'DPPD',
      doklad: a.documentNumber ?? '(chybí číslo dokladu)', rezervace: '', protistrana: a.supplier,
      identifikace: a.countryCode && a.vatId ? `${a.countryCode}${a.vatId}` : '', zeme: a.countryCode ?? 'mimo EU',
      mena: a.currency, castkaVMene: a.currency === 'CZK' ? null : a.originalMinor,
      kurz: a.fxRate ? `${a.fxRate.toFixed(3).replace('.', ',')}${a.fxUnit !== 1 ? ` / ${a.fxUnit}` : ''}` : '',
      datumKurzu: a.fxFixingDate ?? '', sazba: '21', zaklad21: a.baseHal, dan21: a.vatHal, zaklad12: 0, dan12: 0, celkem: a.baseHal,
      poznamka: [a.note, a.foreignVatChargedHal ? `Dodavatel účtoval DPH ${halToDecimal(a.foreignVatChargedHal).replace('.', ',')} Kč (neodpočitatelná)` : '']
        .filter(Boolean).join(' · '),
    });
  }
  for (const d of [...r.b2, ...r.b3.docs]) {
    rows.push({
      druh: d.creditNote ? 'Nákup — dobropis' : 'Nákup', oddil: d.section, radek: [d.base21Hal ? '40' : '', d.base12Hal ? '41' : ''].filter(Boolean).join(' + '),
      datum: d.date, pravidlo: 'DUZP', doklad: d.documentNumber, rezervace: '', protistrana: d.supplier, identifikace: d.ico ?? '',
      zeme: 'CZ', mena: 'CZK', castkaVMene: null, kurz: '', datumKurzu: '', sazba: [d.base21Hal ? '21' : '', d.base12Hal ? '12' : ''].filter(Boolean).join('+'),
      zaklad21: d.base21Hal, dan21: d.vat21Hal, zaklad12: d.base12Hal, dan12: d.vat12Hal, celkem: d.totalHal,
      poznamka: d.splitDerived ? 'Sazba dopočtena z celkové částky' : '',
    });
  }
  for (const x of r.excluded) {
    rows.push({
      druh: 'Mimo přiznání', oddil: '—', radek: '—', datum: x.date, pravidlo: '', doklad: x.documentNumber, rezervace: '',
      protistrana: x.supplier, identifikace: '', zeme: '', mena: x.currency, castkaVMene: null, kurz: '', datumKurzu: '', sazba: '',
      zaklad21: 0, dan21: 0, zaklad12: 0, dan12: 0, celkem: x.totalHal, poznamka: x.reasonLabel,
    });
  }
  return rows;
}

const LEDGER_HEADERS: Array<[keyof LedgerRow, string]> = [
  ['druh', 'Druh'], ['oddil', 'Oddíl KH'], ['radek', 'Řádek DP'], ['datum', 'Datum (DUZP / DPPD)'], ['pravidlo', 'Určení data'],
  ['doklad', 'Doklad'], ['rezervace', 'Rezervace'], ['protistrana', 'Protistrana'], ['identifikace', 'IČO / DIČ'], ['zeme', 'Země'],
  ['mena', 'Měna'], ['castkaVMene', 'Částka v měně (bez DPH)'], ['kurz', 'Kurz ČNB'], ['datumKurzu', 'Datum kurzu'], ['sazba', 'Sazba %'],
  ['zaklad21', 'Základ 21 %'], ['dan21', 'DPH 21 %'], ['zaklad12', 'Základ 12 %'], ['dan12', 'DPH 12 %'], ['celkem', 'Celkem Kč'],
  ['poznamka', 'Poznámka'],
];
const MONEY_KEYS = new Set<keyof LedgerRow>(['castkaVMene', 'zaklad21', 'dan21', 'zaklad12', 'dan12', 'celkem']);

function csvCell(v: string | number | null): string {
  if (v === null) return '';
  const s = typeof v === 'number' ? halToDecimal(v).replace('.', ',') : v;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildLedgerCsv(r: VatMonthResult): string {
  const lines = [LEDGER_HEADERS.map(([, h]) => h).join(';')];
  for (const row of ledgerRows(r)) {
    lines.push(LEDGER_HEADERS.map(([k]) => {
      const v = row[k];
      if (MONEY_KEYS.has(k)) return csvCell(v === null ? null : (v as number));
      if (k === 'datum' || k === 'datumKurzu') return csvCell(v ? toCzechDate(String(v)) : '');
      return csvCell(String(v ?? ''));
    }).join(';'));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ─── XLSX ────────────────────────────────────────────────────────────────────

const NUM_FMT = '#,##0.00;[Red]-#,##0.00';
const CZK_FMT = '#,##0;[Red]-#,##0';
const toCzk = (h: number) => Math.round(h) / 100;

function styleHeader(row: ExcelJS.Row): void {
  row.font = { bold: true };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FF' } };
}

export async function buildWorkbook(r: VatMonthResult, cfg: VatConfig): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'baker-house-reporting';
  wb.created = new Date(r.generatedAt);
  const period = `${r.month.slice(5)}/${r.month.slice(0, 4)}`;

  // Souhrn
  const s = wb.addWorksheet('Souhrn');
  s.columns = [{ width: 10 }, { width: 58 }, { width: 18 }, { width: 18 }];
  s.addRow([`DPH — ${cfg.companyName}, DIČ CZ${cfg.dic}`]).font = { bold: true, size: 14 };
  s.addRow([`Zdaňovací období ${period}${r.periodStart !== `${r.month}-01` ? ` (od ${toCzechDate(r.periodStart)})` : ''}`]);
  s.addRow([r.mode === 'simulation' ? 'SIMULACE — společnost v tomto období není plátcem DPH, nepodává se.' : `Termín podání a úhrady: ${toCzechDate(r.deadline)}`]);
  s.addRow([]);
  styleHeader(s.addRow(['Řádek', 'Přiznání k DPH', 'Základ (Kč)', 'Daň (Kč)']));
  for (const row of r.dap.rows) {
    const x = s.addRow([`ř. ${row.row}`, DAP_ROW_CS[row.row] ?? row.label, row.baseCzk, row.taxCzk]);
    x.getCell(3).numFmt = CZK_FMT;
    x.getCell(4).numFmt = CZK_FMT;
  }
  s.addRow([]);
  styleHeader(s.addRow(['KH C', 'Kontrolní řádek', 'Hodnota (Kč)', 'Řádek DP']));
  const c = r.khC;
  for (const [k, label, v, dp] of [
    ['obrat23', 'Základ — uskutečněná plnění 21 % (A.4 + A.5)', c.obrat23, '1'],
    ['obrat5', 'Základ — uskutečněná plnění 12 % (A.4 + A.5)', c.obrat5, '2'],
    ['pln23', 'Základ — přijatá plnění 21 % (B.2 + B.3)', c.pln23, '40'],
    ['pln5', 'Základ — přijatá plnění 12 % (B.2 + B.3)', c.pln5, '41'],
    ['celk_zd_a2', 'Základ — A.2', c.celkZdA2, '3–13'],
  ] as const) {
    const x = s.addRow([k, label, toCzk(v), dp]);
    x.getCell(3).numFmt = NUM_FMT;
  }

  // Kontrolní hlášení
  const k = wb.addWorksheet('Kontrolní hlášení');
  k.columns = [{ width: 8 }, { width: 34 }, { width: 18 }, { width: 24 }, { width: 12 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }];
  k.addRow(['A.2 — Přijatá plnění, u kterých je povinen přiznat daň příjemce']).font = { bold: true };
  styleHeader(k.addRow(['Ř.', 'Dodavatel', 'DIČ dodavatele', 'Ev. č. dokladu', 'DPPD', 'Základ 21 %', 'Daň 21 %']));
  r.a2.forEach((a, i) => {
    const x = k.addRow([i + 1, a.supplier, a.countryCode && a.vatId ? `${a.countryCode}${a.vatId}` : '', a.documentNumber ?? '(doplnit)',
      toCzechDate(a.dppd), toCzk(a.baseHal), toCzk(a.vatHal)]);
    x.getCell(6).numFmt = NUM_FMT;
    x.getCell(7).numFmt = NUM_FMT;
  });
  k.addRow([]);
  k.addRow(['A.5 — Ostatní uskutečněná plnění (souhrnně)']).font = { bold: true };
  styleHeader(k.addRow(['', '', '', '', '', 'Základ 21 %', 'Daň 21 %', 'Základ 12 %', 'Daň 12 %']));
  const a5 = k.addRow(['', '', '', '', '', toCzk(r.a5.base21Hal), toCzk(r.a5.vat21Hal), toCzk(r.a5.base12Hal), toCzk(r.a5.vat12Hal)]);
  [6, 7, 8, 9].forEach((i) => (a5.getCell(i).numFmt = NUM_FMT));
  k.addRow([]);
  k.addRow(['B.2 — Přijatá plnění nad 10 000 Kč vč. DPH']).font = { bold: true };
  styleHeader(k.addRow(['Ř.', 'Dodavatel', 'DIČ dodavatele', 'Ev. č. dokladu', 'DPPD', 'Základ 21 %', 'Daň 21 %', 'Základ 12 %', 'Daň 12 %']));
  r.b2.forEach((d, i) => {
    const x = k.addRow([i + 1, d.supplier, d.ico ?? '', d.documentNumber, toCzechDate(d.date), toCzk(d.base21Hal), toCzk(d.vat21Hal), toCzk(d.base12Hal), toCzk(d.vat12Hal)]);
    [6, 7, 8, 9].forEach((j) => (x.getCell(j).numFmt = NUM_FMT));
  });
  if (r.b2.length === 0) k.addRow(['', '(žádné)']);
  k.addRow([]);
  k.addRow(['B.3 — Přijatá plnění do 10 000 Kč vč. DPH (souhrnně)']).font = { bold: true };
  styleHeader(k.addRow(['', `${r.b3.docs.length} dokladů`, '', '', '', 'Základ 21 %', 'Daň 21 %', 'Základ 12 %', 'Daň 12 %']));
  const b3 = k.addRow(['', '', '', '', '', toCzk(r.b3.totals.base21Hal), toCzk(r.b3.totals.vat21Hal), toCzk(r.b3.totals.base12Hal), toCzk(r.b3.totals.vat12Hal)]);
  [6, 7, 8, 9].forEach((i) => (b3.getCell(i).numFmt = NUM_FMT));

  // Doklady (ledger)
  const d = wb.addWorksheet('Doklady');
  d.columns = LEDGER_HEADERS.map(([key, header]) => ({ header, key, width: MONEY_KEYS.has(key) ? 14 : key === 'protistrana' || key === 'poznamka' ? 36 : 16 }));
  styleHeader(d.getRow(1));
  for (const row of ledgerRows(r)) {
    const values: Record<string, unknown> = { ...row };
    for (const key of MONEY_KEYS) values[key] = row[key] === null ? null : toCzk(row[key] as number);
    values.datum = row.datum ? toCzechDate(row.datum) : '';
    values.datumKurzu = row.datumKurzu ? toCzechDate(row.datumKurzu) : '';
    const x = d.addRow(values);
    for (const key of MONEY_KEYS) x.getCell(key).numFmt = NUM_FMT;
  }
  d.views = [{ state: 'frozen', ySplit: 1 }];

  // Upozornění
  const f = wb.addWorksheet('Upozornění');
  f.columns = [{ header: 'Závažnost', key: 'sev', width: 12 }, { header: 'Upozornění', key: 'title', width: 60 }, { header: 'Položka', key: 'item', width: 60 }, { header: 'Částka', key: 'amt', width: 14 }, { header: 'Datum', key: 'date', width: 12 }];
  styleHeader(f.getRow(1));
  const sev = { error: 'Chyba', warning: 'Varování', info: 'Info' } as const;
  for (const flag of r.flags) {
    if (!flag.items || flag.items.length === 0) f.addRow({ sev: sev[flag.severity], title: flag.title, item: flag.detail ?? '' });
    for (const it of flag.items ?? []) {
      const x = f.addRow({ sev: sev[flag.severity], title: flag.title, item: it.label, amt: it.amountHal !== undefined ? toCzk(it.amountHal) : null, date: it.date ? toCzechDate(it.date) : '' });
      x.getCell('amt').numFmt = NUM_FMT;
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

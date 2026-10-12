/**
 * HTML for the VAT month PDF (rendered by utils/pdfGenerate). Czech — it is the
 * accountant's document: VAT return rows, control statement sections, flags,
 * payment details with a QR code, and a document appendix.
 */
import QRCodeLib from 'qrcode';
import type { VatConfig, VatMonthResult } from '@/types/vat';
import { formatHal } from './money';
import { toCzechDate } from './czechCalendar';
import { TAX_OFFICE } from './config';
import { DAP_ROW_CS } from './exports';

const esc = (s: string | number | null | undefined) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const h = (v: number) => formatHal(v);
const kc = (n: number | null) => (n === null ? '' : formatHal(n * 100, { decimals: 0 }));

export function vatPaymentSpayd(cfg: VatConfig, r: VatMonthResult): string | null {
  if (r.mode !== 'live' || r.dap.payableCzk <= 0) return null;
  return `SPD*1.0*ACC:${TAX_OFFICE.vatIban}*AM:${r.dap.payableCzk}.00*CC:CZK*X-VS:${cfg.dic}*MSG:DPH ${r.month.slice(5)}/${r.month.slice(0, 4)}`;
}

export async function buildVatPdfHtml(r: VatMonthResult, cfg: VatConfig): Promise<string> {
  const period = `${r.month.slice(5)}/${r.month.slice(0, 4)}`;
  const spayd = vatPaymentSpayd(cfg, r);
  const qr = spayd ? await QRCodeLib.toDataURL(spayd, { margin: 1, width: 180 }) : null;
  const sev = { error: 'Chyba', warning: 'Varování', info: 'Info' } as const;
  const payableLabel = r.dap.refundCzk > 0 ? 'Nadměrný odpočet (ř. 65)' : 'Vlastní daň (ř. 64)';
  const payableValue = r.dap.refundCzk > 0 ? r.dap.refundCzk : r.dap.payableCzk;

  const dapRows = r.dap.rows.map((row) => `<tr><td>ř. ${esc(row.row)}</td><td>${esc(DAP_ROW_CS[row.row] ?? row.label)}</td><td class="n">${kc(row.baseCzk)}</td><td class="n">${kc(row.taxCzk)}</td></tr>`).join('');
  const a2Rows = r.a2.map((a, i) => `<tr><td>${i + 1}</td><td>${esc(a.supplier)}</td><td>${esc(a.countryCode && a.vatId ? a.countryCode + a.vatId : '—')}</td>
    <td>${a.documentNumber ? esc(a.documentNumber) : '<span class="warn">doplnit</span>'}</td><td>${toCzechDate(a.dppd)}</td>
    <td class="n">${a.currency !== 'CZK' ? `${esc((a.originalMinor / 100).toFixed(2))} ${esc(a.currency)} × ${esc(a.fxRate?.toFixed(3))}` : ''}</td>
    <td class="n">${h(a.baseHal)}</td><td class="n">${h(a.vatHal)}</td></tr>`).join('');
  const b2Rows = r.b2.map((d, i) => `<tr><td>${i + 1}</td><td>${esc(d.supplier)}</td><td>${esc(d.ico ?? '—')}</td><td>${esc(d.documentNumber)}</td>
    <td>${toCzechDate(d.date)}</td><td class="n">${h(d.base21Hal)}</td><td class="n">${h(d.vat21Hal)}</td><td class="n">${h(d.base12Hal)}</td><td class="n">${h(d.vat12Hal)}</td></tr>`).join('');
  const flagRows = r.flags.map((f) => `<div class="flag ${f.severity}"><b>${sev[f.severity]}:</b> ${esc(f.title)}
    ${f.items && f.items.length ? `<ul>${f.items.slice(0, 12).map((it) => `<li>${esc(it.label)}${it.amountHal !== undefined ? ` — ${h(it.amountHal)} Kč` : ''}${it.decision ? ` <i>(${esc(it.decision)})</i>` : ''}</li>`).join('')}${f.items.length > 12 ? `<li>… a dalších ${f.items.length - 12}</li>` : ''}</ul>` : ''}</div>`).join('');
  const revRows = r.revenue.lines.map((l) => `<tr><td>${toCzechDate(l.taxPoint)}</td><td>${esc(l.label)}</td><td>${esc(l.taxPointRule)}</td><td class="n">${l.ratePct} %</td>
    <td class="n">${h(l.grossHal)}</td><td class="n">${h(l.baseHal)}</td><td class="n">${h(l.vatHal)}</td></tr>`).join('');
  const b3Rows = r.b3.docs.map((d) => `<tr><td>${toCzechDate(d.date)}</td><td>${esc(d.supplier)}</td><td>${esc(d.documentNumber)}</td><td class="n">${h(d.totalHal)}</td>
    <td class="n">${h(d.vat21Hal)}</td><td class="n">${h(d.vat12Hal)}</td></tr>`).join('');
  const exRows = r.excluded.map((x) => `<tr><td>${toCzechDate(x.date)}</td><td>${esc(x.supplier)}</td><td>${esc(x.documentNumber)}</td><td class="n">${h(x.totalHal)} ${x.currency !== 'CZK' ? esc(x.currency) : ''}</td><td>${esc(x.reasonLabel)}</td></tr>`).join('');

  return `<!doctype html><html lang="cs"><head><meta charset="utf-8"><style>
    body{font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:9.5px;color:#111;margin:0}
    h1{font-size:17px;margin:0 0 2px} h2{font-size:12px;margin:16px 0 6px;border-bottom:1px solid #ddd;padding-bottom:3px}
    .muted{color:#666} .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-weight:600;font-size:9px}
    .sim{background:#fef3c7;color:#92400e} .live{background:#dcfce7;color:#166534}
    .cards{display:flex;gap:8px;margin:10px 0} .card{flex:1;border:1px solid #e5e7eb;border-radius:8px;padding:8px}
    .card b{display:block;font-size:14px;margin-top:2px}
    table{width:100%;border-collapse:collapse;margin-bottom:4px} th,td{padding:3px 5px;border-bottom:1px solid #f0f0f0;text-align:left;vertical-align:top}
    th{background:#f8fafc;font-weight:600} .n{text-align:right;white-space:nowrap}
    .flag{margin:3px 0;padding:4px 6px;border-radius:5px} .flag ul{margin:2px 0 0 14px;padding:0}
    .error{background:#fee2e2} .warning{background:#fef3c7} .info{background:#f1f5f9}
    .warn{color:#b45309;font-weight:600} .pay{display:flex;gap:12px;align-items:center;border:1px solid #c7d2fe;background:#eef2ff;border-radius:8px;padding:8px;margin:8px 0}
    .pb{page-break-before:always}
  </style></head><body>
  <h1>Přehled DPH za ${period} — ${esc(cfg.companyName)}</h1>
  <div class="muted">DIČ CZ${esc(cfg.dic)} · ${esc(TAX_OFFICE.name)} (c_ufo ${esc(cfg.cUfo)}, pracoviště ${esc(cfg.cPracufo)}) ·
    období ${toCzechDate(r.periodStart)} – ${toCzechDate(r.periodEnd)} ·
    <span class="badge ${r.mode === 'live' ? 'live' : 'sim'}">${r.mode === 'live' ? 'PLÁTCE DPH' : 'SIMULACE — nepodává se'}</span></div>
  <div class="cards">
    <div class="card">Daň na výstupu (ř. 62)<b>${kc(r.dap.outputTaxCzk)} Kč</b></div>
    <div class="card">Odpočet daně (ř. 63)<b>${kc(r.dap.deductionCzk)} Kč</b></div>
    <div class="card">${payableLabel}<b>${kc(payableValue)} Kč</b></div>
    <div class="card">Termín podání a úhrady<b>${r.mode === 'live' ? toCzechDate(r.deadline) : '—'}</b></div>
  </div>
  ${spayd ? `<div class="pay">${qr ? `<img src="${qr}" width="110" height="110"/>` : ''}<div><b>Úhrada DPH</b><br/>
    Účet ${esc(TAX_OFFICE.vatAccount)} (IBAN ${esc(TAX_OFFICE.vatIban)})<br/>Variabilní symbol ${esc(cfg.dic)} · Částka ${kc(r.dap.payableCzk)} Kč<br/>
    <span class="muted">Platba musí být připsána na účet FÚ nejpozději ${toCzechDate(r.deadline)}.</span></div></div>` : ''}

  <h2>Přiznání k DPH (v celých Kč)</h2>
  <table><tr><th>Řádek</th><th>Popis</th><th class="n">Základ</th><th class="n">Daň</th></tr>${dapRows}</table>

  <h2>Kontrolní hlášení</h2>
  <b>A.2 — přijatá plnění, daň přiznává příjemce (${r.a2.length})</b>
  <table><tr><th>#</th><th>Dodavatel</th><th>DIČ</th><th>Ev. č. dokladu</th><th>DPPD</th><th class="n">Měna × kurz ČNB</th><th class="n">Základ</th><th class="n">Daň 21 %</th></tr>${a2Rows || '<tr><td colspan="8">—</td></tr>'}</table>
  <b>A.5 — ostatní uskutečněná plnění (souhrnně)</b>
  <table><tr><th class="n">Základ 21 %</th><th class="n">Daň 21 %</th><th class="n">Základ 12 %</th><th class="n">Daň 12 %</th></tr>
    <tr><td class="n">${h(r.a5.base21Hal)}</td><td class="n">${h(r.a5.vat21Hal)}</td><td class="n">${h(r.a5.base12Hal)}</td><td class="n">${h(r.a5.vat12Hal)}</td></tr></table>
  <b>B.2 — přijatá plnění nad 10 000 Kč vč. DPH (${r.b2.length})</b>
  <table><tr><th>#</th><th>Dodavatel</th><th>IČO/DIČ</th><th>Ev. č. dokladu</th><th>DPPD</th><th class="n">Základ 21 %</th><th class="n">Daň 21 %</th><th class="n">Základ 12 %</th><th class="n">Daň 12 %</th></tr>${b2Rows || '<tr><td colspan="9">—</td></tr>'}</table>
  <b>B.3 — přijatá plnění do 10 000 Kč vč. DPH (souhrnně, ${r.b3.docs.length} dokladů)</b>
  <table><tr><th class="n">Základ 21 %</th><th class="n">Daň 21 %</th><th class="n">Základ 12 %</th><th class="n">Daň 12 %</th></tr>
    <tr><td class="n">${h(r.b3.totals.base21Hal)}</td><td class="n">${h(r.b3.totals.vat21Hal)}</td><td class="n">${h(r.b3.totals.base12Hal)}</td><td class="n">${h(r.b3.totals.vat12Hal)}</td></tr></table>
  <b>C — kontrolní řádky</b>
  <table><tr><th>obrat23 (ř. 1)</th><th>obrat5 (ř. 2)</th><th>pln23 (ř. 40)</th><th>pln5 (ř. 41)</th><th>celk_zd_a2 (ř. 3–13)</th></tr>
    <tr><td>${h(r.khC.obrat23)}</td><td>${h(r.khC.obrat5)}</td><td>${h(r.khC.pln23)}</td><td>${h(r.khC.pln5)}</td><td>${h(r.khC.celkZdA2)}</td></tr></table>

  <h2>Upozornění (${r.flags.length})</h2>
  ${flagRows || '<div class="muted">Žádná upozornění.</div>'}

  <h2 class="pb">Příloha — tržby (${r.revenue.lines.length})</h2>
  <table><tr><th>Datum</th><th>Položka</th><th>Určení data</th><th class="n">Sazba</th><th class="n">Vč. DPH</th><th class="n">Základ</th><th class="n">DPH</th></tr>${revRows || '<tr><td colspan="7">—</td></tr>'}</table>
  <h2>Příloha — doklady B.3 (${r.b3.docs.length})</h2>
  <table><tr><th>DUZP</th><th>Dodavatel</th><th>Doklad</th><th class="n">Celkem</th><th class="n">DPH 21 %</th><th class="n">DPH 12 %</th></tr>${b3Rows || '<tr><td colspan="6">—</td></tr>'}</table>
  <h2>Příloha — doklady mimo přiznání (${r.excluded.length})</h2>
  <table><tr><th>Datum</th><th>Dodavatel</th><th>Doklad</th><th class="n">Celkem</th><th>Důvod</th></tr>${exRows || '<tr><td colspan="5">—</td></tr>'}</table>
  <p class="muted">Vygenerováno ${esc(new Date(r.generatedAt).toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' }))} z baker-house-reporting. Částky v Kč.</p>
  </body></html>`;
}

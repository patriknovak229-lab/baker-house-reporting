/**
 * Renders the annual commission overview as a print-ready landscape HTML
 * document. Consumed by /api/commission/annual-pdf → generatePDF.
 *
 * The row order and labels come from `annualLineSpecs`, the same helper the
 * on-screen table uses, so the export can never show a different waterfall
 * from the one the operator was looking at when they clicked Export.
 */
import type { AnnualOverview, AnnualRow, AnnualLineSpec } from '@/utils/commissionYear';
import { annualLineSpecs } from '@/utils/commissionYear';

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function kc(n: number): string {
  const rounded = Math.round(n);
  if (rounded === 0) return '0';
  const s = Math.abs(rounded).toLocaleString('cs-CZ').replace(/ /g, ' ').replace(/,/g, ' ');
  return `${rounded < 0 ? '−' : ''}${s}`;
}

function cell(v: number | null): string {
  return v === null ? '<span class="na">—</span>' : kc(v);
}

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function lineRow(spec: AnnualLineSpec): string {
  const cls = `k-${spec.kind}`;
  const months = spec.values.map((v) => `<td class="num">${cell(v)}</td>`).join('');
  const indent = spec.kind === 'sub-item' ? '<span class="bullet">·</span> ' : '';
  return `<tr class="${cls}">
    <td class="lbl">${indent}${esc(spec.label)}</td>
    ${months}
    <td class="num tot">${kc(spec.total)}</td>
    <td class="num avg">${kc(spec.average)}</td>
  </tr>`;
}

function roomTable(row: AnnualRow): string {
  const head = row.cells
    .map((c, i) => {
      const mark = c?.source === 'issued' ? '<span class="iss">✓</span>' : '';
      return `<th class="num">${MONTH_ABBR[i]}${mark}</th>`;
    })
    .join('');
  return `<table class="grid">
    <thead>
      <tr>
        <th class="lbl"></th>
        ${head}
        <th class="num tot">Total</th>
        <th class="num avg">Avg / mo</th>
      </tr>
    </thead>
    <tbody>${annualLineSpecs(row).map(lineRow).join('')}</tbody>
  </table>`;
}

function sectionTitle(row: AnnualRow): string {
  const owner = row.ownerName === '—' ? '' : ` · Owner: ${esc(row.ownerName)}`;
  const badge = row.isAggregate
    ? ''
    : row.commissionable
    ? `<span class="pill pay">${Math.round(row.commissionRate * 100)}% commission</span>`
    : '<span class="pill own">BHA-owned — no commission</span>';
  const pool = row.mode === 'urban-pool' ? '<span class="pill pool">Urban pool ÷3</span>' : '';
  const issued = row.issuedCount > 0 ? `<span class="pill iss2">${row.issuedCount} issued</span>` : '';
  return `<div class="sec">
    <span class="secname">${esc(row.room)}</span>
    <span class="secsub">${esc(row.typeLabel)}${owner}</span>
    ${badge}${pool}${issued}
  </div>`;
}

export function buildAnnualOverviewHTML(overview: AnnualOverview): string {
  const rooms = [...overview.rows, ...(overview.unallocated ? [overview.unallocated] : [])];

  const coverageNote = overview.uncoveredMonths.length
    ? `<div class="note">No data for ${overview.uncoveredMonths
        .map((m) => MONTH_ABBR[Number(m.slice(5, 7)) - 1])
        .join(', ')} — outside the loaded booking window${
        overview.coverage ? ` (${overview.coverage.from} – ${overview.coverage.to})` : ''
      } and no settlement was issued. Shown as “—”, excluded from totals.</div>`
    : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111827; margin: 0; font-size: 8px; background: #fff; }
  h1 { font-size: 17px; margin: 0; }
  .subtitle { color: #6B7280; font-size: 10px; margin: 2px 0 8px; }
  .rule { height: 2px; background: #4F46E5; margin: 5px 0 10px; }
  .meta { color: #4B5563; font-size: 9px; margin-bottom: 8px; }
  .meta b { color: #111827; }
  .note { color: #B45309; background: #FFFBEB; border: 1px solid #FDE68A; border-radius: 4px;
          padding: 4px 7px; font-size: 8px; margin-bottom: 8px; }
  .sec { margin: 12px 0 4px; display: flex; align-items: baseline; gap: 7px; }
  .sec.first { margin-top: 0; }
  .secname { font-size: 12px; font-weight: 700; color: #111827; }
  .secsub { font-size: 8.5px; color: #6B7280; }
  .pill { font-size: 7px; font-weight: 700; padding: 1px 5px; border-radius: 999px; text-transform: uppercase; letter-spacing: .03em; }
  .pill.pay  { background: #FEF3C7; color: #B45309; }
  .pill.own  { background: #F1F5F9; color: #64748B; }
  .pill.pool { background: #CCFBF1; color: #0F766E; }
  .pill.iss2 { background: #E0E7FF; color: #4338CA; }

  table.grid { width: 100%; border-collapse: collapse; table-layout: fixed; page-break-inside: avoid; }
  table.grid th, table.grid td { padding: 2px 3px; font-size: 7.4px; border-bottom: 1px solid #F1F5F9; }
  table.grid th { background: #F8FAFC; color: #64748B; font-size: 7px; text-transform: uppercase;
                  letter-spacing: .03em; border-bottom: 1px solid #E2E8F0; }
  table.grid th.lbl, table.grid td.lbl { text-align: left; width: 16%; }
  table.grid td.num, table.grid th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  table.grid td.tot, table.grid th.tot { border-left: 1px solid #CBD5E1; font-weight: 700; }
  table.grid td.avg, table.grid th.avg { color: #475569; }
  .na { color: #CBD5E1; }
  .iss { color: #4F46E5; font-size: 6.5px; margin-left: 1px; }
  .bullet { color: #94A3B8; }

  tr.k-revenue td { font-weight: 700; }
  tr.k-deduction td.num { color: #E11D48; }
  tr.k-sub-item td { color: #64748B; font-size: 7px; }
  tr.k-sub-item td.lbl { padding-left: 10px; }
  tr.k-sub-item td.num { color: #FB7185; }
  tr.k-subtotal td { background: #F1F5F9; font-weight: 700; }
  tr.k-result td { background: #EEF2FF; color: #4338CA; font-weight: 700; }
  tr.k-payout td { background: #ECFDF5; color: #047857; font-weight: 700; border-bottom: none; }

  .legend { margin-top: 10px; padding-top: 6px; border-top: 1px solid #E5E7EB;
            color: #6B7280; font-size: 7.5px; line-height: 1.5; }
  </style></head><body>
    <h1>Baker House Apartments</h1>
    <div class="subtitle">Annual Overview — Owner Settlements &amp; Management Commission · ${overview.year}</div>
    <div class="rule"></div>
    <div class="meta">
      <b>Period</b> January – December ${overview.year} &nbsp;·&nbsp;
      <b>Manager</b> Truthseeker s.r.o. (BHA) &nbsp;·&nbsp;
      <b>Averages</b> over ${overview.activeMonths} month${overview.activeMonths === 1 ? '' : 's'} with activity &nbsp;·&nbsp;
      <b>Generated</b> ${new Date().toLocaleDateString('en-GB')}
    </div>
    ${coverageNote}

    ${sectionTitle(overview.total).replace('class="sec"', 'class="sec first"')}
    ${roomTable(overview.total)}

    ${rooms.map((r) => `${sectionTitle(r)}${roomTable(r)}`).join('')}

    <div class="legend">
      <b>Method.</b> Gross Profit = Net Sales − operational costs, where Net Sales = Gross Booking Value
      − OTA commission − payment fees. Revenue is Beds24 data; operational costs (cleaning, laundry,
      consumables, subscriptions, wear &amp; tear, misc) come from the Baker House cleaning app on a
      checkout-date basis, with each recurring subscription itemised on its own line. Urban gross profit
      is pooled across K.102 / K.103 / K.106 and divided equally by 3, so a figure does not depend on which
      physical unit a reservation was allocated to. BHA-owned apartments (K.103, K.201, K.202, K.203) carry
      no management commission and therefore show 0 on the commission and payable lines.
      <br/><b>✓</b> next to a month = figures taken from the settlement issued for that month (frozen at
      issue time). Months without the mark are computed live from current data and remain provisional.
      <br/>reporting.bakerhouseapartments.cz
    </div>
  </body></html>`;
}

/**
 * Renders the annual overview as a print-ready landscape HTML document.
 * Consumed by /api/commission/annual-pdf → generatePDF.
 *
 * One table, apartments stacked as row groups — the same single-grid shape as
 * the screen. Rows come from `annualLineTree`, shared with the UI so the export
 * can never show a different waterfall from the one the operator was looking at
 * when they clicked Export. Paper has no disclosure triangles, so the tree is
 * flattened fully expanded: the PDF is the archive copy and should carry the
 * whole breakdown, including each subscription line.
 */
import type { AnnualOverview, AnnualRow, AnnualLineNode } from '@/utils/commissionYear';
import { annualLineTree, flattenLineTree } from '@/utils/commissionYear';

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function kc(n: number): string {
  const rounded = Math.round(n);
  if (rounded === 0) return '0';
  const s = Math.abs(rounded).toLocaleString('cs-CZ').replace(/ /g, ' ').replace(/,/g, ' ');
  return `${rounded < 0 ? '−' : ''}${s}`;
}

function cell(v: number | null): string {
  return v === null ? '<span class="na">—</span>' : kc(v);
}

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function lineRow(node: AnnualLineNode, depth: number): string {
  const months = node.values.map((v) => `<td class="num">${cell(v)}</td>`).join('');
  return `<tr class="k-${node.kind}">
    <td class="lbl" style="padding-left:${8 + depth * 11}px">${esc(node.label)}</td>
    ${months}
    <td class="num tot">${kc(node.total)}</td>
    <td class="num avg">${kc(node.average)}</td>
  </tr>`;
}

/** An apartment's banner row plus its fully-expanded P&L. */
function roomGroup(row: AnnualRow): string {
  const tags = [
    row.mode === 'urban-pool' ? '<span class="pill pool">pool ÷3</span>' : '',
    !row.commissionable && !row.isAggregate ? '<span class="pill own">BHA-owned</span>' : '',
    row.issuedCount > 0 ? `<span class="pill iss2">${row.issuedCount} issued</span>` : '',
  ].filter(Boolean).join(' ');
  const owner = row.ownerName === '—' ? '' : ` · ${esc(row.ownerName)}`;
  const months = row.cells
    .map((c) => `<td class="num">${c === null ? '<span class="na">—</span>' : kc(c.grossProfit)}${c?.source === 'issued' ? '<span class="iss">✓</span>' : ''}</td>`)
    .join('');

  return `<tr class="room${row.isAggregate ? ' agg' : ''}">
      <td class="lbl"><b>${esc(row.room)}</b> <span class="sub">${esc(row.typeLabel)}${owner}</span> ${tags}</td>
      ${months}
      <td class="num tot">${kc(row.total.grossProfit)}</td>
      <td class="num avg">${kc(row.average.grossProfit)}</td>
    </tr>
    ${flattenLineTree(annualLineTree(row)).map(({ node, depth }) => lineRow(node, depth)).join('')}`;
}

export function buildAnnualOverviewHTML(overview: AnnualOverview): string {
  const rows = [overview.total, ...overview.rows, ...(overview.unallocated ? [overview.unallocated] : [])];

  const coverageNote = overview.uncoveredMonths.length
    ? `<div class="note">No data for ${overview.uncoveredMonths
        .map((m) => MONTH_ABBR[Number(m.slice(5, 7)) - 1])
        .join(', ')} — outside the loaded booking window${
        overview.coverage ? ` (${overview.coverage.from} – ${overview.coverage.to})` : ''
      } and no settlement was issued. Shown as “—”, excluded from totals.</div>`
    : '';

  const head = `<tr>
      <th class="lbl">${overview.year}</th>
      ${MONTH_ABBR.map((m) => `<th class="num">${m}</th>`).join('')}
      <th class="num tot">Total</th>
      <th class="num avg">Avg / mo</th>
    </tr>`;

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

  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { padding: 2px 3px; font-size: 7.4px; border-bottom: 1px solid #F1F5F9; }
  thead th { background: #F8FAFC; color: #64748B; font-size: 7px; text-transform: uppercase;
             letter-spacing: .03em; border-bottom: 1px solid #CBD5E1; }
  th.lbl, td.lbl { text-align: left; width: 17%; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.tot, th.tot { border-left: 1px solid #CBD5E1; font-weight: 700; }
  td.avg, th.avg { color: #475569; }
  .na { color: #CBD5E1; }
  .iss { color: #4F46E5; font-size: 6.5px; margin-left: 1px; }
  .sub { color: #94A3B8; font-size: 6.8px; font-weight: 400; }
  .pill { font-size: 6.2px; font-weight: 700; padding: 0 4px; border-radius: 999px;
          text-transform: uppercase; letter-spacing: .03em; }
  .pill.own  { background: #F1F5F9; color: #64748B; }
  .pill.pool { background: #CCFBF1; color: #0F766E; }
  .pill.iss2 { background: #E0E7FF; color: #4338CA; }

  /* An apartment banner: its own row, carrying gross profit like on screen. */
  tr.room td { background: #E2E8F0; font-size: 8.4px; font-weight: 700; padding: 3px;
               border-top: 2px solid #94A3B8; border-bottom: 1px solid #94A3B8; }
  tr.room.agg td { background: #CBD5E1; }
  tr.room { page-break-inside: avoid; page-break-after: avoid; }

  tr.k-revenue td { font-weight: 700; }
  tr.k-deduction td.num { color: #E11D48; }
  tr.k-sub-item td { color: #64748B; font-size: 7px; }
  tr.k-sub-item td.num { color: #FB7185; }
  tr.k-subtotal td { background: #F1F5F9; font-weight: 700; }
  tr.k-result td { background: #EEF2FF; color: #4338CA; font-weight: 700; }

  .legend { margin-top: 10px; padding-top: 6px; border-top: 1px solid #E5E7EB;
            color: #6B7280; font-size: 7.5px; line-height: 1.5; }
  </style></head><body>
    <h1>Baker House Apartments</h1>
    <div class="subtitle">Annual Overview — Trading by Apartment · ${overview.year}</div>
    <div class="rule"></div>
    <div class="meta">
      <b>Period</b> January – December ${overview.year} &nbsp;·&nbsp;
      <b>Manager</b> Truthseeker s.r.o. (BHA) &nbsp;·&nbsp;
      <b>Averages</b> over ${overview.activeMonths} month${overview.activeMonths === 1 ? '' : 's'} with activity &nbsp;·&nbsp;
      <b>Generated</b> ${new Date().toLocaleDateString('en-GB')}
    </div>
    ${coverageNote}
    <table>
      <thead>${head}</thead>
      <tbody>${rows.map(roomGroup).join('')}</tbody>
    </table>
    <div class="legend">
      <b>Method.</b> Gross Profit = Net Sales − operational costs, where Net Sales = Gross Booking Value
      − OTA commission − payment fees. Revenue is Beds24 data; operational costs (cleaning, laundry,
      consumables, subscriptions, wear &amp; tear, misc) come from the Baker House cleaning app on a
      checkout-date basis, with each recurring subscription itemised on its own line. Urban figures are
      pooled across K.102 / K.103 / K.106 and divided equally by 3, so a figure does not depend on which
      physical unit a reservation was allocated to. The apartment banner row carries that apartment's
      gross profit. Management commission is not shown here — see the monthly owner settlement statement.
      <br/><b>✓</b> next to a month = figures taken from the settlement issued for that month (frozen at
      issue time). Months without the mark are computed live and remain provisional.
      <br/>reporting.bakerhouseapartments.cz
    </div>
  </body></html>`;
}

/**
 * Renders an owner-settlement statement as a print-ready HTML document.
 * Consumed by /api/commission/pdf → generatePDF (headless Chromium).
 *
 * Layout mirrors the ad-hoc statement:
 *   Step 1 — Urban pool waterfall (urban-pool units only)
 *   Step 2 — This apartment's share
 *   Step 3 — Management commission & owner payout
 */
import type { CommissionSettlement } from '@/types/commissionSettlement';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function kc(n: number): string {
  const rounded = Math.round(n);
  const s = Math.abs(rounded).toLocaleString('cs-CZ').replace(/ /g, ' ').replace(/,/g, ' ');
  return `${rounded < 0 ? '−' : ''}${s} Kč`;
}

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

function ddmm(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

interface Row {
  label: string;
  amount: number;
  deduction?: boolean;
  subtotal?: boolean;
  total?: 'indigo' | 'emerald';
  detail?: string;
}

function table(rows: Row[]): string {
  return `<table class="w">${rows
    .map((r) => {
      const cls = [
        r.deduction ? 'ded' : '',
        r.subtotal ? 'sub' : '',
        r.total ? `tot ${r.total}` : '',
      ].filter(Boolean).join(' ');
      const amt = r.deduction ? `− ${kc(Math.abs(r.amount))}` : kc(r.amount);
      const label = r.detail
        ? `${r.label} <span class="dt">${r.detail}</span>`
        : r.label;
      return `<tr class="${cls}"><td>${label}</td><td class="num">${amt}</td></tr>`;
    })
    .join('')}</table>`;
}

export function buildSettlementHTML(s: CommissionSettlement): string {
  const isUrban = s.mode === 'urban-pool';
  const div = s.poolDivisor ?? 1;
  const pool = (v: number) => v * div; // stored figures are the unit's share

  const step1 = isUrban
    ? `
    <div class="section">STEP 1 · URBAN POOL — ALL ${div} APARTMENTS (${(s.poolRooms ?? []).join(' + ')})</div>
    <div class="note">Urban units are sold under a single room type, so performance is measured on the pool and split equally per apartment.</div>
    ${table([
      { label: 'Gross Booking Value', amount: pool(s.gbv) },
      { label: 'Less: OTA / channel commission', amount: pool(s.otaCommission), deduction: true },
      { label: 'Less: Payment / processing fees', amount: pool(s.paymentFees), deduction: true },
      { label: 'Net Sales', amount: pool(s.netSales), subtotal: true },
      { label: 'Less: Cleaning', amount: pool(s.cleaning), deduction: true },
      { label: 'Less: Laundry', amount: pool(s.laundry), deduction: true },
      { label: 'Less: Consumables', amount: pool(s.consumables), deduction: true },
      { label: 'Less: Subscriptions (internet / TV)', amount: pool(s.subscriptions), deduction: true },
      { label: 'Less: Wear &amp; Tear', amount: pool(s.wearTear), deduction: true },
      { label: 'Less: Misc / Damages', amount: pool(s.misc), deduction: true },
      { label: 'Gross Profit — pool', amount: pool(s.grossProfit), total: 'indigo' },
    ])}`
    : '';

  const step2Title = isUrban
    ? `STEP 2 · ${s.unitId} SHARE = POOL ÷ ${div}`
    : `STEP 1 · ${s.unitId} — GROSS PROFIT`;

  const step2 = `
    <div class="section">${step2Title}</div>
    ${table([
      { label: 'Gross Booking Value', amount: s.gbv },
      { label: 'Less: Commission + payment fees', amount: s.otaCommission + s.paymentFees, deduction: true },
      { label: 'Net Sales', amount: s.netSales, subtotal: true },
      { label: 'Less: Cleaning', amount: s.cleaning, deduction: true },
      { label: 'Less: Laundry', amount: s.laundry, deduction: true },
      { label: 'Less: Consumables', amount: s.consumables, deduction: true },
      { label: 'Less: Subscriptions', amount: s.subscriptions, deduction: true },
      { label: 'Less: Wear &amp; Tear', amount: s.wearTear, deduction: true },
      { label: 'Less: Misc / Damages', amount: s.misc, deduction: true },
      { label: `Gross Profit — ${s.unitId}`, amount: s.grossProfit, total: 'indigo' },
    ])}`;

  const step3 = `
    <div class="section">STEP ${isUrban ? '3' : '2'} · MANAGEMENT COMMISSION &amp; OWNER PAYOUT</div>
    ${table([
      { label: `Gross Profit — ${s.unitId}`, amount: s.grossProfit },
      { label: `BHA management commission (${Math.round(s.commissionRate * 100)}% of gross profit)`, amount: s.commissionAmount, deduction: true },
      { label: 'AMOUNT PAYABLE TO OWNER', amount: s.payableToOwner, total: 'emerald' },
    ])}`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111827; margin: 0; font-size: 12px; background: #ffffff; }
  h1 { font-size: 22px; margin: 0; color: #111827; }
  .subtitle { color: #6B7280; font-size: 12px; margin: 2px 0 10px; }
  .rule { height: 2px; background: #4F46E5; margin: 6px 0 12px; }
  .meta { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
  .meta td { padding: 2px 0; font-size: 12px; vertical-align: top; }
  .meta .k { font-weight: 700; width: 90px; }
  .meta .k2 { font-weight: 700; width: 70px; padding-left: 18px; }
  .section { color: #4F46E5; font-weight: 700; font-size: 10.5px; letter-spacing: .04em;
             text-transform: uppercase; margin: 18px 0 6px; }
  .note { color: #6B7280; font-size: 10px; margin-bottom: 6px; }
  table.w { width: 100%; border-collapse: collapse; }
  table.w td { padding: 6px 10px; border-bottom: 1px solid #E5E7EB; font-size: 12px; }
  table.w td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  table.w tr.ded td.num { color: #E11D48; }
  table.w tr.sub td { background: #F3F4F6; font-weight: 700; }
  table.w tr.tot td { font-weight: 700; font-size: 14px; padding: 9px 10px; border-bottom: none; }
  table.w tr.tot.indigo td { background: #EEF2FF; color: #4F46E5; }
  table.w tr.tot.emerald td { background: #ECFDF5; color: #059669; }
  .dt { color: #9CA3AF; font-size: 10px; }
  .footer { margin-top: 16px; padding-top: 8px; border-top: 1px solid #E5E7EB;
            color: #6B7280; font-size: 9.5px; line-height: 1.5; }
  .status { display: inline-block; margin-top: 6px; padding: 2px 8px; border-radius: 999px;
            font-size: 9.5px; font-weight: 700; }
  .ok { background: #ECFDF5; color: #059669; }
  .warn { background: #FEF3C7; color: #B45309; }
  </style></head><body>
    <h1>Baker House Apartments</h1>
    <div class="subtitle">Owner Settlement Statement — Management Commission</div>
    <div class="rule"></div>
    <table class="meta">
      <tr>
        <td class="k">Apartment</td><td>${s.unitId} — ${
          // typeLabel isn't stored on the snapshot; infer a friendly label
          isUrban ? '1KK Urban Studio' : 'Standalone unit'
        }</td>
        <td class="k2">Period</td><td>${monthLabel(s.month)} (${ddmm(s.periodStart)} – ${ddmm(s.periodEnd)})</td>
      </tr>
      <tr>
        <td class="k">Owner</td><td>${s.ownerName}</td>
        <td class="k2">Manager</td><td>Truthseeker s.r.o. (BHA)</td>
      </tr>
    </table>
    <span class="status ${s.reconciles ? 'ok' : 'warn'}">${
      s.reconciles ? '✓ Reconciled with cleaning app' : '⚠ Review — ' + (s.reconcileNote ?? 'cleaning mismatch')
    }</span>
    ${step1}
    ${step2}
    ${step3}
    <div class="footer">
      <b>Method.</b> Gross Profit = Net Sales − operational costs, where Net Sales = Gross Booking Value
      − OTA commission − payment fees. Revenue is live Beds24 data; operational costs (cleaning, laundry,
      consumables, subscriptions, wear &amp; tear) come from the Baker House cleaning app on a checkout-date
      basis. ${isUrban ? `Urban gross profit is pooled across ${(s.poolRooms ?? []).join(' / ')} and divided equally by ${div}, so the result does not depend on which physical unit a reservation was allocated to. ` : ''}The manager retains ${Math.round(s.commissionRate * 100)}% of gross profit as its management commission; the remaining ${100 - Math.round(s.commissionRate * 100)}% is payable to the owner.
      <br/>Generated ${new Date().toLocaleDateString('en-GB')} · reporting.bakerhouseapartments.cz
    </div>
  </body></html>`;
}

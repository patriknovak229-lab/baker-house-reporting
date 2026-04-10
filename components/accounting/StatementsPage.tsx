'use client';
import { useState, useEffect, useCallback } from 'react';
import { formatCurrency } from '@/utils/formatters';
import type { PLData, PLBankTx } from '@/app/api/statements/profit-loss/route';
import type { SupplierInvoice } from '@/types/supplierInvoice';
import type { RevenueInvoice } from '@/types/revenueInvoice';

// ─── Period selector ──────────────────────────────────────────────────────────

type PeriodPreset = 'this_month' | 'last_month' | 'q1' | 'q2' | 'q3' | 'q4' | 'this_year' | 'custom';

const PRESETS: { value: PeriodPreset; label: string }[] = [
  { value: 'this_month',  label: 'This month' },
  { value: 'last_month',  label: 'Last month' },
  { value: 'q1',          label: 'Q1' },
  { value: 'q2',          label: 'Q2' },
  { value: 'q3',          label: 'Q3' },
  { value: 'q4',          label: 'Q4' },
  { value: 'this_year',   label: 'This year' },
  { value: 'custom',      label: 'Custom' },
];

function getPresetRange(preset: PeriodPreset): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-indexed
  const mm = (n: number) => String(n + 1).padStart(2, '0');

  if (preset === 'this_month') {
    return { from: `${y}-${mm(m)}-01`, to: `${y}-${mm(m)}-31` };
  }
  if (preset === 'last_month') {
    const lm = m === 0 ? 11 : m - 1;
    const ly = m === 0 ? y - 1 : y;
    return { from: `${ly}-${mm(lm)}-01`, to: `${ly}-${mm(lm)}-31` };
  }
  if (preset === 'q1') return { from: `${y}-01-01`, to: `${y}-03-31` };
  if (preset === 'q2') return { from: `${y}-04-01`, to: `${y}-06-30` };
  if (preset === 'q3') return { from: `${y}-07-01`, to: `${y}-09-30` };
  if (preset === 'q4') return { from: `${y}-10-01`, to: `${y}-12-31` };
  // this_year / custom fallback
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

// ─── Expandable section ───────────────────────────────────────────────────────

interface SupplierRow {
  date: string;
  supplier: string;
  invoiceNumber: string;
  amount: number;
}
interface RevenueRow {
  date: string;
  client: string;
  invoiceNumber: string;
  amount: number;
}

function supplierRows(invoices: SupplierInvoice[]): SupplierRow[] {
  return invoices.map((inv) => ({
    date: inv.invoiceDate,
    supplier: inv.supplierName,
    invoiceNumber: inv.invoiceNumber,
    amount: inv.amountCZK,
  }));
}

function revenueRows(invoices: RevenueInvoice[]): RevenueRow[] {
  return invoices.map((inv) => ({
    date: inv.invoiceDate,
    client: inv.guestName ?? inv.clientName ?? '—',
    invoiceNumber: inv.invoiceNumber,
    amount: inv.amountCZK,
  }));
}

interface SectionRowProps {
  code: string;
  label: string;
  sublabel?: string;
  amount: number;
  /** Number of items (invoices or transactions) for the expand indicator */
  itemCount: number;
  /** Label suffix for the count column, e.g. "inv." or "tx." */
  countLabel?: string;
  expanded: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
  indent?: boolean;
  bold?: boolean;
  colorClass?: string;
}

function SectionRow({ code, label, sublabel, amount, itemCount, countLabel = 'inv.', expanded, onToggle, children, indent, bold, colorClass }: SectionRowProps) {
  const hasDetail = itemCount > 0;
  return (
    <>
      <tr
        className={`border-b border-gray-100 transition-colors ${hasDetail ? 'cursor-pointer hover:bg-gray-50' : ''} ${indent ? 'bg-gray-50/50' : ''}`}
        onClick={hasDetail ? onToggle : undefined}
      >
        <td className={`px-4 py-3 text-xs font-semibold text-gray-400 whitespace-nowrap w-14 ${indent ? 'pl-10' : ''}`}>
          {code}
        </td>
        <td className={`px-4 py-3 ${bold ? 'font-semibold text-gray-900' : 'text-gray-700'} ${colorClass ?? ''}`}>
          <div className="flex items-center gap-2">
            {hasDetail && (
              <span className="text-gray-400 text-xs">{expanded ? '▾' : '▸'}</span>
            )}
            <span>{label}</span>
            {sublabel && <span className="text-xs text-gray-400 font-normal">{sublabel}</span>}
          </div>
        </td>
        <td className={`px-4 py-3 text-right whitespace-nowrap ${bold ? 'font-semibold text-gray-900' : 'text-gray-700'} ${colorClass ?? ''}`}>
          {formatCurrency(amount)}
        </td>
        <td className="px-4 py-3 text-right text-xs text-gray-400 whitespace-nowrap w-24">
          {hasDetail ? `${itemCount} ${countLabel}` : ''}
        </td>
      </tr>
      {expanded && children}
    </>
  );
}

function SupplierDetailRows({ rows }: { rows: SupplierRow[] }) {
  return (
    <>
      {rows.map((r, i) => (
        <tr key={i} className="bg-indigo-50/30 text-xs border-b border-gray-50">
          <td className="px-4 py-2 text-gray-400 pl-16">{r.date}</td>
          <td className="px-4 py-2 text-gray-600">{r.supplier} · {r.invoiceNumber}</td>
          <td className="px-4 py-2 text-right text-gray-700">{formatCurrency(r.amount)}</td>
          <td />
        </tr>
      ))}
    </>
  );
}

function RevenueDetailRows({ rows }: { rows: RevenueRow[] }) {
  return (
    <>
      {rows.map((r, i) => (
        <tr key={i} className="bg-indigo-50/30 text-xs border-b border-gray-50">
          <td className="px-4 py-2 text-gray-400 pl-16">{r.date}</td>
          <td className="px-4 py-2 text-gray-600">{r.client} · {r.invoiceNumber}</td>
          <td className="px-4 py-2 text-right text-gray-700">{formatCurrency(r.amount)}</td>
          <td />
        </tr>
      ))}
    </>
  );
}

function OtaDetailRows({ txs }: { txs: PLBankTx[] }) {
  return (
    <>
      {txs.map((tx) => (
        <tr key={tx.id} className="bg-indigo-50/30 text-xs border-b border-gray-50">
          <td className="px-4 py-2 text-gray-400 pl-16">{tx.date}</td>
          <td className="px-4 py-2 text-gray-600">
            {tx.counterpartyName ?? '—'}
            {tx.grossAmount != null && (
              <span className="text-gray-400"> · gross {formatCurrency(tx.grossAmount)}</span>
            )}
            <span className="ml-1 text-gray-400 italic">
              ({tx.state === 'net_settlement' ? 'net settlement' : 'settlement group'})
            </span>
          </td>
          <td className="px-4 py-2 text-right text-gray-700">{formatCurrency(tx.amount)}</td>
          <td />
        </tr>
      ))}
    </>
  );
}

// ─── CSV export ───────────────────────────────────────────────────────────────

function exportCSV(data: PLData) {
  const rows: string[][] = [
    ['Date', 'Type', 'Section', 'Counterparty', 'Invoice #', 'Amount CZK'],
  ];

  for (const inv of data.revenue.accommodationInvoices) {
    rows.push([inv.invoiceDate, 'Revenue', 'II. Tržby — Ubytování', inv.guestName ?? inv.clientName ?? '', inv.invoiceNumber, String(inv.amountCZK)]);
  }
  for (const inv of data.revenue.otherServicesInvoices) {
    rows.push([inv.invoiceDate, 'Revenue', 'II. Tržby — Ostatní služby', inv.guestName ?? inv.clientName ?? '', inv.invoiceNumber, String(inv.amountCZK)]);
  }
  for (const tx of data.revenue.otaTransactions) {
    rows.push([tx.date, 'Revenue', 'II. Tržby — OTA čistá plnění', tx.counterpartyName ?? '', tx.id, String(tx.amount)]);
  }
  for (const inv of data.costs.materialsInvoices) {
    rows.push([inv.invoiceDate, 'Cost', 'B. Spotřeba materiálu a energie', inv.supplierName, inv.invoiceNumber, String(inv.amountCZK)]);
  }
  for (const inv of data.costs.personnelInvoices) {
    rows.push([inv.invoiceDate, 'Cost', 'C. Osobní náklady', inv.supplierName, inv.invoiceNumber, String(inv.amountCZK)]);
  }
  for (const inv of data.costs.otherInvoices) {
    rows.push([inv.invoiceDate, 'Cost', 'E. Ostatní provozní náklady', inv.supplierName, inv.invoiceNumber, String(inv.amountCZK)]);
  }

  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `pl_${data.from}_${data.to}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function StatementsPage() {
  const [preset, setPreset]           = useState<PeriodPreset>('this_year');
  const [customFrom, setCustomFrom]   = useState('');
  const [customTo, setCustomTo]       = useState('');
  const [data, setData]               = useState<PLData | null>(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [expanded, setExpanded]       = useState<Set<string>>(new Set());

  const { from, to } = preset === 'custom'
    ? { from: customFrom, to: customTo }
    : getPresetRange(preset);

  const fetchData = useCallback(async () => {
    if (!from || !to) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/statements/profit-loss?from=${from}&to=${to}`);
      if (!res.ok) throw new Error('Failed to load P&L data');
      setData(await res.json());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    if (preset !== 'custom') fetchData();
  }, [preset, fetchData]);

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  const resultPositive = (data?.operatingResult ?? 0) >= 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Výkaz zisku a ztráty</h1>
          <p className="text-sm text-gray-500 mt-0.5">Profit &amp; Loss — Czech statutory format</p>
        </div>
        {data && (
          <button
            onClick={() => exportCSV(data)}
            className="flex items-center gap-2 px-4 py-2 border border-gray-200 text-sm text-gray-600 rounded-lg hover:bg-gray-50"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Export CSV
          </button>
        )}
      </div>

      {/* Period selector */}
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.value}
            onClick={() => setPreset(p.value)}
            className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
              preset === p.value
                ? 'bg-indigo-600 text-white font-medium'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {p.label}
          </button>
        ))}
        {preset === 'custom' && (
          <div className="flex items-center gap-2 ml-2">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-300"
            />
            <span className="text-gray-400 text-sm">–</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-300"
            />
            <button
              onClick={fetchData}
              disabled={!customFrom || !customTo || loading}
              className="px-3 py-1.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-40"
            >
              Apply
            </button>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">{error}</div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-2 animate-pulse">
          {[...Array(7)].map((_, i) => (
            <div key={i} className="h-12 bg-gray-100 rounded-lg" />
          ))}
        </div>
      )}

      {/* P&L table */}
      {!loading && data && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wide w-14">Code</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wide">Description</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400 uppercase tracking-wide">Amount (CZK)</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400 uppercase tracking-wide w-24">Invoices</th>
              </tr>
            </thead>
            <tbody>
              {/* ── REVENUE ── */}
              <tr className="border-b border-gray-100 bg-indigo-50/40">
                <td className="px-4 py-2 text-xs font-bold text-indigo-500">II.</td>
                <td className="px-4 py-2 font-semibold text-indigo-800" colSpan={2}>
                  Tržby za vlastní výkony a služby
                </td>
                <td className="px-4 py-2 text-right font-bold text-indigo-800">
                  {formatCurrency(data.revenue.total)}
                </td>
              </tr>

              {/* Accommodation sub-row */}
              <SectionRow
                code=""
                label="Ubytování"
                sublabel="accommodation_direct"
                amount={data.revenue.accommodation}
                itemCount={data.revenue.accommodationInvoices.length}
                expanded={expanded.has('accommodation')}
                onToggle={() => toggle('accommodation')}
                indent
              >
                <RevenueDetailRows rows={revenueRows(data.revenue.accommodationInvoices)} />
              </SectionRow>

              {/* Other services sub-row */}
              <SectionRow
                code=""
                label="Ostatní služby"
                sublabel="other_services"
                amount={data.revenue.otherServices}
                itemCount={data.revenue.otherServicesInvoices.length}
                expanded={expanded.has('other_services')}
                onToggle={() => toggle('other_services')}
                indent
              >
                <RevenueDetailRows rows={revenueRows(data.revenue.otherServicesInvoices)} />
              </SectionRow>

              {/* OTA net settlements sub-row */}
              <SectionRow
                code=""
                label="OTA čistá plnění"
                sublabel="Booking.com · Airbnb (net)"
                amount={data.revenue.otaSettlements}
                itemCount={data.revenue.otaTransactions.length}
                countLabel="tx."
                expanded={expanded.has('ota')}
                onToggle={() => toggle('ota')}
                indent
              >
                <OtaDetailRows txs={data.revenue.otaTransactions} />
              </SectionRow>

              {/* spacer */}
              <tr><td colSpan={4} className="py-1" /></tr>

              {/* ── COSTS ── */}
              <SectionRow
                code="B."
                label="Spotřeba materiálu a energie"
                amount={data.costs.materialsEnergy}
                itemCount={data.costs.materialsInvoices.length}
                expanded={expanded.has('materials')}
                onToggle={() => toggle('materials')}
              >
                <SupplierDetailRows rows={supplierRows(data.costs.materialsInvoices)} />
              </SectionRow>

              <SectionRow
                code="C."
                label="Osobní náklady (služby)"
                amount={data.costs.personnelServices}
                itemCount={data.costs.personnelInvoices.length}
                expanded={expanded.has('personnel')}
                onToggle={() => toggle('personnel')}
              >
                <SupplierDetailRows rows={supplierRows(data.costs.personnelInvoices)} />
              </SectionRow>

              <SectionRow
                code="E."
                label="Ostatní provozní náklady"
                amount={data.costs.otherOperating}
                itemCount={data.costs.otherInvoices.length}
                expanded={expanded.has('other')}
                onToggle={() => toggle('other')}
              >
                <SupplierDetailRows rows={supplierRows(data.costs.otherInvoices)} />
              </SectionRow>

              {/* spacer */}
              <tr><td colSpan={4} className="py-1 border-t border-gray-200" /></tr>

              {/* ── RESULT ── */}
              <tr className={`${resultPositive ? 'bg-green-50' : 'bg-red-50'}`}>
                <td className="px-4 py-4 text-xs font-bold text-gray-400">*</td>
                <td className={`px-4 py-4 font-bold text-base ${resultPositive ? 'text-green-800' : 'text-red-700'}`}>
                  Výsledek z provozní činnosti
                </td>
                <td className={`px-4 py-4 text-right font-bold text-base ${resultPositive ? 'text-green-800' : 'text-red-700'}`}>
                  {resultPositive ? '+' : ''}{formatCurrency(data.operatingResult)}
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && data && data.revenue.total === 0 && data.costs.total === 0 && (
        <p className="text-center text-sm text-gray-400 py-4">No invoices found for this period.</p>
      )}
    </div>
  );
}

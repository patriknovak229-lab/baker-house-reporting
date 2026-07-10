'use client';
import { useState, useEffect, useCallback } from 'react';
import { formatCurrency } from '@/utils/formatters';
import type { PLData, PLCostRow } from '@/app/api/statements/profit-loss/route';
import type { RevenueInvoice } from '@/types/revenueInvoice';
import { LINE_META, type StatutoryLine } from '@/utils/costBridge';

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
  const m = now.getMonth();
  const mm = (n: number) => String(n + 1).padStart(2, '0');
  if (preset === 'this_month') return { from: `${y}-${mm(m)}-01`, to: `${y}-${mm(m)}-31` };
  if (preset === 'last_month') {
    const lm = m === 0 ? 11 : m - 1;
    const ly = m === 0 ? y - 1 : y;
    return { from: `${ly}-${mm(lm)}-01`, to: `${ly}-${mm(lm)}-31` };
  }
  if (preset === 'q1') return { from: `${y}-01-01`, to: `${y}-03-31` };
  if (preset === 'q2') return { from: `${y}-04-01`, to: `${y}-06-30` };
  if (preset === 'q3') return { from: `${y}-07-01`, to: `${y}-09-30` };
  if (preset === 'q4') return { from: `${y}-10-01`, to: `${y}-12-31` };
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

// ─── Rows ───────────────────────────────────────────────────────────────────

interface RevenueRow { date: string; client: string; invoiceNumber: string; amount: number; }

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
  itemCount: number;
  countLabel?: string;
  expanded: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
  indent?: boolean;
  bold?: boolean;
}

function SectionRow({ code, label, sublabel, amount, itemCount, countLabel = 'inv.', expanded, onToggle, children, indent, bold }: SectionRowProps) {
  const hasDetail = itemCount > 0;
  return (
    <>
      <tr
        className={`border-b border-gray-100 transition-colors ${hasDetail ? 'cursor-pointer hover:bg-gray-50' : ''} ${indent ? 'bg-gray-50/50' : ''}`}
        onClick={hasDetail ? onToggle : undefined}
      >
        <td className={`px-4 py-3 text-xs font-semibold text-gray-400 whitespace-nowrap w-14 ${indent ? 'pl-10' : ''}`}>{code}</td>
        <td className={`px-4 py-3 ${bold ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>
          <div className="flex items-center gap-2">
            {hasDetail && <span className="text-gray-400 text-xs">{expanded ? '▾' : '▸'}</span>}
            <span>{label}</span>
            {sublabel && <span className="text-xs text-gray-400 font-normal">{sublabel}</span>}
          </div>
        </td>
        <td className={`px-4 py-3 text-right whitespace-nowrap ${bold ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>{formatCurrency(amount)}</td>
        <td className="px-4 py-3 text-right text-xs text-gray-400 whitespace-nowrap w-24">{hasDetail ? `${itemCount} ${countLabel}` : ''}</td>
      </tr>
      {expanded && children}
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

/** Cost rows grouped by ledger account within a statutory line */
function CostDetailRows({ rows }: { rows: PLCostRow[] }) {
  const sorted = [...rows].sort((a, b) => (a.account + a.date).localeCompare(b.account + b.date));
  return (
    <>
      {sorted.map((r) => (
        <tr key={r.id} className="bg-indigo-50/30 text-xs border-b border-gray-50">
          <td className="px-4 py-2 text-gray-400 pl-16">{r.date}</td>
          <td className="px-4 py-2 text-gray-600">
            <span className="text-gray-400 font-mono mr-1">{r.account}</span>
            {r.supplier} · {r.invoiceNumber}
            <span className="ml-1 text-gray-400 italic">({r.category})</span>
          </td>
          <td className="px-4 py-2 text-right text-gray-700">{formatCurrency(r.amount)}</td>
          <td />
        </tr>
      ))}
    </>
  );
}

// ─── CSV export ───────────────────────────────────────────────────────────────

// ─── Main component ───────────────────────────────────────────────────────────

export default function StatementsPage() {
  const [preset, setPreset]         = useState<PeriodPreset>('this_year');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo]     = useState('');
  const [data, setData]             = useState<PLData | null>(null);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [expanded, setExpanded]     = useState<Set<string>>(new Set());
  const [exporting, setExporting]   = useState(false);
  const [exportMsg, setExportMsg]   = useState<{ type: 'ok' | 'warn' | 'error'; text: string; url?: string } | null>(null);

  const { from, to } = preset === 'custom' ? { from: customFrom, to: customTo } : getPresetRange(preset);

  async function exportXlsx() {
    if (!from || !to) return;
    setExporting(true);
    setExportMsg(null);
    try {
      const res = await fetch(`/api/statements/export?from=${from}&to=${to}`, { method: 'POST' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Export failed (${res.status})`);
      }
      // Download the returned workbook
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `Statements_${from}_${to}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);

      const driveUrl = res.headers.get('X-Drive-Url') || '';
      const driveErr = res.headers.get('X-Drive-Error') || '';
      const count    = res.headers.get('X-Invoice-Count') || '0';
      if (driveErr) {
        setExportMsg({ type: 'warn', text: `Downloaded ${count} invoices, but Drive upload failed: ${driveErr}` });
      } else {
        setExportMsg({ type: 'ok', text: `Exported ${count} invoices — downloaded and saved to Drive.`, url: driveUrl });
      }
    } catch (e) {
      setExportMsg({ type: 'error', text: (e as Error).message });
    } finally {
      setExporting(false);
    }
  }

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

  useEffect(() => { if (preset !== 'custom') fetchData(); }, [preset, fetchData]);

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const resultPositive = (data?.operatingResult ?? 0) >= 0;
  const flags = data
    ? [
        { key: 'legacyOta', rows: data.costs.flaggedLegacyOta, msg: 'OTA fee records not backed by a settlement (likely legacy) — delete and re-upload as settlement reports' },
        { key: 'dates', rows: data.costs.flaggedOutOfRangeDate, msg: 'Records with an out-of-range invoice date (excluded from every period) — fix the date' },
        { key: 'unknown', rows: data.costs.flaggedUnknownCategory, msg: 'Records whose category is not in the bridge (booked to 548 / line F) — review the category' },
      ].filter((f) => f.rows.length > 0)
    : [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Výkaz zisku a ztráty</h1>
          <p className="text-sm text-gray-500 mt-0.5">Profit &amp; Loss — Czech statutory format (accrual, non-VAT)</p>
        </div>
        {data && (
          <button
            onClick={() => { void exportXlsx(); }}
            disabled={exporting || !from || !to}
            className="flex items-center gap-2 px-4 py-2 border border-gray-200 text-sm text-gray-600 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            title="Export supplier invoices for this period as XLSX and save to the accountant's Drive folder"
          >
            {exporting
              ? <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
              : <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
            }
            Export XLSX → Drive
          </button>
        )}
      </div>

      {/* Export result */}
      {exportMsg && (
        <div className={`flex items-start justify-between rounded-xl px-4 py-3 gap-3 text-sm border ${
          exportMsg.type === 'ok'   ? 'bg-green-50 border-green-200 text-green-800'
          : exportMsg.type === 'warn' ? 'bg-amber-50 border-amber-200 text-amber-800'
          : 'bg-red-50 border-red-200 text-red-700'
        }`}>
          <span>
            {exportMsg.text}
            {exportMsg.url && (
              <> · <a href={exportMsg.url} target="_blank" rel="noopener noreferrer" className="underline font-medium">Open in Drive</a></>
            )}
          </span>
          <button onClick={() => setExportMsg(null)} className="text-current opacity-60 hover:opacity-100 flex-shrink-0">×</button>
        </div>
      )}

      {/* Period selector */}
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => (
          <button key={p.value} onClick={() => setPreset(p.value)}
            className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${preset === p.value ? 'bg-indigo-600 text-white font-medium' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {p.label}
          </button>
        ))}
        {preset === 'custom' && (
          <div className="flex items-center gap-2 ml-2">
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-300" />
            <span className="text-gray-400 text-sm">–</span>
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-300" />
            <button onClick={fetchData} disabled={!customFrom || !customTo || loading} className="px-3 py-1.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-40">Apply</button>
          </div>
        )}
      </div>

      {error && <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">{error}</div>}

      {loading && (
        <div className="space-y-2 animate-pulse">
          {[...Array(7)].map((_, i) => <div key={i} className="h-12 bg-gray-100 rounded-lg" />)}
        </div>
      )}

      {/* Data-quality flags */}
      {!loading && flags.map((f) => (
        <div key={f.key} className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <p className="text-sm font-medium text-amber-800">⚠ {f.rows.length} record{f.rows.length !== 1 ? 's' : ''} flagged</p>
          <p className="text-xs text-amber-700 mt-0.5">{f.msg}</p>
          <p className="text-xs text-amber-600 mt-1 font-mono truncate">
            {f.rows.slice(0, 5).map((r) => `${r.supplier} ${r.invoiceNumber}`).join(' · ')}{f.rows.length > 5 ? ' …' : ''}
          </p>
        </div>
      ))}

      {/* P&L table */}
      {!loading && data && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wide w-14">Code</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wide">Description</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400 uppercase tracking-wide">Amount (CZK)</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400 uppercase tracking-wide w-24">Items</th>
              </tr>
            </thead>
            <tbody>
              {/* ── REVENUE ── */}
              <tr className="border-b border-gray-100 bg-indigo-50/40">
                <td className="px-4 py-2 text-xs font-bold text-indigo-500">I.</td>
                <td className="px-4 py-2 font-semibold text-indigo-800" colSpan={2}>Tržby z prodeje výrobků a služeb</td>
                <td className="px-4 py-2 text-right font-bold text-indigo-800">{formatCurrency(data.revenue.total)}</td>
              </tr>
              <SectionRow code="" label="Ubytování" sublabel="accommodation" amount={data.revenue.accommodation}
                itemCount={data.revenue.accommodationInvoices.length} expanded={expanded.has('accommodation')} onToggle={() => toggle('accommodation')} indent>
                <RevenueDetailRows rows={revenueRows(data.revenue.accommodationInvoices)} />
              </SectionRow>
              <SectionRow code="" label="Ostatní služby" sublabel="other_services" amount={data.revenue.otherServices}
                itemCount={data.revenue.otherServicesInvoices.length} expanded={expanded.has('other_services')} onToggle={() => toggle('other_services')} indent>
                <RevenueDetailRows rows={revenueRows(data.revenue.otherServicesInvoices)} />
              </SectionRow>
              <SectionRow code="" label="OTA hrubé tržby" sublabel="Airbnb · Booking.com (gross)" amount={data.revenue.otaGross}
                itemCount={data.revenue.otaGrossInvoices.length} expanded={expanded.has('ota_gross')} onToggle={() => toggle('ota_gross')} indent>
                <RevenueDetailRows rows={revenueRows(data.revenue.otaGrossInvoices)} />
              </SectionRow>

              <tr><td colSpan={4} className="py-1" /></tr>

              {/* ── COSTS by statutory line ── */}
              {(['A', 'D', 'E', 'F'] as StatutoryLine[]).map((line) => (
                <SectionRow
                  key={line}
                  code={LINE_META[line].code}
                  label={LINE_META[line].label}
                  amount={data.costs.byLine[line].total}
                  itemCount={data.costs.byLine[line].rows.length}
                  countLabel="items"
                  expanded={expanded.has(`line_${line}`)}
                  onToggle={() => toggle(`line_${line}`)}
                >
                  <CostDetailRows rows={data.costs.byLine[line].rows} />
                </SectionRow>
              ))}

              {/* Capitalized assets — balance sheet, not expensed */}
              {data.costs.capitalizedAssets.length > 0 && (
                <SectionRow
                  code="022"
                  label="Dlouhodobý hmotný majetek"
                  sublabel="capitalized — not expensed (depreciation → E)"
                  amount={data.costs.capitalizedAssets.reduce((s, r) => s + r.amount, 0)}
                  itemCount={data.costs.capitalizedAssets.length}
                  countLabel="items"
                  expanded={expanded.has('assets')}
                  onToggle={() => toggle('assets')}
                >
                  <CostDetailRows rows={data.costs.capitalizedAssets} />
                </SectionRow>
              )}

              <tr><td colSpan={4} className="py-1 border-t border-gray-200" /></tr>

              {/* ── RESULT ── */}
              <tr className={resultPositive ? 'bg-green-50' : 'bg-red-50'}>
                <td className="px-4 py-4 text-xs font-bold text-gray-400">*</td>
                <td className={`px-4 py-4 font-bold text-base ${resultPositive ? 'text-green-800' : 'text-red-700'}`}>Provozní výsledek hospodaření</td>
                <td className={`px-4 py-4 text-right font-bold text-base ${resultPositive ? 'text-green-800' : 'text-red-700'}`}>
                  {resultPositive ? '+' : ''}{formatCurrency(data.operatingResult)}
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {!loading && !error && data && data.revenue.total === 0 && data.costs.total === 0 && (
        <p className="text-center text-sm text-gray-400 py-4">No records found for this period.</p>
      )}
    </div>
  );
}

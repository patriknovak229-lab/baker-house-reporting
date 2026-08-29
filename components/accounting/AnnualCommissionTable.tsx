'use client';
/**
 * Annual commission overview — the whole business, one calendar year, every
 * room × every month, from gross booking value down to the owner settlement.
 *
 * Sits under the monthly settlement cards on the Commission tab. The numbers
 * come from `buildAnnualOverview`, which prefers frozen issued settlements and
 * fills the rest live; the row order comes from `annualLineSpecs`, shared with
 * the PDF export.
 */
import { useMemo, useState } from 'react';
import type { Reservation } from '@/types/reservation';
import type { CommissionSettlement } from '@/types/commissionSettlement';
import type { VariableCostBundle } from '@/utils/commissionCalc';
import {
  buildAnnualOverview,
  annualLineSpecs,
  availableYears,
  type AnnualOverview,
  type AnnualRow,
  type AnnualLineSpec,
} from '@/utils/commissionYear';

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Compact CZK for a dense grid: no currency suffix, thin-space thousands. */
function kc(n: number): string {
  const rounded = Math.round(n);
  if (rounded === 0) return '0';
  return rounded.toLocaleString('cs-CZ').replace(/-/, '−');
}

const KIND_ROW: Record<AnnualLineSpec['kind'], string> = {
  revenue: 'font-semibold text-gray-900',
  deduction: 'text-rose-600',
  'sub-item': 'text-[11px] text-rose-400',
  subtotal: 'bg-gray-50 font-semibold text-gray-900',
  result: 'bg-indigo-50 font-semibold text-indigo-700',
  payout: 'bg-emerald-50 font-semibold text-emerald-700',
};

export default function AnnualCommissionTable({
  reservations,
  costs,
  settlements,
}: {
  reservations: Reservation[];
  costs: VariableCostBundle | null;
  settlements: CommissionSettlement[];
}) {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [exporting, setExporting] = useState(false);
  const [openRooms, setOpenRooms] = useState<Record<string, boolean>>({});

  const years = useMemo(
    () => availableYears(settlements, reservations, currentYear),
    [settlements, reservations, currentYear],
  );

  const overview = useMemo(
    () => (costs ? buildAnnualOverview(year, reservations, costs, settlements) : null),
    [year, reservations, costs, settlements],
  );

  async function handleExport() {
    if (!overview) return;
    setExporting(true);
    try {
      const res = await fetch('/api/commission/annual-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(overview),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Annual_Commission_Overview_${year}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  }

  if (!overview) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
        <p className="text-sm text-gray-400">Annual overview unavailable — cleaning-app costs did not load.</p>
      </div>
    );
  }

  const rooms = [...overview.rows, ...(overview.unallocated ? [overview.unallocated] : [])];

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 py-4 border-b border-gray-100">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Annual overview</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Every apartment, gross sales → settlement · averages over {overview.activeMonths} active month
            {overview.activeMonths === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-800"
          >
            {years.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <button
            onClick={handleExport}
            disabled={exporting}
            className="px-3 py-2 rounded-md border border-indigo-200 bg-indigo-50 text-sm font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
          >
            {exporting ? 'Generating…' : 'Export PDF'}
          </button>
        </div>
      </div>

      {/* Provenance + coverage */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 border-b border-gray-100 text-[11px] text-gray-500">
        <span className="inline-flex items-center gap-1">
          <span className="text-indigo-600 font-semibold">✓</span> issued settlement (frozen)
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="text-gray-300 font-semibold">·</span> computed live — provisional
        </span>
        {overview.uncoveredMonths.length > 0 && (
          <span className="text-amber-700">
            ⚠ {overview.uncoveredMonths.map((m) => MONTH_ABBR[Number(m.slice(5, 7)) - 1]).join(', ')} outside the
            loaded booking window — shown as “—” and excluded from totals
          </span>
        )}
      </div>

      {/* Whole business */}
      <YearBlock row={overview.total} overview={overview} open onToggle={undefined} highlight />

      {/* Per room */}
      {rooms.map((row) => (
        <YearBlock
          key={row.key}
          row={row}
          overview={overview}
          open={openRooms[row.key] ?? false}
          onToggle={() => setOpenRooms((p) => ({ ...p, [row.key]: !(p[row.key] ?? false) }))}
        />
      ))}
    </div>
  );
}

/** One room's (or the business's) block: a collapsed summary strip that expands
 *  into the full month-by-month waterfall. */
function YearBlock({
  row,
  overview,
  open,
  onToggle,
  highlight,
}: {
  row: AnnualRow;
  overview: AnnualOverview;
  open: boolean;
  onToggle?: () => void;
  highlight?: boolean;
}) {
  const specs = useMemo(() => annualLineSpecs(row), [row]);

  return (
    <div className={`border-b border-gray-100 last:border-b-0 ${highlight ? 'bg-slate-50/60' : ''}`}>
      <button
        onClick={onToggle}
        disabled={!onToggle}
        className={`w-full flex items-center justify-between gap-3 px-5 py-3 text-left ${onToggle ? 'hover:bg-gray-50' : ''}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          {onToggle && <span className="text-gray-400 text-xs w-3">{open ? '▾' : '▸'}</span>}
          <span className="text-sm font-semibold text-gray-900">{row.room}</span>
          <span className="text-xs text-gray-500 truncate hidden sm:inline">{row.typeLabel}</span>
          {row.mode === 'urban-pool' && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-teal-100 text-teal-700">Pool ÷3</span>
          )}
          {!row.commissionable && !row.isAggregate && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
              No commission
            </span>
          )}
          {row.issuedCount > 0 && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700">
              {row.issuedCount} issued
            </span>
          )}
        </div>
        <div className="flex items-center gap-5 text-xs whitespace-nowrap">
          <Stat label="Net sales" value={kc(row.total.netSales)} />
          <Stat label="Gross profit" value={kc(row.total.grossProfit)} tone="indigo" />
          <Stat label="Commission" value={kc(row.total.commissionAmount)} tone="amber" />
          <Stat label="Payable" value={kc(row.total.payableToOwner)} tone="emerald" />
        </div>
      </button>

      {open && (
        <div className="overflow-x-auto border-t border-gray-100">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 bg-gray-50/80">
                <th className="text-left font-medium px-4 py-2 sticky left-0 bg-gray-50/80 min-w-[190px]">
                  {overview.year}
                </th>
                {row.cells.map((c, i) => (
                  <th key={i} className="text-right font-medium px-2 py-2 min-w-[70px]">
                    {MONTH_ABBR[i]}
                    {c?.source === 'issued' && <span className="text-indigo-600 ml-0.5">✓</span>}
                  </th>
                ))}
                <th className="text-right font-semibold px-3 py-2 min-w-[84px] border-l border-gray-200 text-gray-700">
                  Total
                </th>
                <th className="text-right font-medium px-3 py-2 min-w-[80px] text-gray-600">Avg / mo</th>
              </tr>
            </thead>
            <tbody>
              {specs.map((spec) => (
                <tr key={spec.key} className={`border-t border-gray-50 ${KIND_ROW[spec.kind]}`}>
                  <td
                    className={`px-4 py-1.5 sticky left-0 ${
                      spec.kind === 'subtotal'
                        ? 'bg-gray-50'
                        : spec.kind === 'result'
                        ? 'bg-indigo-50'
                        : spec.kind === 'payout'
                        ? 'bg-emerald-50'
                        : 'bg-white'
                    } ${spec.kind === 'sub-item' ? 'pl-8' : ''}`}
                  >
                    {spec.kind === 'sub-item' ? `· ${spec.label}` : spec.label}
                  </td>
                  {spec.values.map((v, i) => (
                    <td key={i} className="px-2 py-1.5 text-right tabular-nums">
                      {v === null ? <span className="text-gray-300">—</span> : kc(v)}
                    </td>
                  ))}
                  <td className="px-3 py-1.5 text-right tabular-nums font-semibold border-l border-gray-200">
                    {kc(spec.total)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums opacity-75">{kc(spec.average)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'indigo' | 'amber' | 'emerald' }) {
  const colour =
    tone === 'indigo' ? 'text-indigo-700' : tone === 'amber' ? 'text-amber-700' : tone === 'emerald' ? 'text-emerald-700' : 'text-gray-800';
  return (
    <span className="hidden md:flex flex-col items-end leading-tight">
      <span className="text-[10px] uppercase tracking-wide text-gray-400">{label}</span>
      <span className={`font-semibold tabular-nums ${colour}`}>{value}</span>
    </span>
  );
}

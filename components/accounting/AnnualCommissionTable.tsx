'use client';
/**
 * Annual overview — the whole business, one calendar year, in a single grid.
 *
 * ONE table: apartments are rows, months are columns, and everything starts
 * collapsed. A collapsed apartment shows its gross profit across the year —
 * the figure you actually scan a year for. Expanding it reveals four P&L lines,
 * each of which owns its own detail (see `annualLineTree`), so the operator
 * opens only the part they care about instead of reading a wall of numbers.
 *
 * Sits under the monthly settlement cards on the Commission tab. Figures come
 * from `buildAnnualOverview` — frozen issued settlements where they exist, live
 * recomputation elsewhere.
 */
import { useMemo, useState } from 'react';
import type { Reservation } from '@/types/reservation';
import type { CommissionSettlement } from '@/types/commissionSettlement';
import type { VariableCostBundle } from '@/utils/commissionCalc';
import {
  buildAnnualOverview,
  annualLineTree,
  availableYears,
  type AnnualRow,
  type AnnualLineNode,
} from '@/utils/commissionYear';

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Compact CZK for a dense grid: no currency suffix, cs-CZ thousands. */
function kc(n: number): string {
  const rounded = Math.round(n);
  if (rounded === 0) return '0';
  return rounded.toLocaleString('cs-CZ').replace(/-/, '−');
}

/**
 * Palette lifted from the Performance tab (NetSalesBridgeView /
 * GrossProfitBridgeView KPI tiles) so a figure keeps its colour across tabs:
 * gross + net revenue indigo, every cost rose, the profit result emerald —
 * amber when it goes negative, exactly as the Performance bridge does.
 *
 * `text` is the row's own colouring; `bg` must be an OPAQUE class because the
 * label column is sticky and translucent tints let months scroll through it.
 */
const KIND_STYLE: Record<AnnualLineNode['kind'], { text: string; bg: string }> = {
  revenue:      { text: 'text-indigo-700 font-semibold', bg: 'bg-white' },
  net:          { text: 'text-indigo-700 font-semibold', bg: 'bg-indigo-50' },
  deduction:    { text: 'text-rose-600',                 bg: 'bg-white' },
  'sub-item':   { text: 'text-rose-400',                 bg: 'bg-white' },
  'cost-total': { text: 'text-rose-700 font-semibold',   bg: 'bg-rose-50' },
  result:       { text: 'text-emerald-700 font-semibold', bg: 'bg-emerald-50' },
};

/** Gross profit turns amber when negative — same signal as the Performance bridge. */
const LOSS_STYLE = { text: 'text-amber-700 font-semibold', bg: 'bg-amber-50' };

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
  /** Expanded node ids — `roomKey` for a room, `roomKey|lineKey` for a line. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
      a.download = `Annual_Overview_${year}.pdf`;
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

  const rows = [overview.total, ...overview.rows, ...(overview.unallocated ? [overview.unallocated] : [])];
  const anyExpanded = expanded.size > 0;

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 py-4 border-b border-gray-100">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Annual overview</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Gross profit per apartment, month by month · expand a row for the full P&amp;L
          </p>
        </div>
        <div className="flex items-center gap-2">
          {anyExpanded && (
            <button
              onClick={() => setExpanded(new Set())}
              className="px-3 py-2 rounded-md text-sm font-medium text-gray-500 hover:bg-gray-50"
            >
              Collapse all
            </button>
          )}
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

      {/* What counts towards the year */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 border-b border-gray-100 text-[11px] text-gray-500">
        <span className="inline-flex items-center gap-1">
          <span className="text-emerald-600 font-semibold">✓</span>
          reliable month — <b className="font-semibold">Total and Avg / mo count these only</b>
        </span>
        <span className="text-gray-400">
          greyed months are shown but excluded: not yet finished, awaiting backfill, or not yet settled
        </span>
        {overview.uncoveredMonths.length > 0 && (
          <span className="text-amber-700">
            ⚠ {overview.uncoveredMonths.map((m) => MONTH_ABBR[Number(m.slice(5, 7)) - 1]).join(', ')} outside the
            loaded booking window — shown as “—”
          </span>
        )}
      </div>

      {/* The grid */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-gray-500 bg-gray-50">
              <th className="text-left font-medium px-4 py-2 sticky left-0 bg-gray-50 z-10 min-w-[210px]">
                {overview.year}
              </th>
              {MONTH_ABBR.map((m) => (
                <th key={m} className="text-right font-medium px-2 py-2 min-w-[68px]">{m}</th>
              ))}
              <th className="text-right font-semibold px-3 py-2 min-w-[92px] border-l border-gray-200 text-gray-700">
                Total <span className="text-emerald-600">✓</span>
              </th>
              <th className="text-right font-medium px-3 py-2 min-w-[86px] text-gray-600">
                Avg / mo <span className="text-emerald-600">✓</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <RoomRows
                key={row.key}
                row={row}
                expanded={expanded}
                onToggle={toggle}
                highlight={row.key === overview.total.key}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** One apartment: its own summary row, plus the P&L rows when expanded. */
function RoomRows({
  row,
  expanded,
  onToggle,
  highlight,
}: {
  row: AnnualRow;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  highlight: boolean;
}) {
  const open = expanded.has(row.key);
  const tree = useMemo(() => annualLineTree(row), [row]);
  const reliableMask = useMemo(() => row.cells.map((c) => !!c?.reliable), [row]);
  const bg = highlight ? 'bg-slate-100' : 'bg-white';
  const partial = row.reliableCount < row.cells.filter(Boolean).length;

  return (
    <>
      {/* Collapsed apartment row — the number shown is gross profit. */}
      <tr
        onClick={() => onToggle(row.key)}
        className={`border-t border-gray-200 cursor-pointer hover:bg-indigo-50/40 ${highlight ? 'bg-slate-100' : ''}`}
      >
        <th
          scope="row"
          className={`text-left font-normal px-4 py-2 sticky left-0 z-10 ${bg} ${highlight ? '' : 'hover:bg-inherit'}`}
        >
          <span className="flex items-center gap-1.5">
            <span className="text-gray-400 w-3 shrink-0">{open ? '▾' : '▸'}</span>
            <span className="font-semibold text-gray-900">{row.room}</span>
            {row.mode === 'urban-pool' && (
              <span className="text-[10px] font-semibold px-1.5 py-px rounded-full bg-teal-100 text-teal-700">÷3</span>
            )}
            {!row.commissionable && !row.isAggregate && (
              <span className="text-[10px] font-semibold px-1.5 py-px rounded-full bg-slate-100 text-slate-600">
                BHA
              </span>
            )}
            <span
              title={`Total and Avg / mo cover ${row.reliableCount} reliable month${row.reliableCount === 1 ? '' : 's'}; greyed months are excluded pending backfill`}
              className={`text-[10px] font-semibold px-1.5 py-px rounded-full ${
                partial ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'
              }`}
            >
              {row.reliableCount}/12 ✓
            </span>
          </span>
        </th>
        {row.cells.map((cell, i) => (
          <td
            key={i}
            className={`px-2 py-2 text-right tabular-nums font-medium ${
              !cell?.reliable ? 'text-gray-300' : cell.grossProfit < 0 ? 'text-amber-700' : 'text-emerald-700'
            }`}
          >
            {cell === null ? <span className="text-gray-300">—</span> : kc(cell.grossProfit)}
            {cell?.reliable && <span className="text-emerald-500 ml-0.5">✓</span>}
          </td>
        ))}
        <td className={`px-3 py-2 text-right tabular-nums font-bold border-l border-gray-200 ${row.total.grossProfit < 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
          {kc(row.total.grossProfit)}
        </td>
        <td className="px-3 py-2 text-right tabular-nums text-emerald-600">{kc(row.average.grossProfit)}</td>
      </tr>

      {open && tree.map((node) => (
        <LineRows key={node.key} node={node} rowKey={row.key} depth={0} reliable={reliableMask} expanded={expanded} onToggle={onToggle} />
      ))}
    </>
  );
}

/** One P&L line, plus its children when expanded. */
function LineRows({
  node,
  rowKey,
  depth,
  reliable,
  expanded,
  onToggle,
}: {
  node: AnnualLineNode;
  rowKey: string;
  depth: number;
  /** Per-month: does this month count towards the row's total and average? */
  reliable: boolean[];
  expanded: Set<string>;
  onToggle: (id: string) => void;
}) {
  const id = `${rowKey}|${node.key}`;
  const hasChildren = !!node.children?.length;
  const open = expanded.has(id);
  const style = node.kind === 'result' && node.total < 0 ? LOSS_STYLE : KIND_STYLE[node.kind];

  return (
    <>
      <tr
        onClick={hasChildren ? () => onToggle(id) : undefined}
        className={`border-t border-gray-50 ${style.text} ${style.bg} ${hasChildren ? 'cursor-pointer' : ''}`}
      >
        <td className={`px-4 py-1.5 sticky left-0 z-10 ${style.bg}`}>
          <span className="flex items-center gap-1.5" style={{ paddingLeft: `${depth * 14 + 16}px` }}>
            <span className="text-gray-400 w-3 shrink-0">{hasChildren ? (open ? '▾' : '▸') : ''}</span>
            <span>{node.label}</span>
          </span>
        </td>
        {node.values.map((v, i) => (
          <td
            key={i}
            className={`px-2 py-1.5 text-right tabular-nums ${reliable[i] ? '' : 'text-gray-300'}`}
          >
            {v === null ? <span className="text-gray-300">—</span> : kc(v)}
          </td>
        ))}
        <td className="px-3 py-1.5 text-right tabular-nums font-semibold border-l border-gray-200">
          {kc(node.total)}
        </td>
        <td className="px-3 py-1.5 text-right tabular-nums opacity-75">{kc(node.average)}</td>
      </tr>

      {open && node.children!.map((child) => (
        <LineRows key={child.key} node={child} rowKey={rowKey} depth={depth + 1} reliable={reliable} expanded={expanded} onToggle={onToggle} />
      ))}
    </>
  );
}

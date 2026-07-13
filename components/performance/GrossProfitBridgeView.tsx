'use client';
import type { ReactNode } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from "recharts";
import type { Reservation, Room } from "@/types/reservation";
import type { DateRange } from "@/utils/periodUtils";
import type { VariableCostEntry, VariableCostsLookup, SubscriptionItem } from "@/app/api/variable-costs/route";
import { computeGrossProfit } from "@/utils/grossProfit";

interface Props {
  reservations: Reservation[];
  dateRange: DateRange;
  variableCosts: VariableCostsLookup;
  variableCostsByReservation?: Record<string, VariableCostEntry>;
  /** Raw subscription items with effective dates. Each (item × room)
   *  contributes monthlyAmount × months-active-in-range. */
  subscriptionItems?: SubscriptionItem[];
  /** "date|roomId" of manual (extra) cleanings — mid-stay / special. */
  manualCleaningKeys?: string[];
  /** "date|roomId" of cleanings marked "no laundry". */
  noLaundryKeys?: string[];
  /** "date|roomId" of cleanings the operator removed (stay prolonged etc.). */
  dismissedCleaningKeys?: string[];
  /** Rooms in scope from the page-level filter; used to scope cost sums. */
  selectedRooms?: Room[];
}

const fmt = (n: number) =>
  Math.round(n).toLocaleString("cs-CZ") + " Kč";

const fmtAxis = (n: number) =>
  n >= 1000 ? Math.round(n / 1000) + "k" : n <= -1000 ? "-" + Math.round(Math.abs(n) / 1000) + "k" : String(n);

interface WaterfallEntry {
  name: string;
  base: number;
  amount: number;
  type: "total" | "deduction";
}

/** Distinct calendar months touched by inclusive [start, end]. */
function countMonths(start: string, end: string): number {
  const s = new Date(start + 'T12:00:00');
  const e = new Date(end + 'T12:00:00');
  return (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth()) + 1;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function WaterfallTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const entry = payload[0]?.payload as WaterfallEntry;
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-sm">
      <p className="font-medium text-gray-700 mb-1">{label}</p>
      <p
        className={
          entry.type === "deduction"
            ? "text-rose-600 font-semibold"
            : "font-semibold " + (entry.amount >= 0 ? "text-indigo-700" : "text-amber-600")
        }
      >
        {entry.type === "deduction" ? "−" : ""}{fmt(Math.abs(entry.amount))}
        {entry.type === "total" && entry.amount < 0 ? " (loss)" : ""}
      </p>
    </div>
  );
}


export default function GrossProfitBridgeView({
  reservations,
  dateRange,
  variableCosts,
  variableCostsByReservation = {},
  subscriptionItems = [],
  manualCleaningKeys = [],
  noLaundryKeys = [],
  dismissedCleaningKeys = [],
  selectedRooms,
}: Props) {
  if (reservations.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <h2 className="text-base font-semibold text-gray-800 mb-2">Gross Profit</h2>
        <p className="text-sm text-gray-400">No reservations in this period.</p>
      </div>
    );
  }

  const totals = computeGrossProfit(
    reservations,
    dateRange,
    variableCosts,
    variableCostsByReservation,
    subscriptionItems,
    manualCleaningKeys,
    noLaundryKeys,
    dismissedCleaningKeys,
    selectedRooms
  );
  const { netSales, cleaning, laundry, consumables, subscriptions, wearTear, misc, totalVariableCosts, grossProfit, reservationCount, cleaningCount, laundryCount, cleaningNextMonthCount, extraCleaningCount, noLaundryCount, removedCleaningCount, carryInCount, manualOnCheckoutCount, laundrySetCount, consumableUnitCount, subscriptionCount, wearTearUnitCount, miscUnitCount } = totals;
  const months = countMonths(dateRange.start, dateRange.end);
  const margin = netSales > 0 ? Math.round((grossProfit / netSales) * 100) : 0;
  const isLoss = grossProfit < 0;

  // Build deductions in order — Net Sales → … → Gross Profit. `units` /
  // `unitLabel` drive the per-unit overview columns in the detail table.
  const deductions: { name: string; amount: number; units: number; unitLabel: string }[] = [
    { name: "Cleaning", amount: cleaning, units: cleaningCount, unitLabel: "cleanings" },
    { name: "Laundry", amount: laundry, units: laundrySetCount, unitLabel: "sets" },
    { name: "Consumables", amount: consumables, units: consumableUnitCount, unitLabel: "sets" },
    { name: "Subscriptions", amount: subscriptions, units: subscriptionCount, unitLabel: "subscriptions" },
    { name: "Wear & Tear", amount: wearTear, units: wearTearUnitCount, unitLabel: "items" },
    { name: "Misc", amount: misc, units: miscUnitCount, unitLabel: "incidents" },
  ];

  let runningBase = netSales;
  const deductionEntries: WaterfallEntry[] = deductions.map((d) => {
    const entry: WaterfallEntry = {
      name: d.name,
      base: runningBase - d.amount,
      amount: d.amount,
      type: "deduction",
    };
    runningBase -= d.amount;
    return entry;
  });

  const waterfallData: WaterfallEntry[] = [
    { name: "Net Sales", base: 0, amount: netSales, type: "total" },
    ...deductionEntries,
    { name: "Gross Profit", base: 0, amount: grossProfit, type: "total" },
  ];

  const barColors: string[] = waterfallData.map((d) => {
    if (d.type === "deduction") return "#F43F5E";
    if (d.name === "Gross Profit") return isLoss ? "#F97316" : "#10B981";
    return "#4F46E5";
  });

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
      <h2 className="text-base font-semibold text-gray-800 mb-1">
        Gross Profit — Hrubý Zisk
      </h2>
      <p className="text-xs text-gray-400 mb-5">
        Subscriptions charged per calendar month ({months} month{months !== 1 ? 's' : ''} in period)
      </p>

      {/* KPI row */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="bg-indigo-50 rounded-xl p-4">
          <p className="text-xs font-medium text-indigo-500 uppercase tracking-wide mb-1">
            Net Sales
          </p>
          <p className="text-xl font-bold text-indigo-700">{fmt(netSales)}</p>
        </div>
        <div className="bg-rose-50 rounded-xl p-4">
          <p className="text-xs font-medium text-rose-500 uppercase tracking-wide mb-1">
            Operational Costs
          </p>
          <p className="text-xl font-bold text-rose-600">−{fmt(totalVariableCosts)}</p>
          <p className="text-xs text-rose-400 mt-0.5">Cleaning · Laundry · Consumables · Subs · W&amp;T · Misc</p>
        </div>
        <div className={`rounded-xl p-4 ${isLoss ? "bg-amber-50" : "bg-emerald-50"}`}>
          <p className={`text-xs font-medium uppercase tracking-wide mb-1 ${isLoss ? "text-amber-600" : "text-emerald-600"}`}>
            Gross Profit
          </p>
          <p className={`text-xl font-bold ${isLoss ? "text-amber-700" : "text-emerald-700"}`}>
            {isLoss ? "−" : ""}{fmt(Math.abs(grossProfit))}
          </p>
          <p className={`text-xs mt-0.5 ${isLoss ? "text-amber-500" : "text-emerald-500"}`}>
            {margin}% margin
          </p>
        </div>
      </div>

      {/* Waterfall chart */}
      <div className="mb-8">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Bridge
        </p>
        <div style={{ height: 240 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={waterfallData} barCategoryGap="20%">
              <XAxis
                dataKey="name"
                tick={{ fontSize: 11, fill: "#6B7280" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tickFormatter={fmtAxis}
                tick={{ fontSize: 11, fill: "#9CA3AF" }}
                axisLine={false}
                tickLine={false}
                width={44}
              />
              <ReferenceLine y={0} stroke="#E5E7EB" strokeWidth={1} />
              <Tooltip content={<WaterfallTooltip />} cursor={{ fill: "#F9FAFB" }} />
              <Bar dataKey="base" stackId="waterfall" fill="transparent" />
              <Bar dataKey="amount" stackId="waterfall" radius={[6, 6, 0, 0]}>
                {waterfallData.map((_, i) => (
                  <Cell key={i} fill={barColors[i]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Operational cost breakdown */}
      <div className="border-t border-gray-100 pt-4">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Operational Cost Detail
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              {["Cost", "Units", "Unit price", "Amount", "% of Net Sales"].map((h) => (
                <th
                  key={h}
                  className={`py-2 text-xs font-medium text-gray-500 uppercase tracking-wide ${
                    h === "Cost" ? "text-left" : "text-right"
                  }`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {deductions.map(({ name, amount, units, unitLabel }) => (
              <tr key={name} className="hover:bg-gray-50">
                <td className="py-3 text-gray-700">{name}</td>
                <td className="py-3 text-right tabular-nums text-gray-700">
                  {units > 0 ? (
                    <>
                      {units} <span className="text-xs text-gray-400">{unitLabel}</span>
                    </>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
                <td className="py-3 text-right tabular-nums text-gray-500">
                  {units > 0 ? `${fmt(Math.round(amount / units))} / ${unitLabel.replace(/s$/, "")}` : <span className="text-gray-300">—</span>}
                </td>
                <td className="py-3 text-right tabular-nums text-rose-600">−{fmt(amount)}</td>
                <td className="py-3 text-right tabular-nums text-gray-500">
                  {netSales > 0 ? Math.round((amount / netSales) * 100) : 0}%
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-gray-200">
            <tr>
              <td className="py-2 text-xs font-medium text-gray-500">Total Operational</td>
              <td className="py-2" />
              <td className="py-2" />
              <td className="py-2 text-right text-xs font-bold tabular-nums text-rose-600">
                −{fmt(totalVariableCosts)}
              </td>
              <td className="py-2 text-right text-xs tabular-nums text-gray-500">
                {netSales > 0 ? Math.round((totalVariableCosts / netSales) * 100) : 0}%
              </td>
            </tr>
          </tfoot>
        </table>

        {/* Activity reconciliation: reservations belong to a period if they
            have ≥1 night in it, but their cleaning/laundry only happens at
            checkout. A reservation can also have extra (manual mid-stay)
            cleanings, and a cleaning marked "no laundry" produces no laundry
            event. These counts explain the gaps. */}
        {(() => {
          const expectedCleanings =
            reservationCount - cleaningNextMonthCount - removedCleaningCount + extraCleaningCount + carryInCount;
          const expectedLaundry = cleaningCount - noLaundryCount;
          const cleaningReconciles = expectedCleanings === cleaningCount;
          const laundryReconciles = expectedLaundry === laundryCount;
          const cell = (
            value: number,
            label: ReactNode,
            accent?: "amber" | "violet"
          ) => (
            <div>
              <p
                className={`text-xl font-bold ${
                  value > 0 && accent === "amber"
                    ? "text-amber-600"
                    : value > 0 && accent === "violet"
                    ? "text-violet-600"
                    : "text-gray-800"
                }`}
              >
                {value}
              </p>
              <p className="text-xs text-gray-500">{label}</p>
            </div>
          );
          return (
            <div className="mt-5 rounded-lg border border-gray-100 bg-gray-50/60 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-3">
                Activity in period
              </p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                {cell(reservationCount, <>Reservations <span className="text-gray-400">(≥1 night)</span></>)}
                {cell(cleaningNextMonthCount, <>Roll over <span className="text-gray-400">(checkout next month)</span></>, "amber")}
                {cell(removedCleaningCount, <>Removed <span className="text-gray-400">(stay prolonged)</span></>, "amber")}
                {cell(carryInCount, <>Carry-in <span className="text-gray-400">(prior-month stay)</span></>, "violet")}
                {cell(extraCleaningCount, <>Extra cleanings <span className="text-gray-400">(manual / mid-stay)</span></>, "violet")}
                {cell(cleaningCount, <>Cleaning events</>)}
                {cell(noLaundryCount, <>No-laundry <span className="text-gray-400">(no linen change)</span></>, "amber")}
                {cell(laundryCount, <>Laundry events</>)}
              </div>

              <div className="mt-4 space-y-1.5 border-t border-gray-100 pt-3 text-[11px] text-gray-600">
                <p>
                  <span className="font-semibold text-gray-700">Cleanings</span> = {reservationCount} reservations
                  − {cleaningNextMonthCount} rolling over − {removedCleaningCount} removed + {extraCleaningCount} extra
                  + {carryInCount} carry-in ={" "}
                  <span className="font-semibold">{expectedCleanings}</span>
                  {cleaningReconciles ? (
                    <span className="text-green-600"> ✓ matches {cleaningCount}</span>
                  ) : (
                    <span className="text-amber-600">
                      {" "}vs {cleaningCount} billed (Δ{Math.abs(cleaningCount - expectedCleanings)})
                    </span>
                  )}
                  {manualOnCheckoutCount > 0 && (
                    <span className="text-gray-400">
                      {" "}· {manualOnCheckoutCount} manual cleaning{manualOnCheckoutCount !== 1 ? "s" : ""} fell on a checkout day (same event, not double-counted)
                    </span>
                  )}
                </p>
                <p>
                  <span className="font-semibold text-gray-700">Laundry</span> = {cleaningCount} cleanings
                  − {noLaundryCount} no-laundry ={" "}
                  <span className="font-semibold">{expectedLaundry}</span>
                  {laundryReconciles ? (
                    <span className="text-green-600"> ✓ matches {laundryCount}</span>
                  ) : (
                    <span className="text-amber-600">
                      {" "}vs {laundryCount} billed (Δ = cleanings with no saved laundry provider)
                    </span>
                  )}
                </p>
                <p className="text-gray-400">
                  &ldquo;Events&rdquo; count cleanings/laundry that carry a cost (assigned cleaner /
                  saved provider). Unassigned cleanings aren&apos;t billed, so they&apos;re excluded.
                </p>
              </div>
            </div>
          );
        })()}

        <p className="text-xs text-gray-400 mt-3">
          * Cleaning, laundry, consumables, wear &amp; tear and misc sourced from the cleaning app
          (checkout-date attribution). Subscriptions scaled by months in period. Reservations counted
          when at least one night falls in the period.
        </p>
      </div>
    </div>
  );
}

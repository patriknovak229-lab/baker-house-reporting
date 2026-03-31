'use client';
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
import { getNightsInPeriod } from "@/utils/periodUtils";
import type { DateRange } from "@/utils/periodUtils";
import type { Reservation, Room } from "@/types/reservation";
import type { VariableCostsLookup } from "@/app/api/variable-costs/route";
import { ROOM_TO_BEDS24_ID } from "@/app/api/variable-costs/route";
import type { FixedCostEntry } from "@/app/api/fixed-costs/route";

interface Props {
  reservations: Reservation[];
  dateRange: DateRange;
  variableCosts: VariableCostsLookup;
  fixedCosts: FixedCostEntry[];
  selectedRooms: Room[];
}

/** Count distinct calendar months touched by an inclusive date range. */
function countMonths(start: string, end: string): number {
  const s = new Date(start + 'T12:00:00');
  const e = new Date(end + 'T12:00:00');
  return (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth()) + 1;
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function WaterfallTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const entry = payload[0]?.payload as WaterfallEntry;
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-sm">
      <p className="font-medium text-gray-700 mb-1">{label}</p>
      <p className={entry.type === "deduction" ? "text-rose-600 font-semibold" : "font-semibold " + (entry.amount >= 0 ? "text-indigo-700" : "text-amber-600")}>
        {entry.type === "deduction" ? "−" : ""}{fmt(Math.abs(entry.amount))}
        {entry.type === "total" && entry.amount < 0 ? " (loss)" : ""}
      </p>
    </div>
  );
}

function computeGrossProfit(reservations: Reservation[], dateRange: DateRange, variableCosts: VariableCostsLookup): number {
  let netSales = 0;
  let totalVariableCosts = 0;

  for (const r of reservations) {
    if (r.paymentStatus === "Refunded") continue;
    const nights = getNightsInPeriod(r, dateRange);
    const fraction = r.numberOfNights > 0 ? nights / r.numberOfNights : 0;
    netSales += (r.price - r.commissionAmount - r.paymentChargeAmount) * fraction;

    // Only attribute variable costs when checkout falls within the period (matches cleaners tab logic)
    const checkoutInPeriod = r.checkOutDate >= dateRange.start && r.checkOutDate <= dateRange.end;
    const roomId = ROOM_TO_BEDS24_ID[r.room];
    const varCosts = checkoutInPeriod && roomId ? (variableCosts[`${r.checkOutDate}|${roomId}`] ?? { cleaning: 0, laundry: 0, consumables: 0 }) : { cleaning: 0, laundry: 0, consumables: 0 };
    totalVariableCosts += varCosts.cleaning + varCosts.laundry + varCosts.consumables;
  }

  return netSales - totalVariableCosts;
}

function roomFilteredMonthlyTotal(entry: FixedCostEntry, selectedRooms: Room[]): number {
  return selectedRooms.reduce((sum, room) => {
    const beds24Id = ROOM_TO_BEDS24_ID[room];
    return sum + (beds24Id ? (entry.rooms[beds24Id] ?? 0) : 0);
  }, 0);
}

export default function EBITDABridgeView({ reservations, dateRange, variableCosts, fixedCosts, selectedRooms }: Props) {
  if (reservations.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <h2 className="text-base font-semibold text-gray-800 mb-2">EBITDA</h2>
        <p className="text-sm text-gray-400">No reservations in this period.</p>
      </div>
    );
  }

  const grossProfit = computeGrossProfit(reservations, dateRange, variableCosts);

  // Fixed costs: per-selected-room monthly amount × number of calendar months in period
  const months = countMonths(dateRange.start, dateRange.end);
  const scaledCosts = fixedCosts.map((item) => {
    const monthly = roomFilteredMonthlyTotal(item, selectedRooms);
    return { label: item.label, amount: monthly, scaled: monthly * months };
  });

  const totalFixed = scaledCosts.reduce((s, c) => s + c.scaled, 0);
  const ebitda = grossProfit - totalFixed;
  const isLoss = ebitda < 0;

  // Build waterfall entries: Gross Profit → one step per fixed cost → EBITDA
  let runningBase = grossProfit;
  const deductionEntries: WaterfallEntry[] = scaledCosts.map((c) => {
    const entry: WaterfallEntry = {
      name: c.label,
      base: runningBase - c.scaled,
      amount: c.scaled,
      type: "deduction",
    };
    runningBase -= c.scaled;
    return entry;
  });

  const waterfallData: WaterfallEntry[] = [
    { name: "Gross Profit", base: 0, amount: grossProfit, type: "total" },
    ...deductionEntries,
    { name: "EBITDA", base: 0, amount: ebitda, type: "total" },
  ];

  const barColors: string[] = waterfallData.map((d) => {
    if (d.type === "deduction") return "#F43F5E";
    if (d.name === "EBITDA") return isLoss ? "#F97316" : "#10B981";
    return "#4F46E5";
  });

  const marginLabel = grossProfit !== 0
    ? Math.round((ebitda / Math.abs(grossProfit)) * 100) + "% of gross profit"
    : "—";

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
      <h2 className="text-base font-semibold text-gray-800 mb-1">
        EBITDA — Provozní Zisk
      </h2>
      <p className="text-xs text-gray-400 mb-5">
        Fixed costs charged per calendar month ({months} month{months !== 1 ? 's' : ''} in period)
      </p>

      {/* KPI row */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="bg-indigo-50 rounded-xl p-4">
          <p className="text-xs font-medium text-indigo-500 uppercase tracking-wide mb-1">
            Gross Profit
          </p>
          <p className="text-xl font-bold text-indigo-700">{fmt(grossProfit)}</p>
        </div>
        <div className="bg-rose-50 rounded-xl p-4">
          <p className="text-xs font-medium text-rose-500 uppercase tracking-wide mb-1">
            Fixed Costs
          </p>
          <p className="text-xl font-bold text-rose-600">−{fmt(totalFixed)}</p>
          <p className="text-xs text-rose-400 mt-0.5">For this period</p>
        </div>
        <div className={`rounded-xl p-4 ${isLoss ? "bg-amber-50" : "bg-emerald-50"}`}>
          <p className={`text-xs font-medium uppercase tracking-wide mb-1 ${isLoss ? "text-amber-600" : "text-emerald-600"}`}>
            EBITDA
          </p>
          <p className={`text-xl font-bold ${isLoss ? "text-amber-700" : "text-emerald-700"}`}>
            {isLoss ? "−" : ""}{fmt(Math.abs(ebitda))}
          </p>
          <p className={`text-xs mt-0.5 ${isLoss ? "text-amber-500" : "text-emerald-500"}`}>
            {marginLabel}
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
            <BarChart data={waterfallData} barCategoryGap="25%">
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
              {/* Zero reference line — makes losses immediately visible */}
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

      {/* Fixed costs breakdown */}
      <div className="border-t border-gray-100 pt-4">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Fixed Cost Detail
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              {["Cost", "Monthly", "This Period"].map((h) => (
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
            {scaledCosts.map((c) => (
              <tr key={c.label} className="hover:bg-gray-50">
                <td className="py-3 text-gray-700">{c.label}</td>
                <td className="py-3 text-right text-gray-500">{fmt(c.amount)}</td>
                <td className="py-3 text-right text-rose-600">−{fmt(c.scaled)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-gray-200">
            <tr>
              <td className="py-2 text-xs font-medium text-gray-500">Total Fixed</td>
              <td className="py-2 text-right text-xs text-gray-500">
                {fmt(scaledCosts.reduce((s, c) => s + c.amount, 0))}
              </td>
              <td className="py-2 text-right text-xs font-bold text-rose-600">
                −{fmt(totalFixed)}
              </td>
            </tr>
          </tfoot>
        </table>
        <p className="text-xs text-gray-400 mt-3">
          Fixed costs sourced from the cleaning app. Configure amounts in Fixed Costs tab.
        </p>
      </div>
    </div>
  );
}

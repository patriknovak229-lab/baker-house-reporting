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
import type { Reservation, Room } from "@/types/reservation";
import { getNightsInPeriod } from "@/utils/periodUtils";
import type { DateRange } from "@/utils/periodUtils";
import type { VariableCostEntry, VariableCostsLookup } from "@/app/api/variable-costs/route";
import { ROOM_TO_BEDS24_ID } from "@/app/api/variable-costs/route";

interface Props {
  reservations: Reservation[];
  dateRange: DateRange;
  variableCosts: VariableCostsLookup;
  variableCostsByReservation?: Record<string, VariableCostEntry>;
  /** Subscriptions: monthly amount per Beds24 roomId. Scaled by months-in-period. */
  subscriptionsByRoom?: Record<string, number>;
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

interface Totals {
  netSales: number;
  cleaning: number;
  laundry: number;
  consumables: number;
  subscriptions: number;
  wearTear: number;
  damages: number;
  totalVariableCosts: number;
  grossProfit: number;
}

function computeTotals(
  reservations: Reservation[],
  dateRange: DateRange,
  variableCosts: VariableCostsLookup,
  byReservation: Record<string, VariableCostEntry>,
  subscriptionsByRoom: Record<string, number>,
  selectedRooms?: Room[]
): Totals {
  // ── Net sales: per-reservation, fraction-of-stay within the period ────
  let netSales = 0;
  for (const r of reservations) {
    if (r.paymentStatus === "Refunded") continue;
    const nights = getNightsInPeriod(r, dateRange);
    const fraction = r.numberOfNights > 0 ? nights / r.numberOfNights : 0;
    netSales += (r.price - r.commissionAmount - r.paymentChargeAmount) * fraction;
  }

  // ── Variable costs: sum every cell in the period for the rooms in scope.
  const inScopeRoomIds = new Set<string>(
    (selectedRooms ?? []).map((r) => ROOM_TO_BEDS24_ID[r]).filter(Boolean)
  );
  const allRoomsSelected = !selectedRooms || selectedRooms.length === 0;
  function roomInScope(roomId: string): boolean {
    return allRoomsSelected || inScopeRoomIds.has(roomId);
  }

  let cleaning = 0;
  let laundry = 0;
  let consumables = 0;
  let wearTear = 0;
  let damages = 0;
  for (const [key, v] of Object.entries(variableCosts)) {
    const [date, roomId] = key.split("|");
    if (!date || !roomId) continue;
    if (date < dateRange.start || date > dateRange.end) continue;
    if (!roomInScope(roomId)) continue;
    cleaning += v.cleaning ?? 0;
    laundry += v.laundry ?? 0;
    consumables += v.consumables ?? 0;
    wearTear += v.wearTear ?? 0;
    damages += v.damages ?? 0;
  }
  // Per-reservation entries — only count those tied to reservations whose
  // checkOut falls in the period AND whose room is in scope.
  for (const r of reservations) {
    if (r.paymentStatus === "Refunded") continue;
    if (r.checkOutDate < dateRange.start || r.checkOutDate > dateRange.end) continue;
    if (selectedRooms && !selectedRooms.includes(r.room)) continue;
    const res = byReservation[r.reservationNumber];
    if (!res) continue;
    cleaning += res.cleaning;
    laundry += res.laundry;
    consumables += res.consumables;
    wearTear += res.wearTear ?? 0;
    damages += res.damages ?? 0;
  }

  // ── Subscriptions: scaled monthly per scoped room.
  const months = countMonths(dateRange.start, dateRange.end);
  let subscriptions = 0;
  for (const [roomId, monthly] of Object.entries(subscriptionsByRoom)) {
    if (!roomInScope(roomId)) continue;
    subscriptions += monthly * months;
  }

  const totalVariableCosts = cleaning + laundry + consumables + subscriptions + wearTear + damages;
  const grossProfit = netSales - totalVariableCosts;
  return {
    netSales,
    cleaning,
    laundry,
    consumables,
    subscriptions,
    wearTear,
    damages,
    totalVariableCosts,
    grossProfit,
  };
}

export default function GrossProfitBridgeView({
  reservations,
  dateRange,
  variableCosts,
  variableCostsByReservation = {},
  subscriptionsByRoom = {},
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

  const totals = computeTotals(
    reservations,
    dateRange,
    variableCosts,
    variableCostsByReservation,
    subscriptionsByRoom,
    selectedRooms
  );
  const { netSales, cleaning, laundry, consumables, subscriptions, wearTear, damages, totalVariableCosts, grossProfit } = totals;
  const months = countMonths(dateRange.start, dateRange.end);
  const margin = netSales > 0 ? Math.round((grossProfit / netSales) * 100) : 0;
  const isLoss = grossProfit < 0;

  // Build deductions in order — Net Sales → … → Gross Profit
  const deductions: { name: string; amount: number }[] = [
    { name: "Cleaning", amount: cleaning },
    { name: "Laundry", amount: laundry },
    { name: "Consumables", amount: consumables },
    { name: "Subscriptions", amount: subscriptions },
    { name: "Wear & Tear", amount: wearTear },
    { name: "Damages", amount: damages },
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
            Variable Costs
          </p>
          <p className="text-xl font-bold text-rose-600">−{fmt(totalVariableCosts)}</p>
          <p className="text-xs text-rose-400 mt-0.5">Cleaning · Laundry · Consumables · Subs · W&amp;T · Damages</p>
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

      {/* Variable cost breakdown */}
      <div className="border-t border-gray-100 pt-4">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Variable Cost Detail
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              {["Cost", "Amount", "% of Net Sales"].map((h) => (
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
            {deductions.map(({ name, amount }) => (
              <tr key={name} className="hover:bg-gray-50">
                <td className="py-3 text-gray-700">{name}</td>
                <td className="py-3 text-right text-rose-600">−{fmt(amount)}</td>
                <td className="py-3 text-right text-gray-500">
                  {netSales > 0 ? Math.round((amount / netSales) * 100) : 0}%
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-gray-200">
            <tr>
              <td className="py-2 text-xs font-medium text-gray-500">Total Variable</td>
              <td className="py-2 text-right text-xs font-bold text-rose-600">
                −{fmt(totalVariableCosts)}
              </td>
              <td className="py-2 text-right text-xs text-gray-500">
                {netSales > 0 ? Math.round((totalVariableCosts / netSales) * 100) : 0}%
              </td>
            </tr>
          </tfoot>
        </table>
        <p className="text-xs text-gray-400 mt-3">
          * Cleaning, laundry, consumables, wear & tear and damages sourced from the cleaning app
          (checkout-date attribution). Subscriptions scaled by months in period.
        </p>
      </div>
    </div>
  );
}

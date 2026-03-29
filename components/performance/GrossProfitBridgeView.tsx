'use client';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { VARIABLE_COSTS } from "@/data/performanceMockData";
import type { Reservation } from "@/types/reservation";

interface Props {
  reservations: Reservation[];
}

const fmt = (n: number) =>
  Math.round(n).toLocaleString("cs-CZ") + " Kč";

const fmtAxis = (n: number) =>
  n >= 1000 ? Math.round(n / 1000) + "k" : String(n);

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
      <p className={entry.type === "deduction" ? "text-rose-600 font-semibold" : "text-indigo-700 font-semibold"}>
        {entry.type === "deduction" ? "−" : ""}{fmt(entry.amount)}
      </p>
    </div>
  );
}

function computeTotals(reservations: Reservation[]) {
  let netSales = 0;
  let cleaning = 0;
  let laundry = 0;
  let consumables = 0;

  for (const r of reservations) {
    if (r.paymentStatus === "Refunded") continue;
    netSales += r.price - r.commissionAmount - r.paymentChargeAmount;

    const varCosts = VARIABLE_COSTS[r.reservationNumber] ?? {
      cleaning: 0,
      laundry: 0,
      consumables: 0,
    };
    cleaning += varCosts.cleaning;
    laundry += varCosts.laundry;
    consumables += varCosts.consumables;
  }

  const totalVariableCosts = cleaning + laundry + consumables;
  const grossProfit = netSales - totalVariableCosts;
  return { netSales, cleaning, laundry, consumables, totalVariableCosts, grossProfit };
}

export default function GrossProfitBridgeView({ reservations }: Props) {
  if (reservations.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <h2 className="text-base font-semibold text-gray-800 mb-2">Gross Profit</h2>
        <p className="text-sm text-gray-400">No reservations in this period.</p>
      </div>
    );
  }

  const { netSales, cleaning, laundry, consumables, totalVariableCosts, grossProfit } =
    computeTotals(reservations);

  const margin = netSales > 0 ? Math.round((grossProfit / netSales) * 100) : 0;

  const waterfallData: WaterfallEntry[] = [
    { name: "Net Sales", base: 0, amount: netSales, type: "total" },
    { name: "Cleaning", base: netSales - cleaning, amount: cleaning, type: "deduction" },
    { name: "Laundry", base: netSales - cleaning - laundry, amount: laundry, type: "deduction" },
    {
      name: "Consumables",
      base: grossProfit,
      amount: consumables,
      type: "deduction",
    },
    { name: "Gross Profit", base: 0, amount: grossProfit, type: "total" },
  ];

  const barColors: string[] = waterfallData.map((d) =>
    d.type === "deduction" ? "#F43F5E" : "#4F46E5"
  );
  barColors[4] = "#10B981"; // Gross Profit — green

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
      <h2 className="text-base font-semibold text-gray-800 mb-5">
        Gross Profit — Hrubý Zisk
      </h2>

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
          <p className="text-xs text-rose-400 mt-0.5">Cleaning · Laundry · Consumables</p>
        </div>
        <div className="bg-emerald-50 rounded-xl p-4">
          <p className="text-xs font-medium text-emerald-600 uppercase tracking-wide mb-1">
            Gross Profit
          </p>
          <p className="text-xl font-bold text-emerald-700">{fmt(grossProfit)}</p>
          <p className="text-xs text-emerald-500 mt-0.5">{margin}% margin</p>
        </div>
      </div>

      {/* Waterfall chart */}
      <div className="mb-8">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Bridge
        </p>
        <div style={{ height: 220 }}>
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
                width={40}
              />
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
            {[
              { label: "Cleaning", value: cleaning },
              { label: "Laundry", value: laundry },
              { label: "Consumables", value: consumables },
            ].map(({ label, value }) => (
              <tr key={label} className="hover:bg-gray-50">
                <td className="py-3 text-gray-700">{label}</td>
                <td className="py-3 text-right text-rose-600">−{fmt(value)}</td>
                <td className="py-3 text-right text-gray-500">
                  {netSales > 0 ? Math.round((value / netSales) * 100) : 0}%
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
          * Variable costs pending cleaning app integration — live bookings show 0 until connected.
        </p>
      </div>
    </div>
  );
}

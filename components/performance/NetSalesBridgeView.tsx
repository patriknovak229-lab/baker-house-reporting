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
import { EUR_TO_CZK, CHANNEL_COSTS } from "@/data/performanceMockData";
import type { Reservation } from "@/types/reservation";

interface Props {
  reservations: Reservation[];
}

const CHANNEL_COLORS: Record<string, string> = {
  "Booking.com": "#4F46E5",
  Airbnb: "#F43F5E",
  Direct: "#10B981",
};
const FALLBACK_COLOR = "#94A3B8";

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

// Custom tooltip: shows only the 'amount' value (not the invisible base)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function WaterfallTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const entry = payload[0]?.payload as WaterfallEntry;
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-sm">
      <p className="font-medium text-gray-700 mb-1">{label}</p>
      <p
        className={
          entry.type === "deduction" ? "text-rose-600 font-semibold" : "text-indigo-700 font-semibold"
        }
      >
        {entry.type === "deduction" ? "−" : ""}{fmt(entry.amount)}
      </p>
    </div>
  );
}

interface ChannelBreakdown {
  channel: string;
  gbv: number;
  commission: number;
  paymentFee: number;
  netSales: number;
  color: string;
}

function computeBreakdown(reservations: Reservation[]): {
  overall: { gbv: number; commission: number; paymentFee: number; netSales: number };
  byChannel: ChannelBreakdown[];
} {
  const map: Record<string, { gbv: number; commission: number; paymentFee: number }> = {};

  for (const r of reservations) {
    if (r.paymentStatus === "Refunded") continue;
    const gbv = r.price * EUR_TO_CZK;
    const costs = CHANNEL_COSTS[r.channel] ?? { commissionRate: 0, paymentFeeRate: 0 };
    const commission = gbv * costs.commissionRate;
    const paymentFee = gbv * costs.paymentFeeRate;

    if (!map[r.channel]) map[r.channel] = { gbv: 0, commission: 0, paymentFee: 0 };
    map[r.channel].gbv += gbv;
    map[r.channel].commission += commission;
    map[r.channel].paymentFee += paymentFee;
  }

  const byChannel: ChannelBreakdown[] = Object.entries(map).map(([channel, data]) => ({
    channel,
    ...data,
    netSales: data.gbv - data.commission - data.paymentFee,
    color: CHANNEL_COLORS[channel] ?? FALLBACK_COLOR,
  }));

  const overall = byChannel.reduce(
    (acc, c) => ({
      gbv: acc.gbv + c.gbv,
      commission: acc.commission + c.commission,
      paymentFee: acc.paymentFee + c.paymentFee,
      netSales: acc.netSales + c.netSales,
    }),
    { gbv: 0, commission: 0, paymentFee: 0, netSales: 0 }
  );

  return { overall, byChannel };
}

export default function NetSalesBridgeView({ reservations }: Props) {
  if (reservations.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <h2 className="text-base font-semibold text-gray-800 mb-2">Net Sales</h2>
        <p className="text-sm text-gray-400">No reservations in this period.</p>
      </div>
    );
  }

  const { overall, byChannel } = computeBreakdown(reservations);
  const totalDeductions = overall.commission + overall.paymentFee;
  const netPct = overall.gbv > 0 ? Math.round((overall.netSales / overall.gbv) * 100) : 0;

  // Waterfall entries
  const waterfallData: WaterfallEntry[] = [
    {
      name: "Gross Booking Value",
      base: 0,
      amount: overall.gbv,
      type: "total",
    },
    {
      name: "Platform Commission",
      base: overall.gbv - overall.commission,
      amount: overall.commission,
      type: "deduction",
    },
    {
      name: "Payment Fees",
      base: overall.netSales,
      amount: overall.paymentFee,
      type: "deduction",
    },
    {
      name: "Net Sales",
      base: 0,
      amount: overall.netSales,
      type: "total",
    },
  ];

  const barColors: string[] = waterfallData.map((d) =>
    d.type === "total" ? "#4F46E5" : "#F43F5E"
  );
  // Net Sales bar gets a distinct green to signal the final result
  barColors[3] = "#10B981";

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
      <h2 className="text-base font-semibold text-gray-800 mb-5">
        Net Sales — Bridge from GBV
      </h2>

      {/* KPI row */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="bg-indigo-50 rounded-xl p-4">
          <p className="text-xs font-medium text-indigo-500 uppercase tracking-wide mb-1">
            Gross Booking Value
          </p>
          <p className="text-xl font-bold text-indigo-700">{fmt(overall.gbv)}</p>
        </div>
        <div className="bg-rose-50 rounded-xl p-4">
          <p className="text-xs font-medium text-rose-500 uppercase tracking-wide mb-1">
            3rd Party Costs
          </p>
          <p className="text-xl font-bold text-rose-600">−{fmt(totalDeductions)}</p>
          <p className="text-xs text-rose-400 mt-0.5">
            Commission + fees
          </p>
        </div>
        <div className="bg-emerald-50 rounded-xl p-4">
          <p className="text-xs font-medium text-emerald-600 uppercase tracking-wide mb-1">
            Net Sales
          </p>
          <p className="text-xl font-bold text-emerald-700">{fmt(overall.netSales)}</p>
          <p className="text-xs text-emerald-500 mt-0.5">{netPct}% of GBV retained</p>
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
              {/* Invisible base — lifts the bar to the correct starting position */}
              <Bar dataKey="base" stackId="waterfall" fill="transparent" />
              {/* Visible amount bar */}
              <Bar dataKey="amount" stackId="waterfall" radius={[6, 6, 0, 0]}>
                {waterfallData.map((_, i) => (
                  <Cell key={i} fill={barColors[i]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Per-channel breakdown table */}
      <div className="border-t border-gray-100 pt-4">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
          By Channel
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              {["Channel", "GBV", "Commission", "Pmt Fee", "Net Sales", "Net %"].map(
                (h) => (
                  <th
                    key={h}
                    className={`py-2 text-xs font-medium text-gray-500 uppercase tracking-wide ${
                      h === "Channel" ? "text-left" : "text-right"
                    }`}
                  >
                    {h}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {byChannel.map((c) => (
              <tr key={c.channel} className="hover:bg-gray-50">
                <td className="py-3 flex items-center gap-2">
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: c.color }}
                  />
                  <span className="font-medium text-gray-800">{c.channel}</span>
                </td>
                <td className="py-3 text-right text-gray-700">{fmt(c.gbv)}</td>
                <td className="py-3 text-right text-rose-600">−{fmt(c.commission)}</td>
                <td className="py-3 text-right text-rose-600">−{fmt(c.paymentFee)}</td>
                <td className="py-3 text-right font-semibold text-gray-900">
                  {fmt(c.netSales)}
                </td>
                <td className="py-3 text-right text-gray-500">
                  {c.gbv > 0 ? Math.round((c.netSales / c.gbv) * 100) : 0}%
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-gray-200">
            <tr>
              <td className="py-2 text-xs font-medium text-gray-500">Total</td>
              <td className="py-2 text-right text-xs font-bold text-gray-900">
                {fmt(overall.gbv)}
              </td>
              <td className="py-2 text-right text-xs text-rose-600">
                −{fmt(overall.commission)}
              </td>
              <td className="py-2 text-right text-xs text-rose-600">
                −{fmt(overall.paymentFee)}
              </td>
              <td className="py-2 text-right text-xs font-bold text-emerald-700">
                {fmt(overall.netSales)}
              </td>
              <td className="py-2 text-right text-xs text-gray-500">{netPct}%</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

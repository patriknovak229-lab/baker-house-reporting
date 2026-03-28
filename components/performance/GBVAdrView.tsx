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

interface ChannelStat {
  channel: string;
  reservations: number;
  nights: number;
  gbv: number;
  adr: number;
  color: string;
}

function buildStats(reservations: Reservation[]): ChannelStat[] {
  const map: Record<string, { reservations: number; nights: number; gbv: number }> = {};
  for (const r of reservations) {
    // Skip refunded reservations — no actual revenue collected
    if (r.paymentStatus === "Refunded") continue;
    if (!map[r.channel]) map[r.channel] = { reservations: 0, nights: 0, gbv: 0 };
    map[r.channel].reservations += 1;
    map[r.channel].nights += r.numberOfNights;
    map[r.channel].gbv += r.price * EUR_TO_CZK;
  }
  return Object.entries(map).map(([channel, data]) => ({
    channel,
    ...data,
    adr: data.nights > 0 ? data.gbv / data.nights : 0,
    color: CHANNEL_COLORS[channel] ?? FALLBACK_COLOR,
  }));
}

// Unused but available for future use — channels with no reservations still appear
const _allChannels = Object.keys(CHANNEL_COSTS);

export default function GBVAdrView({ reservations }: Props) {
  const stats = buildStats(reservations);
  const totalGBV = stats.reduce((s, c) => s + c.gbv, 0);
  const totalNights = stats.reduce((s, c) => s + c.nights, 0);
  const overallADR = totalNights > 0 ? totalGBV / totalNights : 0;

  const chartData = stats.map((s) => ({ name: s.channel, GBV: Math.round(s.gbv), color: s.color }));

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
      <h2 className="text-base font-semibold text-gray-800 mb-5">
        Gross Booking Value &amp; ADR
      </h2>

      {reservations.length === 0 ? (
        <p className="text-sm text-gray-400">No reservations in this period.</p>
      ) : (
        <>
          {/* Overall KPIs */}
          <div className="grid grid-cols-2 gap-4 mb-8">
            <div className="bg-indigo-50 rounded-xl p-4">
              <p className="text-xs font-medium text-indigo-500 uppercase tracking-wide mb-1">
                Gross Booking Value
              </p>
              <p className="text-2xl font-bold text-indigo-700">{fmt(totalGBV)}</p>
              <p className="text-xs text-indigo-400 mt-0.5">Hrubé tržby</p>
            </div>
            <div className="bg-emerald-50 rounded-xl p-4">
              <p className="text-xs font-medium text-emerald-600 uppercase tracking-wide mb-1">
                ADR — Avg Daily Rate
              </p>
              <p className="text-2xl font-bold text-emerald-700">{fmt(overallADR)}</p>
              <p className="text-xs text-emerald-500 mt-0.5">Total price ÷ nights</p>
            </div>
          </div>

          {/* GBV by channel — bar chart */}
          {stats.length > 0 && (
            <div className="mb-6">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                GBV by Channel
              </p>
              <div style={{ height: 180 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} barCategoryGap="35%">
                    <XAxis
                      dataKey="name"
                      tick={{ fontSize: 12, fill: "#6B7280" }}
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
                    <Tooltip
                      formatter={(value) => [fmt(Number(value)), "GBV"]}
                      contentStyle={{ fontSize: 12, borderRadius: 8 }}
                      cursor={{ fill: "#F3F4F6" }}
                    />
                    <Bar dataKey="GBV" radius={[6, 6, 0, 0]}>
                      {chartData.map((entry) => (
                        <Cell key={entry.name} fill={entry.color} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Per-channel breakdown table */}
          <div className="border-t border-gray-100 pt-4">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
              Channel Detail
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  {["Channel", "Reservations", "Nights", "GBV", "ADR / night"].map(
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
                {stats.map((s) => (
                  <tr key={s.channel} className="hover:bg-gray-50">
                    <td className="py-3 flex items-center gap-2">
                      <span
                        className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: s.color }}
                      />
                      <span className="font-medium text-gray-800">{s.channel}</span>
                    </td>
                    <td className="py-3 text-right text-gray-700">{s.reservations}</td>
                    <td className="py-3 text-right text-gray-700">{s.nights}</td>
                    <td className="py-3 text-right font-semibold text-gray-900">
                      {fmt(s.gbv)}
                    </td>
                    <td className="py-3 text-right text-gray-700">{fmt(s.adr)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-gray-200">
                <tr>
                  <td className="py-2 text-xs font-medium text-gray-500">Total</td>
                  <td className="py-2 text-right text-xs font-medium text-gray-700">
                    {stats.reduce((s, c) => s + c.reservations, 0)}
                  </td>
                  <td className="py-2 text-right text-xs font-medium text-gray-700">
                    {totalNights}
                  </td>
                  <td className="py-2 text-right text-xs font-bold text-gray-900">
                    {fmt(totalGBV)}
                  </td>
                  <td className="py-2 text-right text-xs font-medium text-gray-700">
                    {fmt(overallADR)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

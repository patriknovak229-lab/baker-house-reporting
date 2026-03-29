'use client';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from "recharts";
import type { Reservation } from "@/types/reservation";

interface Props {
  reservations: Reservation[];
}

const CHANNEL_COLORS: Record<string, string> = {
  "Booking.com": "#4F46E5",
  Airbnb: "#F43F5E",
  Direct: "#10B981",
  "Direct-Phone": "#14B8A6",
};

const FALLBACK_COLOR = "#94A3B8";

interface ChannelStat {
  channel: string;
  reservations: number;
  nights: number;
  color: string;
}

function buildStats(reservations: Reservation[]): ChannelStat[] {
  const map: Record<string, { reservations: number; nights: number }> = {};
  for (const r of reservations) {
    if (!map[r.channel]) map[r.channel] = { reservations: 0, nights: 0 };
    map[r.channel].reservations += 1;
    map[r.channel].nights += r.numberOfNights;
  }
  return Object.entries(map).map(([channel, data]) => ({
    channel,
    ...data,
    color: CHANNEL_COLORS[channel] ?? FALLBACK_COLOR,
  }));
}

export default function ChannelMixView({ reservations }: Props) {
  const stats = buildStats(reservations);
  const totalRes = stats.reduce((s, c) => s + c.reservations, 0);
  const totalNights = stats.reduce((s, c) => s + c.nights, 0);

  const pieData = stats.map((s) => ({
    name: s.channel,
    value: s.reservations,
    color: s.color,
  }));

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
      <h2 className="text-base font-semibold text-gray-800 mb-5">Channel Mix</h2>

      {reservations.length === 0 ? (
        <p className="text-sm text-gray-400">No reservations in this period.</p>
      ) : (
        <div className="flex flex-col md:flex-row gap-8 items-center">
          {/* Donut chart */}
          <div className="w-full md:w-64 shrink-0" style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={90}
                  paddingAngle={2}
                  dataKey="value"
                >
                  {pieData.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value) => [`${value} reservations`, ""]}
                  contentStyle={{ fontSize: 12, borderRadius: 8 }}
                />
                <Legend
                  iconType="circle"
                  iconSize={8}
                  formatter={(value) => (
                    <span style={{ fontSize: 12, color: "#374151" }}>{value}</span>
                  )}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>

          {/* Breakdown table */}
          <div className="flex-1 w-full">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left py-2 text-xs font-medium text-gray-500 uppercase tracking-wide">
                    Channel
                  </th>
                  <th className="text-right py-2 text-xs font-medium text-gray-500 uppercase tracking-wide">
                    Reservations
                  </th>
                  <th className="text-right py-2 text-xs font-medium text-gray-500 uppercase tracking-wide">
                    Share
                  </th>
                  <th className="text-right py-2 text-xs font-medium text-gray-500 uppercase tracking-wide">
                    Nights
                  </th>
                  <th className="text-right py-2 text-xs font-medium text-gray-500 uppercase tracking-wide">
                    Night Share
                  </th>
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
                    <td className="py-3 text-right font-semibold text-gray-900">
                      {totalRes > 0 ? Math.round((s.reservations / totalRes) * 100) : 0}%
                    </td>
                    <td className="py-3 text-right text-gray-700">{s.nights}</td>
                    <td className="py-3 text-right font-semibold text-gray-900">
                      {totalNights > 0 ? Math.round((s.nights / totalNights) * 100) : 0}%
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-gray-200">
                <tr>
                  <td className="py-2 text-xs font-medium text-gray-500">Total</td>
                  <td className="py-2 text-right text-xs font-medium text-gray-700">{totalRes}</td>
                  <td className="py-2 text-right text-xs font-medium text-gray-700">100%</td>
                  <td className="py-2 text-right text-xs font-medium text-gray-700">{totalNights}</td>
                  <td className="py-2 text-right text-xs font-medium text-gray-700">100%</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

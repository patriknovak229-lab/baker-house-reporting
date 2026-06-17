import { formatDate, formatCurrency } from '@/utils/formatters';
import type { PublicOccupancySnapshot } from '@/types/occupancySnapshot';

const WEEKDAY = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function weekdayIdx(iso: string): number {
  return new Date(iso + 'T00:00:00Z').getUTCDay();
}
function dayOfMonth(iso: string): string {
  return iso.slice(8, 10).replace(/^0/, '');
}
function isWeekend(iso: string): boolean {
  const d = weekdayIdx(iso);
  return d === 0 || d === 6;
}
function monthLabel(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  return `${MONTH[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function MetricCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-3xl font-bold ${accent}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  );
}

export default function OccupancySnapshotView({ snapshot }: { snapshot: PublicOccupancySnapshot }) {
  const { data } = snapshot;
  const { metrics, period, calendar, perRoom, rooms, includeGrossSales } = data;

  // Month boundaries within the strip → render a small month tag on the
  // first cell of each month so a range crossing months stays readable.
  const monthStartFlags = calendar.dates.map(
    (d, i) => i === 0 || d.slice(0, 7) !== calendar.dates[i - 1].slice(0, 7),
  );

  const createdLabel = new Date(snapshot.createdAt).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Branded header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
          <p
            className="text-2xl text-gray-900"
            style={{ fontFamily: '"Great Vibes", cursive' }}
          >
            Baker House Apartments
          </p>
          <h1 className="text-xl font-bold text-gray-900 mt-1">Occupancy Report</h1>
          <p className="text-sm text-gray-600 mt-1">{period.label}</p>
          <p className="text-xs text-gray-400 mt-0.5">
            {formatDate(period.start)} – {formatDate(period.end)} · {rooms.join(', ')}
          </p>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        {/* Metric cards */}
        <div className={`grid gap-4 ${includeGrossSales ? 'sm:grid-cols-3' : 'sm:grid-cols-2'} grid-cols-1`}>
          <MetricCard
            label="Occupancy"
            value={`${metrics.occupancyPct}%`}
            sub={`${metrics.soldNights} / ${metrics.availableNights} nights`}
            accent="text-indigo-600"
          />
          <MetricCard
            label="Reservations"
            value={String(metrics.reservationsCount)}
            sub={`${rooms.length} apartment${rooms.length > 1 ? 's' : ''}`}
            accent="text-gray-900"
          />
          {includeGrossSales && metrics.grossSalesCzk !== undefined && (
            <MetricCard
              label="Gross Sales"
              value={formatCurrency(metrics.grossSalesCzk)}
              sub="Pro-rated to period"
              accent="text-emerald-600"
            />
          )}
        </div>

        {/* Per-room breakdown */}
        {perRoom.length > 1 && (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
            <h2 className="text-base font-semibold text-gray-800 mb-4">Occupancy by apartment</h2>
            <div className="space-y-4">
              {perRoom.map((r) => (
                <div key={r.room}>
                  <div className="flex justify-between items-baseline mb-1">
                    <span className="text-sm font-medium text-gray-700">{r.room}</span>
                    <span className="text-sm text-gray-500">
                      <span className="font-semibold text-gray-800">{r.occupancyPct}%</span> ·{' '}
                      {r.soldNights} / {r.availableNights} nights
                    </span>
                  </div>
                  <div className="w-full bg-gray-100 rounded-full h-2.5">
                    <div
                      className="h-2.5 rounded-full bg-indigo-500"
                      style={{ width: `${Math.min(r.occupancyPct, 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Calendar — occupied nights */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-gray-800">Occupied nights</h2>
            <div className="flex items-center gap-3 text-xs text-gray-500">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-indigo-500" /> Occupied
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-gray-100 ring-1 ring-gray-200" /> Free
              </span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="border-separate" style={{ borderSpacing: '2px' }}>
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 bg-white" />
                  {calendar.dates.map((d, i) => (
                    <th key={d} className="align-bottom p-0">
                      {monthStartFlags[i] && (
                        <div className="text-[10px] font-semibold text-gray-500 text-left whitespace-nowrap pb-0.5">
                          {monthLabel(d)}
                        </div>
                      )}
                      <div
                        className={`text-[10px] leading-tight w-6 ${
                          isWeekend(d) ? 'text-gray-400' : 'text-gray-500'
                        }`}
                      >
                        <div>{WEEKDAY[weekdayIdx(d)]}</div>
                        <div className="font-medium">{dayOfMonth(d)}</div>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {calendar.perRoom.map((row) => (
                  <tr key={row.room}>
                    <td className="sticky left-0 z-10 bg-white pr-2 text-xs font-medium text-gray-700 whitespace-nowrap">
                      {row.room}
                    </td>
                    {row.occupied.map((occ, i) => (
                      <td key={calendar.dates[i]} className="p-0">
                        <div
                          title={`${row.room} · ${formatDate(calendar.dates[i])} · ${occ ? 'Occupied' : 'Free'}`}
                          className={`w-6 h-6 rounded-sm ${
                            occ
                              ? 'bg-indigo-500'
                              : isWeekend(calendar.dates[i])
                                ? 'bg-gray-200/70'
                                : 'bg-gray-100'
                          }`}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer */}
        <div className="text-center text-xs text-gray-400 pt-2 pb-8">
          <p>
            Snapshot taken {createdLabel}
            {snapshot.expiresAt ? ` · link expires ${formatDate(snapshot.expiresAt.slice(0, 10))}` : ''}
          </p>
          <p className="mt-1">
            Baker House Apartments ·{' '}
            <a href="https://www.bakerhouseapartments.cz" className="underline hover:text-gray-600">
              bakerhouseapartments.cz
            </a>
          </p>
        </div>
      </main>
    </div>
  );
}

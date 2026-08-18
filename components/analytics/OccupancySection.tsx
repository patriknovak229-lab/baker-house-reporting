'use client';
/**
 * Occupancy — how full the property runs, and where it runs out.
 *
 * ORDER IS AN ARGUMENT. Compression comes first because it is the only evidence of
 * underpricing that needs no market data and carries no channel-fee bias: a night
 * with nothing left to sell could not have sold more at any price. The weekday
 * table follows, on a transient basis, because that is where a rate decision gets
 * made. The market overlay sits on the monthly chart rather than leading, since it
 * is an Airbnb/VRBO view of Brno and deserves less weight than our own book.
 *
 * The month-to-month shape is deliberately last and hedged: six months of trading
 * with inventory arriving in stages is not a season.
 */
import { useState } from 'react';
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MarketResponse, OccupancyResponse } from '@/utils/analyticsTypes';
import { SELLABLE_UNITS } from '@/data/analyticsConfig';
import {
  AXIS_TICK,
  AXIS_TICK_DARK,
  Callout,
  Card,
  czk,
  czkAxis,
  Empty,
  GRID_STROKE,
  HeatLegend,
  heatStyle,
  monthShort,
  num,
  pct,
  Provisional,
  Table,
  Td,
  Tile,
  TOOLTIP_STYLE,
  UNIT_COLORS,
} from './kit';

type HeatMetric = 'occupancy' | 'adr' | 'revpar';

const HEAT_LABELS: Record<HeatMetric, string> = {
  occupancy: 'Occupancy',
  adr: 'ADR',
  revpar: 'RevPAR',
};

const EVENT_KIND_TONE: Record<string, string> = {
  motorsport: 'bg-rose-50 text-rose-700 ring-rose-200',
  'trade-fair': 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  festival: 'bg-violet-50 text-violet-700 ring-violet-200',
  holiday: 'bg-amber-50 text-amber-700 ring-amber-200',
  other: 'bg-gray-50 text-gray-600 ring-gray-200',
};

export default function OccupancySection({
  data,
  market,
}: {
  data: OccupancyResponse;
  market: MarketResponse | null;
}) {
  return (
    <>
      <Compression data={data} />
      <TransientWeekday data={data} />
      <UnitMonthHeatmap data={data} />
      <ForwardPosition market={market} />
      <OccupancyVsMarket data={data} market={market} />
      <MonthlyShape data={data} />
      <EventImpact data={data} />
      <details className="group">
        <summary className="cursor-pointer list-none text-sm font-medium text-gray-500 hover:text-gray-700 py-2">
          <span className="group-open:hidden">Show the raw views — per room, and weekdays including long stays ▾</span>
          <span className="hidden group-open:inline">Hide the raw views ▴</span>
        </summary>
        <div className="space-y-6 mt-4">
          <Callout tone="slate" title="Why these are the detail and not the headline">
            Per-room occupancy measures the allocator as much as demand — Beds24 decides
            which of the interchangeable studios a booking lands in, so one room can read
            100% while its siblings have space. The raw weekday view includes stays of
            every length, so a Monday inside a month-long booking counts as Monday demand.
            Both are here because they matter for cleaning, wear and reconciliation; neither
            should drive a price.
          </Callout>
          <WeekdayPattern data={data} />
          <RoomMonthHeatmap data={data} />
        </div>
      </details>
      <Callout tone={data.confidence.partialYear ? 'amber' : 'sky'} title="How far to trust this">
        {data.confidence.message}
      </Callout>
    </>
  );
}

// ── Day of week ──────────────────────────────────────────────────────────────

function WeekdayPattern({ data }: { data: OccupancyResponse }) {
  const rows = data.weekday.filter((w) => w.availableNights > 0);
  if (rows.length === 0) return null;

  const chartData = rows.map((w) => ({
    day: w.label,
    Occupancy: Math.round(w.occupancy * 100),
    ADR: Math.round(w.adr),
    RevPAR: Math.round(w.revpar),
  }));

  const avgOccupancy =
    rows.reduce((acc, w) => acc + w.soldNights, 0) / rows.reduce((acc, w) => acc + w.availableNights, 0);

  const peak = rows.reduce((a, b) => (b.revpar > a.revpar ? b : a));
  const trough = rows.reduce((a, b) => (b.revpar < a.revpar ? b : a));
  const busiestArrival = rows.reduce((a, b) => (b.arrivals > a.arrivals ? b : a));
  const busiestTurnover = rows.reduce((a, b) => (b.departures > a.departures ? b : a));

  return (
    <Card
      title="Day of week"
      subtitle={
        <>
          The sturdiest pattern in six months of data — every weekday has roughly two dozen
          observations. {peak.label} nights earn {czk(peak.revpar)} per available room against{' '}
          {czk(trough.revpar)} on {trough.label}.
        </>
      }
    >
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Tile label="Strongest night" tone="emerald" value={peak.label} hint={`${czk(peak.revpar)} RevPAR`} />
        <Tile label="Weakest night" tone="rose" value={trough.label} hint={`${czk(trough.revpar)} RevPAR`} />
        <Tile
          label="Most arrivals"
          tone="sky"
          value={busiestArrival.label}
          hint={`${num(busiestArrival.arrivals)} check-ins`}
        />
        <Tile
          label="Most departures"
          tone="amber"
          value={busiestTurnover.label}
          hint={`${num(busiestTurnover.departures)} check-outs — the cleaning peak`}
        />
      </div>

      <div style={{ height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="day" tick={AXIS_TICK_DARK} axisLine={false} tickLine={false} />
            <YAxis
              yAxisId="occ"
              domain={[0, 100]}
              tickFormatter={(v) => `${v}%`}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={44}
            />
            <YAxis
              yAxisId="money"
              orientation="right"
              tickFormatter={czkAxis}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={48}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value, name) =>
                name === 'Occupancy' ? [`${value} %`, name] : [czk(Number(value)), name]
              }
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <ReferenceLine
              yAxisId="occ"
              y={Math.round(avgOccupancy * 100)}
              stroke="#9CA3AF"
              strokeDasharray="4 3"
              label={{ value: 'avg', position: 'right', fontSize: 10, fill: '#9CA3AF' }}
            />
            <Bar yAxisId="occ" dataKey="Occupancy" fill="#A5B4FC" radius={[5, 5, 0, 0]} maxBarSize={40} />
            <Line yAxisId="money" type="monotone" dataKey="ADR" stroke="#F59E0B" strokeWidth={2} dot={{ r: 3 }} />
            <Line
              yAxisId="money"
              type="monotone"
              dataKey="RevPAR"
              stroke="#6366F1"
              strokeWidth={2}
              dot={{ r: 3 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="border-t border-gray-100 pt-4 mt-4">
        <Table columns={['Day', 'Occupancy', 'ADR', 'RevPAR', 'Nights', 'Arrivals', 'Departures']}>
          {rows.map((w) => (
            <tr key={w.isoDow} className="hover:bg-gray-50">
              <Td align="left">
                <span className="font-medium text-gray-800">{w.label}</span>
              </Td>
              <Td>{pct(w.occupancy, 1)}</Td>
              <Td>{czk(w.adr)}</Td>
              <Td bold>{czk(w.revpar)}</Td>
              <Td>
                {num(w.soldNights)}
                <span className="text-gray-300"> / {num(w.availableNights)}</span>
              </Td>
              <Td>{num(w.arrivals)}</Td>
              <Td>{num(w.departures)}</Td>
            </tr>
          ))}
        </Table>
      </div>
    </Card>
  );
}

// ── Named events ─────────────────────────────────────────────────────────────

function EventImpact({ data }: { data: OccupancyResponse }) {
  if (data.events.length === 0) {
    return (
      <Card
        title="Local demand events"
        subtitle="No configured event falls inside this window or the year ahead. The list lives in data/analyticsConfig.ts — add the fairs and races that move Brno and they will be measured here automatically."
      >
        <Empty message="Nothing to measure in this period." />
      </Card>
    );
  }

  const upcoming = data.events.filter((e) => e.isUpcoming);
  const pastEvents = data.events.filter((e) => !e.isUpcoming);

  return (
    <Card
      title="Local demand events"
      subtitle="Past events are measured against the fortnight either side of them, not against the annual average — that isolates the event instead of measuring the season it sits in. Upcoming events have no comparable shoulder yet, so they show the forward position instead: what is already sold, while there is still time to price for it."
    >
      {upcoming.length > 0 && (
        <div className="mb-6">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Coming up
          </p>
          <div className="space-y-3">
            {upcoming.map((e) => (
              <EventRowCard key={e.event.id} row={e} />
            ))}
          </div>
        </div>
      )}

      {pastEvents.length > 0 && (
        <div>
          {upcoming.length > 0 && (
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-3">
              Already happened
            </p>
          )}
          <div className="space-y-4">
            {pastEvents.map((e) => (
              <EventRowCard key={e.event.id} row={e} />
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function EventRowCard({ row: e }: { row: OccupancyResponse['events'][number] }) {
  const tone = EVENT_KIND_TONE[e.event.kind] ?? EVENT_KIND_TONE.other;
  const hasBaseline = e.baselineAdr != null && e.baselineOccupancy != null;

  return (
    <div
      className={`rounded-lg border p-4 ${
        e.isUpcoming ? 'border-sky-200 bg-sky-50/40' : 'border-gray-200'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-gray-800 text-sm">{e.event.label}</span>
            <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ring-1 ${tone}`}>
              {e.event.kind.replace('-', ' ')}
            </span>
            {e.isUpcoming && (
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ring-1 bg-white text-sky-700 ring-sky-200">
                upcoming
              </span>
            )}
          </div>
          <p className="text-[11px] text-gray-400 mt-0.5">
            {e.event.start} → {e.event.end}
            {e.event.note ? ` · ${e.event.note}` : ''}
          </p>
        </div>
        {e.soldNights === 0 && !e.isUpcoming && (
          <span className="text-[11px] text-gray-400">No nights sold in this window</span>
        )}
      </div>

      {e.isUpcoming ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <MiniStat
              label="On the books"
              value={pct(e.occupancy, 0)}
              sub={`${num(e.soldNights)} of ${num(e.availableNights)} room-nights`}
              tone={e.occupancy < 0.3 ? 'bad' : e.occupancy > 0.7 ? 'good' : 'neutral'}
            />
            <MiniStat
              label="ADR so far"
              value={e.soldNights > 0 ? czk(e.adr) : '—'}
              sub={e.soldNights > 0 ? 'average of what is sold' : 'nothing sold yet'}
            />
            <MiniStat label="Revenue booked" value={czk(e.adr * e.soldNights)} sub="for these dates" />
            <MiniStat
              label="Nights still open"
              value={num(e.availableNights - e.soldNights)}
              sub="room-nights left to sell"
            />
          </div>
          {e.occupancy < 0.5 && (
            <p className="text-[11px] text-sky-800 bg-sky-100/70 rounded px-2 py-1.5 mt-3">
              Under half sold for a dated demand spike. If the rate for these nights is still the
              ordinary one, this is the window to change it.
            </p>
          )}
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <MiniStat
              label="Occupancy"
              value={pct(e.occupancy, 0)}
              sub={`${num(e.soldNights)} / ${num(e.availableNights)} nights`}
            />
            <MiniStat
              label="ADR"
              value={czk(e.adr)}
              sub={hasBaseline ? `vs ${czk(e.baselineAdr!)} nearby` : 'no baseline'}
            />
            <MiniStat
              label="ADR uplift"
              value={
                e.adrUplift == null
                  ? '—'
                  : `${e.adrUplift > 0 ? '+' : '−'}${pct(Math.abs(e.adrUplift), 0)}`
              }
              tone={
                e.adrUplift == null
                  ? 'neutral'
                  : e.adrUplift > 0.05
                    ? 'good'
                    : e.adrUplift < -0.05
                      ? 'bad'
                      : 'neutral'
              }
              sub="against the shoulder fortnight"
            />
            <MiniStat
              label="Occupancy uplift"
              value={
                e.occupancyUplift == null
                  ? '—'
                  : `${e.occupancyUplift > 0 ? '+' : '−'}${num(Math.abs(e.occupancyUplift) * 100, 1)} pp`
              }
              tone={
                e.occupancyUplift == null
                  ? 'neutral'
                  : e.occupancyUplift > 0.02
                    ? 'good'
                    : e.occupancyUplift < -0.02
                      ? 'bad'
                      : 'neutral'
              }
              sub="against the shoulder fortnight"
            />
          </div>

          {e.adrUplift != null && e.adrUplift < 0.05 && e.occupancy > 0.9 && (
            <p className="text-[11px] text-amber-700 bg-amber-50 rounded px-2 py-1.5 mt-3">
              Sold out at roughly the ordinary rate — the event demand was captured as volume, not
              price. A higher rate for these dates next time is the obvious test.
            </p>
          )}
          {e.adrUplift != null && e.adrUplift > 0.3 && e.occupancy < 0.9 && (
            <p className="text-[11px] text-amber-700 bg-amber-50 rounded px-2 py-1.5 mt-3">
              A large rate premium held, but {num(e.availableNights - e.soldNights)} room-night
              {e.availableNights - e.soldNights === 1 ? '' : 's'} went unsold. Worth testing whether a
              slightly lower rate would have filled them for more total revenue.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function MiniStat({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'good' | 'bad' | 'neutral';
}) {
  const colour = tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-rose-600' : 'text-gray-900';
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-gray-400">{label}</p>
      <p className={`text-lg font-semibold ${colour} leading-tight`}>{value}</p>
      {sub && <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Monthly shape ────────────────────────────────────────────────────────────

function MonthlyShape({ data }: { data: OccupancyResponse }) {
  const rows = data.seasonIndex;
  if (rows.length === 0) return null;

  const chartData = rows.map((r) => ({
    month: monthShort(r.month),
    fullMonth: r.month,
    RevPAR: Number((r.revparIndex * 100).toFixed(0)),
    Occupancy: Number((r.occupancyIndex * 100).toFixed(0)),
    ADR: Number((r.adrIndex * 100).toFixed(0)),
    partial: r.partial,
  }));

  return (
    <Card
      title="Monthly shape, indexed"
      subtitle="Each month against the period average (100 = average). Indexing rather than plotting raw revenue is what makes the months comparable while the portfolio was still growing — three rooms in February and seven in July would otherwise dominate every line."
    >
      <div style={{ height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="month" tick={AXIS_TICK_DARK} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={(v) => String(v)} tick={AXIS_TICK} axisLine={false} tickLine={false} width={40} />
            <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value, name) => [`${value} (100 = avg)`, name]} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <ReferenceLine y={100} stroke="#9CA3AF" strokeDasharray="4 3" />
            <Bar dataKey="RevPAR" fill="#6366F1" radius={[5, 5, 0, 0]} maxBarSize={40}>
              {chartData.map((d) => (
                <Cell key={d.fullMonth} fill="#6366F1" fillOpacity={d.partial ? 0.4 : 1} />
              ))}
            </Bar>
            <Line type="monotone" dataKey="Occupancy" stroke="#10B981" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="ADR" stroke="#F59E0B" strokeWidth={2} dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="border-t border-gray-100 pt-4 mt-4">
        <Table columns={['Month', 'RevPAR index', 'Occupancy index', 'ADR index', 'Occupancy', 'ADR', 'RevPAR']}>
          {rows.map((r) => {
            const m = data.monthly.find((x) => x.month === r.month);
            return (
              <tr key={r.month} className="hover:bg-gray-50">
                <Td align="left">
                  <span className="font-medium text-gray-800">{monthShort(r.month)}</span>
                  <span className="text-gray-400 ml-1">{r.month.slice(0, 4)}</span>
                  {r.partial && <Provisional />}
                </Td>
                <Td
                  bold
                  className={
                    r.revparIndex >= 1.1 ? '!text-emerald-600' : r.revparIndex <= 0.9 ? '!text-rose-600' : ''
                  }
                >
                  {num(r.revparIndex * 100, 0)}
                </Td>
                <Td>{num(r.occupancyIndex * 100, 0)}</Td>
                <Td>{num(r.adrIndex * 100, 0)}</Td>
                <Td muted>{m ? pct(m.occupancy, 1) : '—'}</Td>
                <Td muted>{m ? czk(m.adr) : '—'}</Td>
                <Td muted>{m ? czk(m.revpar) : '—'}</Td>
              </tr>
            );
          })}
        </Table>
      </div>
    </Card>
  );
}

// ── Month × room heatmap ─────────────────────────────────────────────────────

function RoomMonthHeatmap({ data }: { data: OccupancyResponse }) {
  const [metric, setMetric] = useState<HeatMetric>('occupancy');

  const months = [...new Set(data.roomHeatmap.map((c) => c.month))].sort();
  const rooms = [...new Set(data.roomHeatmap.map((c) => c.room))];
  if (months.length === 0 || rooms.length === 0) {
    return (
      <Card title="Month × room">
        <Empty />
      </Card>
    );
  }

  const byKey = new Map(data.roomHeatmap.map((c) => [`${c.month}|${c.room}`, c]));

  const values = data.roomHeatmap.filter((c) => c.availableNights > 0).map((c) => c[metric]);
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 1;

  const format = (value: number) =>
    metric === 'occupancy' ? pct(value, 0) : czk(value);

  return (
    <Card
      title="Month × room"
      subtitle="Every room-month in one grid. Blank cells are months before that room went on sale — they are excluded from every average rather than counted as empty."
      actions={
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-1">
            {(Object.keys(HEAT_LABELS) as HeatMetric[]).map((m) => (
              <button
                key={m}
                onClick={() => setMetric(m)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                  metric === m
                    ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                    : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
                }`}
              >
                {HEAT_LABELS[m]}
              </button>
            ))}
          </div>
          <HeatLegend min={min} max={max} format={format} />
        </div>
      }
    >
      <div className="overflow-x-auto -mx-2 px-2">
        <table className="border-separate" style={{ borderSpacing: '3px' }}>
          <thead>
            <tr>
              <th className="text-left text-[11px] font-medium text-gray-500 uppercase tracking-wide pr-3">
                Room
              </th>
              {months.map((m) => (
                <th
                  key={m}
                  className="text-[11px] font-medium text-gray-500 uppercase tracking-wide px-1 whitespace-nowrap"
                >
                  {monthShort(m)}
                </th>
              ))}
              <th className="text-[11px] font-medium text-gray-500 uppercase tracking-wide pl-3">Room avg</th>
            </tr>
          </thead>
          <tbody>
            {rooms.map((room) => {
              const cells = months.map((m) => byKey.get(`${m}|${room}`));
              const live = cells.filter((c) => c && c.availableNights > 0);
              const soldSum = live.reduce((acc, c) => acc + (c?.soldNights ?? 0), 0);
              const availSum = live.reduce((acc, c) => acc + (c?.availableNights ?? 0), 0);
              const gbvSum = live.reduce((acc, c) => acc + (c?.adr ?? 0) * (c?.soldNights ?? 0), 0);
              const roomAvg =
                metric === 'occupancy'
                  ? availSum > 0
                    ? soldSum / availSum
                    : 0
                  : metric === 'adr'
                    ? soldSum > 0
                      ? gbvSum / soldSum
                      : 0
                    : availSum > 0
                      ? gbvSum / availSum
                      : 0;

              return (
                <tr key={room}>
                  <td className="text-sm font-medium text-gray-800 pr-3 whitespace-nowrap">{room}</td>
                  {cells.map((c, i) => {
                    if (!c || c.availableNights === 0) {
                      return (
                        <td key={months[i]} className="w-16">
                          <div className="h-9 rounded bg-gray-50 border border-dashed border-gray-200" />
                        </td>
                      );
                    }
                    const intensity = max > min ? (c[metric] - min) / (max - min) : 0.5;
                    return (
                      <td key={months[i]} className="w-16">
                        <div
                          className="h-9 rounded flex items-center justify-center text-[11px] font-medium tabular-nums"
                          style={heatStyle(intensity)}
                          title={`${room} · ${monthShort(c.month)} · occ ${pct(c.occupancy, 0)} · ADR ${czk(c.adr)} · RevPAR ${czk(c.revpar)} · ${c.soldNights}/${c.availableNights} nights`}
                        >
                          {metric === 'occupancy' ? `${Math.round(c.occupancy * 100)}` : heatCompact(c[metric])}
                        </div>
                      </td>
                    );
                  })}
                  <td className="pl-3 text-sm font-semibold text-gray-900 whitespace-nowrap tabular-nums">
                    {format(roomAvg)}
                  </td>
                </tr>
              );
            })}
            <tr>
              <td className="text-[11px] font-medium text-gray-500 uppercase tracking-wide pr-3 pt-2">
                Portfolio
              </td>
              {months.map((m) => {
                const point = data.monthly.find((x) => x.month === m);
                if (!point) return <td key={m} />;
                const value = metric === 'occupancy' ? point.occupancy : point[metric];
                return (
                  <td key={m} className="pt-2">
                    <div className="h-7 rounded bg-gray-100 flex items-center justify-center text-[11px] font-semibold text-gray-700 tabular-nums">
                      {metric === 'occupancy' ? `${Math.round(value * 100)}` : heatCompact(value)}
                    </div>
                  </td>
                );
              })}
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-gray-400 mt-3">
        {metric === 'occupancy' ? 'Cells show occupancy %.' : `Cells show ${HEAT_LABELS[metric]} in thousands of Kč.`}{' '}
        Hover any cell for the full breakdown.
      </p>
    </Card>
  );
}

/**
 * Tighter than the shared `czkAxis`: heatmap cells are 64 px wide, so the money
 * label has to lose the thousands space to fit ("2k", not "2 k").
 */
function heatCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })}M`;
  if (abs >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

// ── Compression — the bias-free underpricing signal ──────────────────────────

/**
 * How often the property had nothing left to sell.
 *
 * This is the one pricing signal in the whole section that needs no external data
 * and carries no bias. A night where every available room sold could not have sold
 * more at any price — so its rate never had to ration demand, and we never
 * discovered what that night was worth. Market percentiles can be argued with;
 * a sold-out calendar cannot.
 *
 * Long stays are excluded from both sides. A room committed to a month-long guest
 * was not available to a Friday transient booker, so counting it as capacity would
 * understate compression, and counting its negotiated nightly rate would drag the
 * ADR comparison down.
 */
function Compression({ data }: { data: OccupancyResponse }) {
  const { compression, transientLosMax } = data;
  if (compression.totalDates === 0) return <Card title="Compression"><Empty /></Card>;

  const soldOutByDow = data.weekdayTransient.map((w) => ({
    day: w.label,
    'Sold out': Math.round(w.soldOutRate * 100),
    Occupancy: Math.round(w.occupancy * 100),
  }));

  const peak = [...data.weekdayTransient].sort((a, b) => b.soldOutRate - a.soldOutRate)[0];
  const soft = [...data.weekdayTransient].sort((a, b) => a.soldOutRate - b.soldOutRate)[0];

  // Longest unbroken run of sold-out nights — a week of them is a different
  // problem from the same count sprinkled across the period.
  let longestRun = 0;
  let run = 0;
  for (const day of compression.days) {
    run = day.soldOut ? run + 1 : 0;
    longestRun = Math.max(longestRun, run);
  }

  return (
    <Card
      title="Compression — how often we ran out of rooms"
      subtitle={
        <>
          A night where every available room sold could not have sold more at any price, so
          its rate never had to ration demand. This is the only underpricing evidence here
          that needs no market data and no comp set. Stays over {transientLosMax} nights are
          excluded from both sides — a room already committed to a long stay was never on
          sale to a transient booker.
        </>
      }
    >
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Tile
          label="Nights sold out"
          tone={compression.soldOutRate > 0.5 ? 'rose' : 'emerald'}
          value={pct(compression.soldOutRate, 0)}
          hint={`${num(compression.soldOutDates)} of ${num(compression.totalDates)} nights`}
        />
        <Tile
          label="Longest sold-out run"
          tone="amber"
          value={`${num(longestRun)} nights`}
          hint="consecutive, nothing left to sell"
        />
        <Tile
          label="Tightest night"
          tone="rose"
          value={peak?.label ?? '—'}
          hint={peak ? `${pct(peak.soldOutRate, 0)} of ${peak.label}s sold out` : undefined}
        />
        <Tile
          label="Softest night"
          tone="sky"
          value={soft?.label ?? '—'}
          hint={soft ? `${pct(soft.soldOutRate, 0)} sold out · ${pct(soft.occupancy, 0)} full` : undefined}
        />
      </div>

      {compression.soldOutRate > 0.4 && (
        <div className="mb-5">
          <Callout tone="amber" title={`${pct(compression.soldOutRate, 0)} of nights had zero spare capacity`}>
            At this level the rate is not the constraint — inventory is. Every sold-out night
            is a night whose ceiling was never tested, and{' '}
            {peak ? `${peak.label} sold out ${pct(peak.soldOutRate, 0)} of the time` : 'the peak nights sold out routinely'}.
            The lever is price on those specific nights, not more distribution.
          </Callout>
        </div>
      )}

      <div style={{ height: 220 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={soldOutByDow} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="day" tick={AXIS_TICK_DARK} axisLine={false} tickLine={false} />
            <YAxis
              domain={[0, 100]}
              tickFormatter={(v) => `${v}%`}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={44}
            />
            <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value, name) => [`${value} %`, name]} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="Sold out" fill="#F43F5E" radius={[5, 5, 0, 0]} maxBarSize={38} />
            <Line type="monotone" dataKey="Occupancy" stroke="#6366F1" strokeWidth={2} dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <CalendarStrip days={compression.days} />

      {compression.longStayNights > 0 && (
        <p className="text-[11px] text-gray-400 mt-4 leading-relaxed">
          {num(compression.longStayNights)} room-night
          {compression.longStayNights === 1 ? '' : 's'} from {num(compression.longStayBookings)} stay
          {compression.longStayBookings === 1 ? '' : 's'} over {transientLosMax} nights were excluded
          from both sides of every figure on this card.
        </p>
      )}
    </Card>
  );
}

/**
 * One cell per night, coloured by occupancy, ringed when sold out.
 *
 * Sequence is the information: a fortnight of consecutive sold-out nights around a
 * race weekend reads completely differently from the same count scattered over six
 * months, and only a strip shows that.
 */
function CalendarStrip({ days }: { days: OccupancyResponse['compression']['days'] }) {
  if (days.length === 0) return null;
  return (
    <div className="mt-6">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
          Every night in the period
        </p>
        <div className="flex items-center gap-3 text-[11px] text-gray-500">
          <HeatLegend min={0} max={1} format={(v) => pct(v, 0)} />
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm bg-indigo-700 ring-2 ring-rose-400 inline-block" />
            sold out
          </span>
        </div>
      </div>
      <div className="flex flex-wrap gap-[3px]">
        {days.map((d) => (
          <span
            key={d.stayDate}
            title={`${d.stayDate} · ${d.sold}/${d.capacity} sold · ${pct(d.occupancy, 0)}${
              d.sold > 0 ? ` · ${czk(d.adr)} ADR` : ''
            }${d.soldOut ? ' · SOLD OUT' : ''}`}
            className={`w-[9px] h-[18px] rounded-sm ${d.soldOut ? 'ring-1 ring-rose-400' : ''}`}
            style={{ backgroundColor: heatStyle(d.occupancy).backgroundColor }}
          />
        ))}
      </div>
    </div>
  );
}

// ── Transient weekday ────────────────────────────────────────────────────────

/**
 * Weekday performance with long stays stripped out, and the sold-out/spare ADR
 * comparison that turns it into a pricing decision.
 *
 * The column to read is the last one. If the nights that sold out earned LESS than
 * the nights with rooms to spare, then price was not doing the rationing — demand
 * was, and the rate was set below what the night would bear. Where the spare sample
 * is tiny the row says so rather than inviting a conclusion from three nights.
 */
function TransientWeekday({ data }: { data: OccupancyResponse }) {
  const rows = data.weekdayTransient.filter((w) => w.availableNights > 0);
  if (rows.length === 0) return null;

  /** Fewer than this many spare nights and the ADR comparison is anecdote. */
  const MIN_SPARE = 5;

  const inversions = rows.filter(
    (w) =>
      w.spareDates >= MIN_SPARE &&
      w.adrWhenSoldOut !== null &&
      w.adrWhenSpare !== null &&
      w.adrWhenSoldOut < w.adrWhenSpare,
  );

  return (
    <Card
      title={`Weekday pricing signal — transient stays only (up to ${data.transientLosMax} nights)`}
      subtitle={
        <>
          A Monday inside a 25-night booking was bought once, months earlier, at a negotiated
          rate — and it then blocked that room against every later Monday enquiry. It pushes
          Monday occupancy up and Monday ADR down at the same time, so the two errors cannot
          cancel out. Here those nights are removed from the sold side and their room-nights
          from the available side.
        </>
      }
    >
      {inversions.length > 0 && (
        <div className="mb-5">
          <Callout
            tone="amber"
            title={`Price is not rationing demand on ${inversions.map((w) => w.label).join(', ')}`}
          >
            On {inversions.length === 1 ? 'this weekday' : 'these weekdays'} the nights that
            sold out earned <strong>less</strong> per room than the nights with capacity to
            spare — {inversions
              .map(
                (w) =>
                  `${w.label} ${czk(w.adrWhenSoldOut!)} sold-out vs ${czk(w.adrWhenSpare!)} with spare`,
              )
              .join('; ')}
            . That is backwards. If the rate were tracking demand, the nights that filled
            completely would be the expensive ones.
          </Callout>
        </div>
      )}

      <Table
        columns={[
          'Day',
          'Occupancy',
          'ADR',
          'RevPAR',
          'Sold out',
          'ADR sold-out',
          'ADR with spare',
          'Gap',
          'Long-stay nights',
        ]}
      >
        {rows.map((w) => {
          const gap =
            w.adrWhenSoldOut !== null && w.adrWhenSpare !== null && w.adrWhenSpare > 0
              ? w.adrWhenSoldOut / w.adrWhenSpare - 1
              : null;
          const thin = w.spareDates < MIN_SPARE;
          return (
            <tr key={w.isoDow} className="hover:bg-gray-50">
              <Td align="left">
                <span className="font-medium text-gray-800">{w.label}</span>
              </Td>
              <Td>{pct(w.occupancy, 1)}</Td>
              <Td>{czk(w.adr)}</Td>
              <Td bold>{czk(w.revpar)}</Td>
              <Td className={w.soldOutRate >= 0.8 ? '!text-rose-600 font-semibold' : ''}>
                {pct(w.soldOutRate, 0)}
                <span className="text-gray-300">
                  {' '}
                  {w.soldOutDates}/{w.totalDates}
                </span>
              </Td>
              <Td>{w.adrWhenSoldOut === null ? '—' : czk(w.adrWhenSoldOut)}</Td>
              <Td>
                {w.adrWhenSpare === null ? '—' : czk(w.adrWhenSpare)}
                {thin && w.spareDates > 0 && (
                  <span className="text-gray-300"> ({w.spareDates}n)</span>
                )}
              </Td>
              <Td
                className={
                  gap === null || thin
                    ? '!text-gray-300'
                    : gap < -0.05
                      ? '!text-rose-600 font-semibold'
                      : gap > 0.05
                        ? '!text-emerald-600'
                        : ''
                }
              >
                {gap === null ? '—' : `${gap > 0 ? '+' : '−'}${num(Math.abs(gap) * 100, 0)} %`}
              </Td>
              <Td muted>{w.longStayNights === 0 ? '—' : num(w.longStayNights)}</Td>
            </tr>
          );
        })}
      </Table>

      <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">
        Gap = ADR on sold-out nights against ADR on nights with rooms left. Greyed out where
        fewer than {MIN_SPARE} nights of that weekday had spare capacity — with a handful of
        observations the comparison is anecdote, not signal.
      </p>
    </Card>
  );
}

// ── Month × sellable unit ────────────────────────────────────────────────────

/**
 * The headline grid: month against SELLABLE UNIT, not against physical room.
 *
 * K.102, K.103 and K.106 are one product sold interchangeably, and Beds24 picks
 * which one takes a booking. Read per room, the allocator's packing order looks
 * like a demand pattern. Read per unit, the question becomes the real one: was
 * there demand for a 1KK Urban studio that night, and did we have one left.
 */
function UnitMonthHeatmap({ data }: { data: OccupancyResponse }) {
  const [metric, setMetric] = useState<HeatMetric>('occupancy');

  const months = [...new Set(data.unitHeatmap.map((c) => c.month))].sort();
  const unitIds = [...new Set(data.unitHeatmap.map((c) => c.unitId))];
  const units = SELLABLE_UNITS.filter((u) => unitIds.includes(u.id));
  if (months.length === 0 || units.length === 0) {
    return (
      <Card title="Month × sellable unit">
        <Empty />
      </Card>
    );
  }

  const cell = (month: string, unitId: string) =>
    data.unitHeatmap.find((c) => c.month === month && c.unitId === unitId);

  const values = data.unitHeatmap.filter((c) => c.availableNights > 0).map((c) => c[metric]);
  const max = values.length > 0 ? Math.max(...values) : 1;
  const min = metric === 'occupancy' ? 0 : values.length > 0 ? Math.min(...values) : 0;
  const format = (v: number) => (metric === 'occupancy' ? pct(v, 0) : heatCompact(v));

  // Period totals per unit, which is what most readers actually want from this grid.
  const totals = units.map((u) => {
    const cells = data.unitHeatmap.filter((c) => c.unitId === u.id);
    const sold = cells.reduce((acc, c) => acc + c.soldNights, 0);
    const available = cells.reduce((acc, c) => acc + c.availableNights, 0);
    const gbv = cells.reduce((acc, c) => acc + c.adr * c.soldNights, 0);
    return {
      unit: u,
      sold,
      available,
      occupancy: available > 0 ? sold / available : 0,
      adr: sold > 0 ? gbv / sold : 0,
      revpar: available > 0 ? gbv / available : 0,
    };
  });

  return (
    <Card
      title="Month × sellable unit"
      subtitle={
        <>
          The grain the market actually buys. Each Urban cell covers three interchangeable
          studios and each Deluxe cell covers two, so a 92% Urban month means all three
          averaged 92% — not that one of them was busy while the others had space.
        </>
      }
      actions={
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          {(Object.keys(HEAT_LABELS) as HeatMetric[]).map((m) => (
            <button
              key={m}
              onClick={() => setMetric(m)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                metric === m ? 'bg-white shadow-sm text-indigo-700' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {HEAT_LABELS[m]}
            </button>
          ))}
        </div>
      }
    >
      <div className="flex justify-end mb-3">
        <HeatLegend min={min} max={max} format={format} />
      </div>

      <div className="overflow-x-auto -mx-2 px-2">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="py-2 text-left text-[11px] font-medium text-gray-500 uppercase tracking-wide">
                Unit
              </th>
              {months.map((m) => (
                <th
                  key={m}
                  className="py-2 px-1 text-center text-[11px] font-medium text-gray-500 uppercase tracking-wide"
                >
                  {monthShort(m)}
                </th>
              ))}
              <th className="py-2 pl-3 text-right text-[11px] font-medium text-gray-500 uppercase tracking-wide">
                Period
              </th>
            </tr>
          </thead>
          <tbody>
            {units.map((u) => {
              const total = totals.find((t) => t.unit.id === u.id)!;
              return (
                <tr key={u.id}>
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    <span className="flex items-center gap-2">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: UNIT_COLORS[u.id] ?? '#94A3B8' }}
                      />
                      <span>
                        <span className="font-medium text-gray-800">{u.shortLabel}</span>
                        <span className="text-[11px] text-gray-400 ml-1.5">
                          {u.rooms.length > 1 ? `${u.rooms.length} units` : u.rooms[0]}
                        </span>
                      </span>
                    </span>
                  </td>
                  {months.map((m) => {
                    const c = cell(m, u.id);
                    if (!c || c.availableNights === 0) {
                      return (
                        <td key={m} className="py-1.5 px-1">
                          <div className="h-9 rounded bg-gray-50 flex items-center justify-center text-[10px] text-gray-300">
                            —
                          </div>
                        </td>
                      );
                    }
                    const intensity = max > min ? (c[metric] - min) / (max - min) : 0;
                    const style = heatStyle(intensity);
                    return (
                      <td key={m} className="py-1.5 px-1">
                        <div
                          className="h-9 rounded flex flex-col items-center justify-center text-[11px] font-medium leading-none"
                          style={style}
                          title={`${u.shortLabel} · ${m} · ${pct(c.occupancy, 0)} occupancy · ${czk(c.adr)} ADR · ${c.soldNights}/${c.availableNights} nights`}
                        >
                          <span>{format(c[metric])}</span>
                        </div>
                      </td>
                    );
                  })}
                  <td className="py-1.5 pl-3 text-right whitespace-nowrap font-semibold text-gray-900">
                    {format(total[metric])}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── Forward position vs market ───────────────────────────────────────────────

/**
 * MPI by horizon — our occupancy on the books against the comp set's, per horizon.
 *
 * Our numerator is computed from the bookings archive, never from PriceLabs: their
 * view of our own performance reads 0% for the multi-unit listings, because bookings
 * land on physical rooms in Beds24 and they sync at the sellable level. Their market
 * side, though, checked out against ours where the two compare 1:1.
 *
 * The shape of this curve is the section's most strategic output. Above 1 near-in and
 * below 1 far out means we win late demand and cede early demand — which is a pricing
 * choice, not an accident, and worth making deliberately.
 */
function ForwardPosition({ market }: { market: MarketResponse | null }) {
  if (!market) return null;
  const rows = market.portfolio.filter((h) => h.ourAvailableNights > 0);
  if (rows.length === 0) return null;

  const withMarket = rows.filter((h) => h.mpi !== null);
  const crossover = withMarket.find((h) => (h.mpi ?? 1) < 1);

  const chartData = rows.map((h) => ({
    horizon: `${h.horizonDays}d`,
    Ours: Math.round(h.ourOccupancy * 100),
    Market: h.marketOccupancy === null ? null : Math.round(h.marketOccupancy * 100),
    MPI: h.mpi === null ? null : Number(h.mpi.toFixed(2)),
  }));

  return (
    <Card
      title="Forward position against the market"
      subtitle={
        <>
          Occupancy already on the books over each horizon, against the Brno comp set.
          Our side comes from the bookings archive; the market side from PriceLabs.
          {market.meta.capturedAt && (
            <>
              {' '}
              Market snapshot {new Date(market.meta.capturedAt).toLocaleDateString('cs-CZ')}
              {market.meta.stale && <span className="text-amber-600"> — over 48 h old</span>}.
            </>
          )}
        </>
      }
    >
      {!market.meta.configured && (
        <div className="mb-5">
          <Callout tone="slate" title="No market key configured">
            Set <code>PRICELABS_API_KEY</code> and the comparison appears here. Everything on
            our own side is unaffected.
          </Callout>
        </div>
      )}

      {crossover && (
        <div className="mb-5">
          <Callout tone="sky" title={`We lead the market inside ${crossover.horizonDays} days and trail it beyond`}>
            MPI crosses 1.0 at the {crossover.horizonDays}-day horizon. Winning late demand and
            ceding early demand is a defensible strategy — late demand is worth more per night
            here, and long-lead bookings cancel far more often (see Booking windows). It is only
            a problem if it is happening by accident rather than by choice.
          </Callout>
        </div>
      )}

      <div style={{ height: 250 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="horizon" tick={AXIS_TICK_DARK} axisLine={false} tickLine={false} />
            <YAxis
              yAxisId="occ"
              domain={[0, 100]}
              tickFormatter={(v) => `${v}%`}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={44}
            />
            <YAxis
              yAxisId="mpi"
              orientation="right"
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={40}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value, name) => (name === 'MPI' ? [value, 'MPI'] : [`${value} %`, name])}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <ReferenceLine yAxisId="mpi" y={1} stroke="#9CA3AF" strokeDasharray="4 3" />
            <Bar yAxisId="occ" dataKey="Ours" fill="#6366F1" radius={[5, 5, 0, 0]} maxBarSize={34} />
            <Bar yAxisId="occ" dataKey="Market" fill="#CBD5E1" radius={[5, 5, 0, 0]} maxBarSize={34} />
            <Line
              yAxisId="mpi"
              type="monotone"
              dataKey="MPI"
              stroke="#F43F5E"
              strokeWidth={2}
              dot={{ r: 3 }}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="border-t border-gray-100 pt-4 mt-4">
        <Table columns={['Unit', 'Comps', ...market.portfolio.map((h) => `${h.horizonDays}d MPI`)]}>
          {market.byUnit.map((u) => (
            <tr key={u.unitId} className="hover:bg-gray-50">
              <Td align="left">
                <span className="flex items-center gap-2">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: UNIT_COLORS[u.unitId] ?? '#94A3B8' }}
                  />
                  <span className="font-medium text-gray-800">{u.shortLabel}</span>
                </span>
              </Td>
              <Td muted>
                {u.compSetListings === null ? '—' : num(u.compSetListings)}
                {u.compSetListings !== null && u.compSetListings < 25 && (
                  <span className="text-amber-500" title="Thin comp set — treat this row's benchmark with caution">
                    {' '}
                    ⚠
                  </span>
                )}
              </Td>
              {u.horizons.map((h) => (
                <Td
                  key={h.horizonDays}
                  className={
                    h.mpi === null
                      ? '!text-gray-300'
                      : h.mpi >= 1.2
                        ? '!text-emerald-600 font-semibold'
                        : h.mpi < 0.9
                          ? '!text-rose-600'
                          : ''
                  }
                >
                  {h.mpi === null ? '—' : num(h.mpi, 2)}
                </Td>
              ))}
            </tr>
          ))}
          <tr className="bg-gray-50/60">
            <Td align="left" bold>
              Portfolio
            </Td>
            <Td muted>—</Td>
            {market.portfolio.map((h) => (
              <Td key={h.horizonDays} bold>
                {h.mpi === null ? '—' : num(h.mpi, 2)}
              </Td>
            ))}
          </tr>
        </Table>
      </div>

      <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">
        MPI = our occupancy ÷ market occupancy. 1.0 is exactly market. Comps = listings in the
        benchmark; a set under 25 is flagged, because the two-bedroom pools are far smaller
        than the one-bedroom pool. {market.meta.source}.
      </p>
    </Card>
  );
}

// ── Monthly occupancy against the market ─────────────────────────────────────

function OccupancyVsMarket({
  data,
  market,
}: {
  data: OccupancyResponse;
  market: MarketResponse | null;
}) {
  const monthly = data.monthly.filter((m) => m.availableNights > 0);
  if (monthly.length === 0) return null;

  const marketByMonth = new Map((market?.monthly ?? []).map((m) => [m.month, m]));
  const hasMarket = monthly.some((m) => marketByMonth.get(m.month)?.marketOccupancy != null);

  const chartData = monthly.map((m) => {
    const mk = marketByMonth.get(m.month);
    return {
      month: monthShort(m.month),
      fullMonth: m.month,
      Ours: Math.round(m.occupancy * 100),
      Market: mk?.marketOccupancy == null ? null : Math.round(mk.marketOccupancy * 100),
      'Our ADR': Math.round(m.adr),
      'Market ADR': mk?.marketAdr == null ? null : Math.round(mk.marketAdr),
      partial: m.partial,
    };
  });

  return (
    <Card
      title="Occupancy by month, against the market"
      subtitle={
        hasMarket ? (
          <>
            Our own occupancy from the archive; the market line is the Brno comp set for the
            same months, weighted by our capacity in each unit. Market ADR is shown for
            context only — those are Airbnb-listed prices, which carry a different fee load
            than our Booking.com-facing rates.
          </>
        ) : (
          <>
            Our own occupancy by month. The market comparison appears once a PriceLabs
            snapshot has been captured.
          </>
        )
      }
    >
      <div style={{ height: 270 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="month" tick={AXIS_TICK_DARK} axisLine={false} tickLine={false} />
            <YAxis
              yAxisId="occ"
              domain={[0, 100]}
              tickFormatter={(v) => `${v}%`}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={44}
            />
            <YAxis
              yAxisId="money"
              orientation="right"
              tickFormatter={czkAxis}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={48}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value, name) =>
                String(name).includes('ADR') ? [czk(Number(value)), name] : [`${value} %`, name]
              }
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar yAxisId="occ" dataKey="Ours" fill="#6366F1" radius={[5, 5, 0, 0]} maxBarSize={40}>
              {chartData.map((d) => (
                <Cell key={d.fullMonth} fill="#6366F1" fillOpacity={d.partial ? 0.4 : 1} />
              ))}
            </Bar>
            {hasMarket && (
              <Line
                yAxisId="occ"
                type="monotone"
                dataKey="Market"
                stroke="#94A3B8"
                strokeWidth={2}
                strokeDasharray="5 3"
                dot={{ r: 2 }}
                connectNulls
              />
            )}
            <Line
              yAxisId="money"
              type="monotone"
              dataKey="Our ADR"
              stroke="#F59E0B"
              strokeWidth={2}
              dot={{ r: 3 }}
            />
            {hasMarket && (
              <Line
                yAxisId="money"
                type="monotone"
                dataKey="Market ADR"
                stroke="#FCD34D"
                strokeWidth={2}
                strokeDasharray="5 3"
                dot={{ r: 2 }}
                connectNulls
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

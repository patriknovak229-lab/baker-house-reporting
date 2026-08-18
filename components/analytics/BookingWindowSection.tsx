'use client';
/**
 * Booking windows.
 *
 * The section is ordered by decision value rather than by data type. The booking
 * curve comes first because it is the only chart here that tells the operator
 * WHEN to act on price; the lead-time distribution explains its shape; the
 * cancellation analysis then qualifies it, because a night booked ninety days out
 * is worth much less than one booked three days out if it is four times more
 * likely to evaporate.
 */
import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CHANNEL_COLORS, CHANNEL_COLOR_FALLBACK } from '@/utils/channelColors';
import type { BookingWindowResponse, MarketResponse } from '@/utils/analyticsTypes';
import {
  AXIS_TICK,
  AXIS_TICK_DARK,
  Callout,
  Card,
  czk,
  days,
  Empty,
  GRID_STROKE,
  heatStyle,
  monthShort,
  num,
  pct,
  ROOM_COLORS,
  SERIES_COLORS,
  Table,
  Td,
  Tile,
  TOOLTIP_STYLE,
} from './kit';

const ISO_DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function BookingWindowSection({
  data,
  market,
}: {
  data: BookingWindowResponse;
  market: MarketResponse | null;
}) {
  if (data.summary.bookings === 0) {
    return <Empty message="No bookings arrive in this period." />;
  }

  return (
    <>
      <Callout tone="slate" title="Attribution">
        Everything in this section is measured on the <strong>booked</strong> basis — grouped by when a
        booking was made, or how many days before arrival it was made. The Overview section is measured
        on the <strong>stay</strong> basis. The two answer different questions and will not tie.
      </Callout>

      <SummaryTiles data={data} />
      <MarketWindow data={data} market={market} />
      <BookingCurve data={data} />
      <LeadTimeDistribution data={data} />
      <LeadTimeTrend data={data} />
      <LeadTimeByDimension data={data} />
      <Cancellations data={data} />
      <BookingClock data={data} />
    </>
  );
}

// ── Summary ──────────────────────────────────────────────────────────────────

function SummaryTiles({ data }: { data: BookingWindowResponse }) {
  const s = data.summary;
  const c = data.cancellations;
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <Tile
        label="Median booking window"
        tone="indigo"
        value={days(s.medianLeadDays)}
        hint={`Mean ${days(s.avgLeadDays)}, 90th percentile ${days(s.p90LeadDays)}`}
      />
      <Tile
        label="Booked within a week"
        tone={s.lastMinuteShare > 0.4 ? 'amber' : 'slate'}
        value={pct(s.lastMinuteShare, 0)}
        hint="Share of bookings made 7 days out or less"
      />
      <Tile
        label="Booked 60+ days out"
        tone="sky"
        value={pct(s.earlyBirdShare, 0)}
        hint="The long-lead tail — small, and the least reliable"
      />
      <Tile
        label="Guest cancellation rate"
        tone={c.cancellationRate > 0.15 ? 'rose' : 'slate'}
        value={pct(c.cancellationRate, 1)}
        hint={
          c.avgDaysBeforeArrival == null
            ? 'Abandoned checkouts excluded'
            : `Cancelled on average ${days(c.avgDaysBeforeArrival)} before arrival`
        }
      />
    </div>
  );
}

// ── Booking curve ────────────────────────────────────────────────────────────

function BookingCurve({ data }: { data: BookingWindowResponse }) {
  const pooled = data.curves.find((c) => c.month === 'all');
  const monthly = data.curves.filter((c) => c.month !== 'all');
  const [showMonths, setShowMonths] = useState(false);

  if (!pooled && monthly.length === 0) {
    return (
      <Card title="Booking curve">
        <Empty message="Not enough booking history to reconstruct a curve." />
      </Card>
    );
  }

  const base = pooled ?? monthly[monthly.length - 1];

  // One row per checkpoint, with a column per series, so Recharts can draw them
  // together on a shared reversed x-axis.
  const checkpoints = [...new Set(base.points.map((p) => p.daysBefore))].sort((a, b) => b - a);
  const chartData = checkpoints.map((daysBefore) => {
    const row: Record<string, number | string> = { daysBefore };
    const p = base.points.find((x) => x.daysBefore === daysBefore);
    row.Pooled = p ? Math.round(p.cumulativeShare * 100) : 0;
    if (showMonths) {
      for (const series of monthly) {
        const q = series.points.find((x) => x.daysBefore === daysBefore);
        row[monthShort(series.month)] = q ? Math.round(q.cumulativeShare * 100) : 0;
      }
    }
    return row;
  });

  const at = (d: number) => base.points.find((p) => p.daysBefore === d)?.cumulativeShare ?? 0;
  // `checkpoints` is DESCENDING, so the first checkpoint at or above 50% is the
  // furthest-out moment the month was already half sold. Scanning ascending
  // instead would always return 0 (the month is ~100% sold on its first day),
  // which is true and useless.
  const halfwayPoint = checkpoints.find((d) => at(d) >= 0.5);

  return (
    <Card
      title="Booking curve"
      subtitle={
        <>
          Share of a month&apos;s final booked nights already on the books, by days before the month
          began. Reconstructed from each booking&apos;s creation and cancellation timestamps, so it
          covers the whole trading history without any snapshot table — a booking that was later
          modified is replayed in its final shape, which is the one approximation here.
        </>
      }
      actions={
        monthly.length > 1 && (
          <button
            onClick={() => setShowMonths((v) => !v)}
            className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
              showMonths
                ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
            }`}
          >
            {showMonths ? 'Pooled only' : 'Show each month'}
          </button>
        )
      }
    >
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Tile label="Sold 60 days out" value={pct(at(60), 0)} hint="of the month's eventual nights" />
        <Tile label="Sold 30 days out" value={pct(at(30), 0)} tone="sky" />
        <Tile label="Sold 7 days out" value={pct(at(7), 0)} tone="amber" />
        <Tile
          label="Halfway point"
          tone="indigo"
          value={halfwayPoint == null ? '—' : `${halfwayPoint} d out`}
          hint="When half the month is sold — the last moment price still moves volume"
        />
      </div>

      <div style={{ height: 300 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
            <CartesianGrid stroke={GRID_STROKE} />
            <XAxis
              dataKey="daysBefore"
              reversed
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(v) => `${v}d`}
              tick={AXIS_TICK_DARK}
              axisLine={false}
              tickLine={false}
              label={{
                value: 'days before the stay month begins',
                position: 'insideBottom',
                offset: -2,
                fontSize: 11,
                fill: '#9CA3AF',
              }}
            />
            <YAxis
              domain={[0, 100]}
              tickFormatter={(v) => `${v}%`}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={44}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              labelFormatter={(v) => `${v} days out`}
              formatter={(value, name) => [`${value} % sold`, name]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <ReferenceLine y={50} stroke="#D1D5DB" strokeDasharray="4 3" />
            {showMonths &&
              monthly.map((series, i) => (
                <Line
                  key={series.month}
                  type="monotone"
                  dataKey={monthShort(series.month)}
                  stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                  strokeWidth={1.5}
                  strokeDasharray={series.inProgress ? '4 3' : undefined}
                  dot={false}
                />
              ))}
            <Line
              type="monotone"
              dataKey="Pooled"
              stroke="#4338CA"
              strokeWidth={3}
              dot={{ r: 3 }}
              name={pooled ? 'All complete months' : monthShort(base.month)}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <p className="text-[11px] text-gray-400 mt-3">
        {pooled
          ? `Pooled across ${monthly.filter((m) => !m.inProgress).length} complete months (${num(pooled.finalNights)} nights). Dashed month lines are still selling.`
          : 'Single month shown — pooling needs at least two completed months.'}
      </p>
    </Card>
  );
}

// ── Lead-time distribution ───────────────────────────────────────────────────

function LeadTimeDistribution({ data }: { data: BookingWindowResponse }) {
  const rows = data.leadTime.filter((b) => b.bookings > 0);
  if (rows.length === 0) return null;

  const chartData = rows.map((b) => ({
    bucket: b.label,
    Bookings: b.bookings,
    'Cancellation rate': Math.round(b.cancellationRate * 100),
    ADR: Math.round(b.adr),
  }));

  const riskiest = rows.reduce((a, b) => (b.cancellationRate > a.cancellationRate ? b : a));
  const safest = rows.reduce((a, b) => (b.cancellationRate < a.cancellationRate ? b : a));

  return (
    <Card
      title="How far ahead people book"
      subtitle={
        <>
          Bars are booking volume; the line is how often that bucket cancels. The pattern is the
          useful part — bookings made <strong>{riskiest.label.toLowerCase()}</strong> ahead cancel{' '}
          {pct(riskiest.cancellationRate, 0)} of the time against {pct(safest.cancellationRate, 0)} for{' '}
          <strong>{safest.label.toLowerCase()}</strong>, so long-lead demand is worth materially less
          per night than its face value.
        </>
      }
    >
      <div style={{ height: 280 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="bucket" tick={{ ...AXIS_TICK_DARK, fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis yAxisId="count" tick={AXIS_TICK} axisLine={false} tickLine={false} width={36} />
            <YAxis
              yAxisId="rate"
              orientation="right"
              domain={[0, 100]}
              tickFormatter={(v) => `${v}%`}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={44}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value, name) =>
                name === 'Cancellation rate'
                  ? [`${value} %`, name]
                  : name === 'ADR'
                    ? [czk(Number(value)), name]
                    : [num(Number(value)), name]
              }
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar yAxisId="count" dataKey="Bookings" fill="#818CF8" radius={[5, 5, 0, 0]} maxBarSize={48} />
            <Line
              yAxisId="rate"
              type="monotone"
              dataKey="Cancellation rate"
              stroke="#F43F5E"
              strokeWidth={2}
              dot={{ r: 3 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="border-t border-gray-100 pt-4 mt-4">
        <Table columns={['Booked', 'Bookings', 'Share', 'Nights', 'ADR', 'Cancellation rate']}>
          {rows.map((b) => (
            <tr key={b.label} className="hover:bg-gray-50">
              <Td align="left">
                <span className="font-medium text-gray-800">{b.label}</span>
              </Td>
              <Td>{num(b.bookings)}</Td>
              <Td>{pct(b.share, 0)}</Td>
              <Td>{num(b.nights)}</Td>
              <Td>{b.nights > 0 ? czk(b.adr) : '—'}</Td>
              <Td className={b.cancellationRate > 0.3 ? '!text-rose-600 font-semibold' : ''}>
                {pct(b.cancellationRate, 0)}
              </Td>
            </tr>
          ))}
        </Table>
      </div>
    </Card>
  );
}

// ── Trend ────────────────────────────────────────────────────────────────────

function LeadTimeTrend({ data }: { data: BookingWindowResponse }) {
  const rows = data.trend;
  if (rows.length < 2) return null;

  const chartData = rows.map((r) => ({
    month: monthShort(r.month),
    Median: Math.round(r.medianLeadDays),
    Mean: Math.round(r.avgLeadDays),
    'P90': Math.round(r.p90LeadDays),
    Bookings: r.bookings,
  }));

  const first = rows[0];
  const last = rows[rows.length - 1];
  const direction =
    last.medianLeadDays > first.medianLeadDays + 1
      ? 'lengthening'
      : last.medianLeadDays < first.medianLeadDays - 1
        ? 'shortening'
        : 'flat';

  return (
    <Card
      title="Is the booking window moving?"
      subtitle={
        <>
          Grouped by the month the booking was MADE, across the whole history rather than the selected
          stay window — production over time is the question. The median window is currently{' '}
          <strong>{direction}</strong>: {days(first.medianLeadDays)} in {monthShort(first.month)} against{' '}
          {days(last.medianLeadDays)} in {monthShort(last.month)}. Median and P90 together matter: a flat
          median with a rising P90 means a growing early-booking tail, not a change in typical behaviour.
        </>
      }
    >
      <div style={{ height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="month" tick={AXIS_TICK_DARK} axisLine={false} tickLine={false} />
            <YAxis
              yAxisId="days"
              tickFormatter={(v) => `${v}d`}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={40}
            />
            <YAxis yAxisId="count" orientation="right" tick={AXIS_TICK} axisLine={false} tickLine={false} width={36} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value, name) => (name === 'Bookings' ? [num(Number(value)), name] : [`${value} days`, name])}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar yAxisId="count" dataKey="Bookings" fill="#E0E7FF" radius={[4, 4, 0, 0]} maxBarSize={40} />
            <Line yAxisId="days" type="monotone" dataKey="P90" stroke="#C7D2FE" strokeWidth={2} dot={{ r: 2 }} />
            <Line yAxisId="days" type="monotone" dataKey="Mean" stroke="#F59E0B" strokeWidth={2} dot={{ r: 3 }} />
            <Line yAxisId="days" type="monotone" dataKey="Median" stroke="#4338CA" strokeWidth={2.5} dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

// ── By dimension ─────────────────────────────────────────────────────────────

function LeadTimeByDimension({ data }: { data: BookingWindowResponse }) {
  const [dimension, setDimension] = useState<'channel' | 'room' | 'month'>('channel');

  const rows = useMemo(() => {
    if (dimension === 'channel')
      return data.byChannel.map((r) => ({
        key: r.channel,
        colour: CHANNEL_COLORS[r.channel] ?? CHANNEL_COLOR_FALLBACK,
        ...r,
      }));
    if (dimension === 'room')
      return data.byRoom.map((r) => ({ key: r.room, colour: ROOM_COLORS[r.room] ?? '#6366F1', ...r }));
    return data.byStayMonth.map((r, i) => ({
      key: monthShort(r.month),
      colour: SERIES_COLORS[i % SERIES_COLORS.length],
      ...r,
    }));
  }, [data, dimension]);

  if (rows.length === 0) return null;

  const LABELS = { channel: 'Channel', room: 'Room', month: 'Stay month' } as const;

  return (
    <Card
      title="Booking window by segment"
      subtitle="Median is the honest central figure; the mean is dragged up by the long-lead tail, so a wide gap between them means the segment has two distinct booking behaviours rather than one."
      actions={
        <div className="flex gap-1">
          {(Object.keys(LABELS) as (keyof typeof LABELS)[]).map((d) => (
            <button
              key={d}
              onClick={() => setDimension(d)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                dimension === d
                  ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                  : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
              }`}
            >
              {LABELS[d]}
            </button>
          ))}
        </div>
      }
    >
      <div style={{ height: 220 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows.map((r) => ({ key: r.key, Median: Math.round(r.medianLeadDays), colour: r.colour }))}
            barCategoryGap="28%"
            margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
          >
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="key" tick={{ ...AXIS_TICK_DARK, fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={(v) => `${v}d`} tick={AXIS_TICK} axisLine={false} tickLine={false} width={40} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              cursor={{ fill: '#F9FAFB' }}
              formatter={(value) => [`${value} days`, 'Median window']}
            />
            <Bar dataKey="Median" fill="#6366F1" radius={[5, 5, 0, 0]}>
              {rows.map((r) => (
                <Cell key={r.key} fill={r.colour} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="border-t border-gray-100 pt-4 mt-4">
        <Table columns={[LABELS[dimension], 'Bookings', 'Median window', 'Mean window', 'Mean − median']}>
          {rows.map((r) => (
            <tr key={r.key} className="hover:bg-gray-50">
              <Td align="left">
                <span className="inline-flex items-center gap-2">
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: r.colour }}
                  />
                  <span className="font-medium text-gray-800">{r.key}</span>
                </span>
              </Td>
              <Td>{num(r.bookings)}</Td>
              <Td bold>{days(r.medianLeadDays)}</Td>
              <Td>{days(r.avgLeadDays)}</Td>
              <Td muted>{days(r.avgLeadDays - r.medianLeadDays)}</Td>
            </tr>
          ))}
        </Table>
      </div>
    </Card>
  );
}

// ── Cancellations ────────────────────────────────────────────────────────────

function Cancellations({ data }: { data: BookingWindowResponse }) {
  const c = data.cancellations;
  const recoveryRate = c.cancelledNights > 0 ? c.recoveredNights / c.cancelledNights : null;

  return (
    <Card
      title="Cancellations"
      subtitle={
        <>
          Abandoned checkouts — cancelled within two hours of being created — are counted separately
          and excluded here, because averaging a never-completed Stripe session together with a guest
          changing their plans destroys both signals. Recovery is what a cancellation actually cost: a
          freed night that was re-sold cost nothing but attention.
        </>
      }
    >
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Tile
          label="Guest cancellations"
          tone={c.cancellationRate > 0.15 ? 'rose' : 'slate'}
          value={`${num(c.cancelledBookings)} of ${num(c.totalBookings)}`}
          hint={pct(c.cancellationRate, 1)}
        />
        <Tile label="Value cancelled" value={czk(c.cancelledGbv)} hint="Gross value of cancelled nights" />
        <Tile
          label="Nights re-sold"
          tone={recoveryRate != null && recoveryRate > 0.6 ? 'emerald' : 'amber'}
          value={recoveryRate == null ? '—' : pct(recoveryRate, 0)}
          hint={`${num(c.recoveredNights)} of ${num(c.cancelledNights)} freed room-nights sold again`}
        />
        <Tile
          label="Typical warning"
          value={c.avgDaysBeforeArrival == null ? '—' : days(c.avgDaysBeforeArrival)}
          hint="Average notice before arrival"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-3">
            By channel
          </p>
          {c.byChannel.filter((r) => r.bookings > 0).length === 0 ? (
            <Empty />
          ) : (
            <Table columns={['Channel', 'Bookings', 'Cancelled', 'Rate', 'Notice']}>
              {c.byChannel
                .filter((r) => r.bookings > 0)
                .map((r) => (
                  <tr key={r.channel} className="hover:bg-gray-50">
                    <Td align="left">
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: CHANNEL_COLORS[r.channel] ?? CHANNEL_COLOR_FALLBACK }}
                        />
                        <span className="font-medium text-gray-800">{r.channel}</span>
                      </span>
                    </Td>
                    <Td>{num(r.bookings)}</Td>
                    <Td>{num(r.cancelled)}</Td>
                    <Td bold className={r.rate > 0.2 ? '!text-rose-600' : ''}>
                      {pct(r.rate, 0)}
                    </Td>
                    <Td muted>{r.avgDaysBeforeArrival == null ? '—' : days(r.avgDaysBeforeArrival)}</Td>
                  </tr>
                ))}
            </Table>
          )}
        </div>

        <div>
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-3">
            How much notice
          </p>
          {c.survivalBuckets.length === 0 ? (
            <Empty message="No guest cancellations in this period." />
          ) : (
            <div className="space-y-3">
              {c.survivalBuckets.map((b) => (
                <div key={b.label}>
                  <div className="flex items-baseline justify-between text-sm mb-1">
                    <span className="text-gray-700">{b.label}</span>
                    <span className="text-gray-500">
                      <span className="font-semibold text-gray-800">{num(b.cancelled)}</span>{' '}
                      <span className="text-[11px] text-gray-400">{pct(b.share, 0)}</span>
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        b.label.includes('arrival') ? 'bg-rose-500' : 'bg-amber-400'
                      }`}
                      style={{ width: `${b.share * 100}%` }}
                    />
                  </div>
                </div>
              ))}
              <p className="text-[11px] text-gray-400 pt-1">
                Late cancellations are the expensive ones — there is no time left to re-sell the night.
              </p>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ── Booking clock ────────────────────────────────────────────────────────────

function BookingClock({ data }: { data: BookingWindowResponse }) {
  const cells = data.bookingHeat;
  if (cells.length === 0) return null;

  const byKey = new Map(cells.map((c) => [`${c.isoDow}|${c.hour}`, c.bookings]));
  const max = Math.max(...cells.map((c) => c.bookings), 1);
  const total = cells.reduce((acc, c) => acc + c.bookings, 0);

  // Which hours actually see traffic — no point rendering 24 dead columns.
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const byHour = hours.map((h) => cells.filter((c) => c.hour === h).reduce((a, c) => a + c.bookings, 0));
  const peakHour = byHour.indexOf(Math.max(...byHour));
  const eveningShare =
    byHour.slice(18).reduce((a, v) => a + v, 0) / Math.max(total, 1);

  return (
    <Card
      title="When bookings arrive"
      subtitle={
        <>
          Booking timestamps in Europe/Prague, not UTC — the point is when a person was at their
          keyboard, and a two-hour offset would move the peak into the wrong evening.{' '}
          {pct(eveningShare, 0)} of bookings land after 18:00, peaking at {peakHour}:00. Relevant to
          when a rate change is worth making, and when a reply is worth being awake for.
        </>
      }
    >
      <div className="overflow-x-auto -mx-2 px-2">
        <table className="border-separate" style={{ borderSpacing: '2px' }}>
          <thead>
            <tr>
              <th className="w-10" />
              {hours.map((h) => (
                <th
                  key={h}
                  className="text-[9px] font-medium text-gray-400 tabular-nums"
                  style={{ minWidth: 22 }}
                >
                  {h % 3 === 0 ? h : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[1, 2, 3, 4, 5, 6, 7].map((dow) => (
              <tr key={dow}>
                <td className="text-[11px] font-medium text-gray-600 pr-2 whitespace-nowrap">
                  {ISO_DOW_LABELS[dow - 1]}
                </td>
                {hours.map((h) => {
                  const value = byKey.get(`${dow}|${h}`) ?? 0;
                  return (
                    <td key={h}>
                      <div
                        className="h-5 rounded-sm"
                        style={
                          value === 0
                            ? { backgroundColor: '#F9FAFB' }
                            : heatStyle(value / max, 'emerald')
                        }
                        title={`${ISO_DOW_LABELS[dow - 1]} ${String(h).padStart(2, '0')}:00 — ${value} booking${value === 1 ? '' : 's'}`}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-gray-400 mt-3">
        Darker = more bookings created in that hour. {num(total)} bookings plotted.
      </p>
    </Card>
  );
}

// ── Our booking window against the market's ──────────────────────────────────

/**
 * How far ahead we sell, against how far ahead the Brno comp set sells.
 *
 * ONE COMPARISON HAS TO BE MADE CAREFULLY. PriceLabs publishes a MEAN booking window
 * for the comp set; it does not publish a median. Our own distribution is heavily
 * skewed — a large last-minute mass with a thin tail of very early bookings — so our
 * mean and our median say different things, and comparing our median to their mean
 * would manufacture a gap that is mostly a statistic mismatch.
 *
 * Both of ours are therefore shown, with the mean-to-mean comparison called out as
 * the like-for-like one. The MPI curve on the Occupancy tab is the sturdier read on
 * whether early demand is being captured, because it compares filled calendar
 * against filled calendar rather than one summary statistic against another.
 */
function MarketWindow({
  data,
  market,
}: {
  data: BookingWindowResponse;
  market: MarketResponse | null;
}) {
  const window = market?.bookingWindow;
  if (!window || window.marketAvgDays === null) return null;

  const ourMean = data.summary.avgLeadDays;
  const ourMedian = data.summary.medianLeadDays;
  const marketMean = window.marketAvgDays;
  const meanGap = marketMean > 0 ? ourMean / marketMean - 1 : null;

  const chartData = [
    { label: 'Our median', days: Math.round(ourMedian * 10) / 10, kind: 'ours' },
    { label: 'Our mean', days: Math.round(ourMean * 10) / 10, kind: 'ours' },
    { label: 'Market mean', days: Math.round(marketMean * 10) / 10, kind: 'market' },
  ];

  return (
    <Card
      title="How far ahead we sell, against the market"
      subtitle={
        <>
          The comp set&apos;s mean booking window comes from PriceLabs. Ours is shown as both mean
          and median because the two differ a lot: most bookings arrive within a week, and a
          handful of very early ones pull the mean up.
        </>
      }
    >
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        <Tile
          label="Our median lead"
          tone="indigo"
          value={`${num(ourMedian, 0)} d`}
          hint="the typical booking"
        />
        <Tile
          label="Our mean lead"
          tone="sky"
          value={`${num(ourMean, 1)} d`}
          hint="pulled up by a few early bookings"
        />
        <Tile
          label="Market mean lead"
          tone="slate"
          value={`${num(marketMean, 1)} d`}
          hint={
            meanGap === null
              ? undefined
              : `we are ${meanGap >= 0 ? 'ahead by' : 'behind by'} ${num(Math.abs(meanGap) * 100, 0)} % on a mean-to-mean basis`
          }
        />
      </div>

      <div style={{ height: 190 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} layout="vertical" margin={{ top: 8, right: 24, left: 8, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} horizontal={false} />
            <XAxis
              type="number"
              tickFormatter={(v) => `${v} d`}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="label"
              tick={AXIS_TICK_DARK}
              axisLine={false}
              tickLine={false}
              width={96}
            />
            <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value) => [`${value} days`, 'Lead time']} />
            <Bar dataKey="days" radius={[0, 5, 5, 0]} maxBarSize={26} fill="#6366F1">
              {chartData.map((d) => (
                <Cell key={d.label} fill={d.kind === 'market' ? '#CBD5E1' : '#6366F1'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <Callout tone="slate" title="What to take from this">
        On a mean-to-mean basis we are roughly level with the market, so the old shorthand that
        &quot;the market books three times further ahead&quot; is not supported — that compared our
        median to their mean. The real asymmetry is in the shape: our book is far more
        last-minute-heavy than the market&apos;s, which the forward MPI curve on the Occupancy tab
        shows more honestly. Combined with the cancellation rates below — long-lead bookings cancel
        several times more often than last-minute ones — a late-filling book is not automatically the
        weaker position.
      </Callout>
    </Card>
  );
}

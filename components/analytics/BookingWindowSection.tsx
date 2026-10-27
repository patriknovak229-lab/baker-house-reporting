'use client';
/**
 * Booking windows — organised by the six questions the operator asked, in order,
 * and always split 1KK (studios) / 2KK (two-bedroom apartments):
 *
 *   1. What is the relationship between booking window and gross profit?
 *   2. Are we selling enough in advance, and where are we behind the market?
 *   3. Do we make more money selling further ahead?   (answered inside 1 + 2)
 *   4. Do far-out bookings cancel more, and do we re-sell — at what price?
 *   5. Which channels work, and how far ahead does each sell?
 *   6. When do bookings arrive — when should each month's promo be live?
 *
 * The yardstick throughout is gross profit per night (net of commission, payment
 * fees and the stay's turnover cost), not volume or gross ADR: a last-minute
 * night can fill a room and still be the least profitable one sold.
 */
import { useMemo, useState } from 'react';
import {
  Bar,
  CartesianGrid,
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
import type {
  BookingWindowBandRow,
  BookingWindowClassBlock,
  BookingWindowResponse,
  MarketResponse,
} from '@/utils/analyticsTypes';
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
  monthLabel,
  monthShort,
  num,
  pct,
  Table,
  Td,
  Tile,
  TOOLTIP_STYLE,
} from './kit';

type ClassKey = '1kk' | '2kk' | 'all';

/** Class hues: studios take the cool Urban family, apartments the warm K.201 one. */
const CLASS_COLORS: Record<ClassKey, string> = {
  '1kk': '#0EA5E9',
  '2kk': '#F59E0B',
  all: '#6366F1',
};

const MARKET_COLOR = '#94A3B8';
const HISTORY_COLOR = '#C7D2FE';

const ISO_DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** A band's GP figure is shown, but not judged, below this many nights. */
const MIN_BAND_NIGHTS = 15;

export default function BookingWindowSection({
  data,
}: {
  data: BookingWindowResponse;
  /** Kept for the shared section signature; the market comparison here is
   *  computed server-side per class from the same PriceLabs snapshot. */
  market?: MarketResponse | null;
}) {
  const one = data.classes.find((c) => c.classId === '1kk');
  const two = data.classes.find((c) => c.classId === '2kk');
  const all = data.classes.find((c) => c.classId === 'all');

  if (!all || all.summary.bookings + all.summary.nights === 0) {
    return <Empty message="No bookings arrive in this period." />;
  }

  const pair = [one, two].filter((c): c is BookingWindowClassBlock => !!c && c.rooms.length > 0);

  return (
    <>
      <Callout tone="slate" title="How to read this tab">
        Everything is split <strong>1KK</strong> (studios K.102, K.103, K.106, K.202, K.203) and{' '}
        <strong>2KK</strong> (K.201, O.308). The yardstick is <strong>gross profit per night</strong>: gross
        minus OTA commission, payment fees and the stay&apos;s turnover cost (cleaning, laundry,
        consumables). Monthly fixed costs (parking, subscriptions) and wear &amp; tear incidents don&apos;t
        depend on when a night was booked, so they are left out — which is why GP here reads slightly
        higher than on the Occupancy tab. Money and nights are counted on the <strong>stay</strong> basis (nights
        inside the period); cancellation rates and booking-window statistics on the{' '}
        <strong>booked</strong> basis (bookings arriving inside the period).
      </Callout>

      {data.notes.map((note) => (
        <Callout key={note} tone="amber">
          {note}
        </Callout>
      ))}

      <CapacityCheck data={data} />
      <Answers data={data} classes={pair} all={all} />
      <WindowProfit classes={pair} all={all} />
      <SellingAhead classes={pair} all={all} />
      <MarketGaps data={data} classes={pair} />
      <Cancellations classes={pair} all={all} />
      <Channels classes={pair} all={all} />
      <PromoCalendar data={data} classes={pair} />
      <WhenBookingsArrive classes={pair} all={all} />
    </>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────────

function ClassToggle({
  value,
  onChange,
  options,
}: {
  value: ClassKey;
  onChange: (value: ClassKey) => void;
  options: BookingWindowClassBlock[];
}) {
  return (
    <div className="flex gap-1">
      {options.map((c) => (
        <button
          key={c.classId}
          onClick={() => onChange(c.classId)}
          className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
            value === c.classId
              ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
              : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
          }`}
        >
          <span
            className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
            style={{ backgroundColor: CLASS_COLORS[c.classId] }}
          />
          {c.label}
        </button>
      ))}
    </div>
  );
}

function ClassDot({ classId }: { classId: ClassKey }) {
  return (
    <span
      className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
      style={{ backgroundColor: CLASS_COLORS[classId] }}
    />
  );
}

function ClassName({ block }: { block: BookingWindowClassBlock }) {
  return (
    <span className="inline-flex items-center gap-2">
      <ClassDot classId={block.classId} />
      <span className="font-medium text-gray-800">{block.label}</span>
    </span>
  );
}

const pctOrDash = (v: number | null | undefined, digits = 0) => (v == null ? '—' : pct(v, digits));
const czkOrDash = (v: number | null | undefined) => (v == null ? '—' : czk(v));
const dateShort = (iso: string | null) => {
  if (!iso) return '—';
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]}`;
};

/** Pooled GP per night and seasonality index across several bands. */
function pooledBands(bands: BookingWindowBandRow[], ids: string[]) {
  const picked = bands.filter((b) => ids.includes(b.id) && b.nights > 0);
  const nights = picked.reduce((a, b) => a + b.nights, 0);
  const gp = picked.reduce((a, b) => a + b.grossProfit, 0);
  const expected = picked.reduce((a, b) => a + (b.gpIndex && b.gpIndex > 0 ? b.grossProfit / b.gpIndex : 0), 0);
  return {
    nights,
    gpPerNight: nights > 0 ? gp / nights : null,
    index: expected > 0 ? gp / expected : null,
  };
}

function indexTone(index: number | null): string {
  if (index == null) return '';
  if (index >= 1.05) return '!text-emerald-600 font-semibold';
  if (index <= 0.95) return '!text-rose-600 font-semibold';
  return '';
}

function indexLabel(index: number | null): string {
  if (index == null) return '—';
  const delta = index - 1;
  if (Math.abs(delta) < 0.005) return 'avg';
  return `${delta > 0 ? '+' : '−'}${num(Math.abs(delta) * 100, 0)} %`;
}

// ── Capacity check ───────────────────────────────────────────────────────────

/**
 * The denominator, shown before anything is divided by it. All seven units ×
 * days is ~210 sellable nights a month; anything less is a unit that was not yet
 * online (the portfolio opened in stages) or a blackout, and is named here
 * rather than silently shrinking every occupancy figure.
 */
function CapacityCheck({ data }: { data: BookingWindowResponse }) {
  const [open, setOpen] = useState(false);
  const rows = data.capacity;
  if (rows.length === 0) return null;
  const full = rows.filter((r) => r.total === r.fullCapacity).length;
  const short = rows.filter((r) => r.total < r.fullCapacity);

  return (
    <Card
      title="Sellable nights — the denominator"
      subtitle={
        <>
          Seven units × the days in the month: 217 nights in a 31-day month, 210 in a 30-day one (1KK 5 ×
          days, 2KK 2 × days). {full} of {rows.length} months in the period carry all seven units.
          {short.length > 0 && (
            <>
              {' '}
              The rest are short because the units opened in stages — Deluxe studios Dec 2025, K.201 Mar
              2026, Urban studios late May, O.308 mid-June — or because of blackout nights; those nights
              were never on sale and are left out of every rate on this tab.
            </>
          )}
        </>
      }
      actions={
        <button
          onClick={() => setOpen((v) => !v)}
          className="px-2.5 py-1 rounded-md text-xs font-medium border bg-white border-gray-200 text-gray-500 hover:bg-gray-50"
        >
          {open ? 'Hide months' : 'Show months'}
        </button>
      }
    >
      <div className="flex flex-wrap gap-2">
        {rows.map((r) => {
          const ok = r.total === r.fullCapacity;
          return (
            <div
              key={r.month}
              className={`rounded-lg px-2.5 py-1.5 text-[11px] border ${
                ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'
              }`}
              title={`1KK ${r.oneKk} + 2KK ${r.twoKk} = ${r.total} of ${r.fullCapacity} possible (${r.days} days)`}
            >
              <span className="font-semibold">{monthShort(r.month)}</span> {num(r.total)}
              <span className="opacity-60">/{num(r.fullCapacity)}</span>
            </div>
          );
        })}
      </div>
      {open && (
        <div className="border-t border-gray-100 pt-4 mt-4">
          <Table columns={['Month', 'Days', '1KK', '2KK', 'Total', '7 units × days', 'Covered']}>
            {rows.map((r) => (
              <tr key={r.month} className="hover:bg-gray-50">
                <Td align="left">{monthLabel(r.month)}</Td>
                <Td muted>{r.days}</Td>
                <Td>{num(r.oneKk)}</Td>
                <Td>{num(r.twoKk)}</Td>
                <Td bold>{num(r.total)}</Td>
                <Td muted>{num(r.fullCapacity)}</Td>
                <Td className={r.total < r.fullCapacity ? '!text-amber-600' : '!text-emerald-600'}>
                  {pct(r.total / Math.max(r.fullCapacity, 1), 0)}
                </Td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </Card>
  );
}

// ── The answers, up front ────────────────────────────────────────────────────

function takeaways(c: BookingWindowClassBlock): string[] {
  const out: string[] = [];
  const near = pooledBands(c.bands, ['0-3']);
  const mid = pooledBands(c.bands, ['8-14', '15-29', '30-59']);
  if (near.gpPerNight != null && mid.gpPerNight != null && near.nights >= MIN_BAND_NIGHTS && mid.nights >= MIN_BAND_NIGHTS) {
    out.push(
      `Nights booked 8–59 days out earn ${czk(mid.gpPerNight)} gross profit a night (${indexLabel(mid.index)} vs the same months' average); nights booked 0–3 days out earn ${czk(near.gpPerNight)} (${indexLabel(near.index)}). ${pct(near.nights / Math.max(c.summary.nights, 1), 0)} of nights are still sold in that last-minute window.`,
    );
  }
  const s = c.summary;
  if (s.otbAt30 != null && s.otbAt7 != null && s.finalOccupancy != null && s.finalOccupancy > 0) {
    out.push(
      `A typical night has ${pct(s.otbAt30, 0)} of capacity on the books 30 days out, ${pct(s.otbAt7, 0)} a week out, and ends at ${pct(s.finalOccupancy, 0)} — ${pct((s.finalOccupancy - s.otbAt7) / s.finalOccupancy, 0)} of the final occupancy is sold in the last week.`,
    );
  }
  const worst = c.forward
    .filter((f) => f.marketOccupancy != null && f.availableNights > 0 && f.minDays >= 15)
    .map((f) => ({ f, gap: f.occupancy - (f.marketOccupancy as number) }))
    .sort((a, b) => a.gap - b.gap)[0];
  if (worst && worst.gap < -0.08) {
    out.push(
      `Biggest gap to the market today: nights ${worst.f.label} out — ${pct(worst.f.occupancy, 0)} on the books against the comp set's ${pct(worst.f.marketOccupancy as number, 0)}${
        worst.f.historyOccupancy != null ? ` and our own usual ${pct(worst.f.historyOccupancy, 0)}` : ''
      }.`,
    );
  }
  const far = pooledBands(c.bands, ['60-89', '90+']);
  const farBand = c.bands.filter((b) => b.id === '60-89' || b.id === '90+');
  const farBooked = farBand.reduce((a, b) => a + b.bookedBookings, 0);
  const farCancelled = farBand.reduce((a, b) => a + b.cancelledBookings, 0);
  if (farBooked >= 5) {
    out.push(
      `Bookings made 60+ days out cancel ${pct(farCancelled / farBooked, 0)} of the time (${farCancelled} of ${farBooked}) against ${pct(c.summary.cancellationRate, 0)} overall${
        c.cancellations.resaleRate != null ? `; ${pct(c.cancellations.resaleRate, 0)} of cancelled nights were re-sold` : ''
      }${far.gpPerNight != null ? `. The ones that stay earn ${czk(far.gpPerNight)} a night` : ''}.`,
    );
  }
  return out;
}

function Answers({
  data,
  classes,
  all,
}: {
  data: BookingWindowResponse;
  classes: BookingWindowClassBlock[];
  all: BookingWindowClassBlock;
}) {
  const cols = [...classes, all];
  const rows: { label: string; hint?: string; value: (c: BookingWindowClassBlock) => string }[] = [
    {
      label: 'Booking window — median / mean',
      hint: 'days between booking and arrival',
      value: (c) => `${days(c.summary.medianLeadDays)} / ${days(c.summary.avgLeadDays)}`,
    },
    {
      label: 'Mean window vs market',
      hint: 'same months, mean to mean (PriceLabs comp set)',
      value: (c) =>
        c.summary.marketAvgLeadDays == null || c.summary.ourAvgLeadVsMarket == null
          ? '—'
          : `${days(c.summary.ourAvgLeadVsMarket)} vs ${days(c.summary.marketAvgLeadDays)}`,
    },
    {
      label: 'Nights booked ≤7 d / ≥15 d / ≥30 d ahead',
      value: (c) => `${pct(c.summary.shareWithin7, 0)} / ${pct(c.summary.share15Plus, 0)} / ${pct(c.summary.share30Plus, 0)}`,
    },
    {
      label: 'GP per night — booked ≤7 d ahead',
      value: (c) => czkOrDash(c.summary.gpWithin7?.gpPerNight),
    },
    {
      label: 'GP per night — booked 8–29 d ahead',
      value: (c) => czkOrDash(c.summary.gp8to29?.gpPerNight),
    },
    {
      label: 'GP per night — booked 30+ d ahead',
      value: (c) => czkOrDash(c.summary.gp30Plus?.gpPerNight),
    },
    {
      label: 'On the books 30 d / 7 d out → final',
      hint: 'share of sellable nights, completed nights',
      value: (c) =>
        `${pctOrDash(c.summary.otbAt30)} / ${pctOrDash(c.summary.otbAt7)} → ${pctOrDash(c.summary.finalOccupancy)}`,
    },
    {
      label: 'Guest cancellation rate',
      hint: 'abandoned checkouts excluded',
      value: (c) => pct(c.summary.cancellationRate, 1),
    },
    {
      label: 'Cancelled nights re-sold',
      value: (c) => pctOrDash(c.summary.resaleRate),
    },
    {
      label: 'Gross profit per sellable night',
      hint: 'GP ÷ every sellable night, sold or not · before wear & tear / misc',
      value: (c) => czk(c.summary.gpPerAvailableNight),
    },
  ];

  return (
    <Card
      title="The answers"
      subtitle={`${monthLabel(data.query.from.slice(0, 7))} – ${monthLabel(data.query.to.slice(0, 7))}. Each figure is explained in the section below it.`}
    >
      <Table columns={['', ...cols.map((c) => c.label)]}>
        {rows.map((r) => (
          <tr key={r.label} className="hover:bg-gray-50">
            <Td align="left">
              <span className="text-gray-700">{r.label}</span>
              {r.hint && <span className="block text-[10px] text-gray-400">{r.hint}</span>}
            </Td>
            {cols.map((c) => (
              <Td key={c.classId} bold={c.classId !== 'all'} muted={c.classId === 'all'}>
                {r.value(c)}
              </Td>
            ))}
          </tr>
        ))}
      </Table>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-6">
        {classes.map((c) => {
          const points = takeaways(c);
          if (points.length === 0) return null;
          return (
            <div key={c.classId} className="rounded-lg border border-gray-100 bg-gray-50 px-4 py-3">
              <p className="text-xs font-semibold text-gray-700 mb-2">
                <ClassName block={c} />
              </p>
              <ul className="space-y-1.5 text-xs text-gray-600 leading-relaxed list-disc pl-4">
                {points.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── 1 + 3. Booking window → gross profit ─────────────────────────────────────

function WindowProfit({
  classes,
  all,
}: {
  classes: BookingWindowClassBlock[];
  all: BookingWindowClassBlock;
}) {
  const [selected, setSelected] = useState<ClassKey>(classes[0]?.classId ?? 'all');
  const block = [...classes, all].find((c) => c.classId === selected) ?? all;

  const chartData = all.bands.map((b) => {
    const row: Record<string, number | string | null> = { band: b.label };
    for (const c of classes) {
      const band = c.bands.find((x) => x.id === b.id);
      row[c.label] = band && band.nights > 0 ? Math.round(band.gpPerNight) : null;
      row[`${c.label} index`] = band?.gpIndex != null && band.nights > 0 ? Math.round(band.gpIndex * 100) : null;
    }
    return row;
  });

  return (
    <Card
      title="1 · Booking window and gross profit"
      subtitle={
        <>
          Bars: gross profit per night by how far ahead the booking was made. Lines: the same against the
          class&apos;s average night <em>in the same stay months</em>{' '}(100 = average) — this strips out
          &quot;early bookings happen to land on strong months&quot;, so what is left is the window itself:
          its rate, its stay length (one turnover spread over more nights) and its channel mix.
        </>
      }
    >
      <div style={{ height: 300 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="band" tick={{ ...AXIS_TICK_DARK, fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis yAxisId="gp" tickFormatter={(v) => num(Number(v))} tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} />
            <YAxis
              yAxisId="idx"
              orientation="right"
              domain={[50, 150]}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={36}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value, name) =>
                String(name).endsWith('index')
                  ? [value == null ? '—' : `${value}`, String(name)]
                  : [value == null ? '—' : czk(Number(value)), `${name} GP / night`]
              }
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <ReferenceLine yAxisId="idx" y={100} stroke="#D1D5DB" strokeDasharray="4 3" />
            {classes.map((c) => (
              <Bar
                key={c.classId}
                yAxisId="gp"
                dataKey={c.label}
                fill={CLASS_COLORS[c.classId]}
                radius={[4, 4, 0, 0]}
                maxBarSize={32}
              />
            ))}
            {classes.map((c) => (
              <Line
                key={`${c.classId}-idx`}
                yAxisId="idx"
                type="monotone"
                dataKey={`${c.label} index`}
                stroke={CLASS_COLORS[c.classId]}
                strokeWidth={2}
                strokeDasharray="5 3"
                dot={{ r: 3 }}
                connectNulls
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="border-t border-gray-100 pt-4 mt-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">By window — {block.label}</p>
          <ClassToggle value={selected} onChange={setSelected} options={[...classes, all]} />
        </div>
        <Table
          columns={[
            'Booked',
            'Nights',
            'Share',
            'Net ADR',
            'Stay',
            'Turnover / night',
            'GP / night',
            'vs same months',
            'Cancelled',
          ]}
        >
          {block.bands
            .filter((b) => b.nights > 0 || b.bookedBookings > 0)
            .map((b) => (
              <tr key={b.id} className="hover:bg-gray-50">
                <Td align="left">
                  <span className="font-medium text-gray-800">{b.label}</span>
                </Td>
                <Td>{num(b.nights)}</Td>
                <Td muted>{pct(b.nightShare, 0)}</Td>
                <Td>{b.nights > 0 ? czk(b.netAdr) : '—'}</Td>
                <Td muted>{b.avgLos > 0 ? `${num(b.avgLos, 1)} n` : '—'}</Td>
                <Td muted>{b.nights > 0 ? czk(b.turnoverPerNight) : '—'}</Td>
                <Td bold>{b.nights > 0 ? czk(b.gpPerNight) : '—'}</Td>
                <Td className={b.nights >= MIN_BAND_NIGHTS ? indexTone(b.gpIndex) : '!text-gray-400'}>
                  {indexLabel(b.gpIndex)}
                </Td>
                <Td className={b.cancellationRate > 0.3 ? '!text-rose-600 font-semibold' : ''}>
                  {b.bookedBookings > 0 ? `${pct(b.cancellationRate, 0)} (${b.cancelledBookings}/${b.bookedBookings})` : '—'}
                </Td>
              </tr>
            ))}
        </Table>
        <p className="text-[11px] text-gray-400 mt-3">
          Stay = average nights per booking. Turnover / night is one checkout&apos;s cleaning, laundry and
          consumables spread over the stay — why short last-minute stays carry the most. Bands under{' '}
          {MIN_BAND_NIGHTS} nights are shown grey: too few to judge.
        </p>
      </div>
    </Card>
  );
}

// ── 2. Are we selling enough in advance? ─────────────────────────────────────

function SellingAhead({
  classes,
  all,
}: {
  classes: BookingWindowClassBlock[];
  all: BookingWindowClassBlock;
}) {
  const [selected, setSelected] = useState<ClassKey>(classes[0]?.classId ?? 'all');
  const block = [...classes, all].find((c) => c.classId === selected) ?? all;

  const checkpoints = all.curve.map((p) => p.daysBefore).filter((d) => d <= 120);
  const chartData = checkpoints.map((d) => {
    const row: Record<string, number | null> = { daysBefore: d };
    for (const c of classes) {
      const p = c.curve.find((x) => x.daysBefore === d);
      row[c.label] = p ? Math.round(p.occupancy * 1000) / 10 : null;
    }
    return row;
  });

  return (
    <Card
      title="2 · Are we selling enough in advance?"
      subtitle={
        <>
          How full a night already was N days before it — booked by then and not yet cancelled — as a
          share of sellable nights, pooled over every completed night in the period. Reconstructed from
          booking and cancellation timestamps, so it covers the whole history; a booking that was later
          modified is replayed in its final shape.
        </>
      }
    >
      <div style={{ height: 280 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
            <CartesianGrid stroke={GRID_STROKE} />
            <XAxis
              dataKey="daysBefore"
              reversed
              type="number"
              domain={['dataMin', 'dataMax']}
              ticks={[120, 90, 60, 45, 30, 21, 14, 7, 0]}
              tickFormatter={(v) => `${v}d`}
              tick={AXIS_TICK_DARK}
              axisLine={false}
              tickLine={false}
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
              labelFormatter={(v) => `${v} days before the night`}
              formatter={(value, name) => [`${value} % on the books`, String(name)]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <ReferenceLine x={30} stroke="#E5E7EB" strokeDasharray="4 3" />
            <ReferenceLine x={7} stroke="#E5E7EB" strokeDasharray="4 3" />
            {classes.map((c) => (
              <Line
                key={c.classId}
                type="monotone"
                dataKey={c.label}
                stroke={CLASS_COLORS[c.classId]}
                strokeWidth={2.5}
                dot={{ r: 2.5 }}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="border-t border-gray-100 pt-4 mt-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
            Month by month — {block.label}
          </p>
          <ClassToggle value={selected} onChange={setSelected} options={[...classes, all]} />
        </div>
        <Table
          columns={[
            'Stay month',
            'Sellable',
            'On books 60 d',
            '30 d',
            '14 d',
            '7 d',
            'Final',
            'Net ADR',
            'GP / night',
            'GP / sellable night*',
            'Mean window',
            'Market',
          ]}
        >
          {block.months.map((m) => (
            <tr key={m.month} className="hover:bg-gray-50">
              <Td align="left">
                <span className="font-medium text-gray-800">{monthLabel(m.month)}</span>
                {m.inProgress && (
                  <span className="ml-1.5 text-[10px] font-medium text-amber-600 bg-amber-50 rounded px-1 py-0.5">
                    partial
                  </span>
                )}
              </Td>
              <Td muted>{num(m.availableNights)}</Td>
              <Td>{pctOrDash(m.otb60)}</Td>
              <Td>{pctOrDash(m.otb30)}</Td>
              <Td>{pctOrDash(m.otb14)}</Td>
              <Td>{pctOrDash(m.otb7)}</Td>
              <Td bold>{pct(m.occupancy, 0)}</Td>
              <Td>{m.soldNights > 0 ? czk(m.netAdr) : '—'}</Td>
              <Td>{m.soldNights > 0 ? czk(m.gpPerNight) : '—'}</Td>
              <Td bold>{czk(m.gpPerAvailableNight)}</Td>
              <Td muted>{m.avgLeadDays == null ? '—' : days(m.avgLeadDays)}</Td>
              <Td muted>{m.marketAvgLeadDays == null ? '—' : days(m.marketAvgLeadDays)}</Td>
            </tr>
          ))}
        </Table>
        <p className="text-[11px] text-gray-400 mt-3">
          &quot;On books&quot; can fall between 30 d and 14 d: that is cancellations outrunning new bookings.
          * GP / sellable night is the month&apos;s gross profit spread over every sellable night — the figure
          that rewards filling a night only when the fill pays. GP here is before wear &amp; tear / misc
          incidents, so it reads slightly above the Occupancy tab. Market = PriceLabs comp set&apos;s mean booking
          window for the month.
        </p>
      </div>
    </Card>
  );
}

// ── 2b. Gaps against the market, today ───────────────────────────────────────

function MarketGaps({ data, classes }: { data: BookingWindowResponse; classes: BookingWindowClassBlock[] }) {
  const hasMarket = classes.some((c) => c.forward.some((f) => f.marketOccupancy != null));

  return (
    <Card
      title="2 · Where we are behind — today's book against the market and our own history"
      subtitle={
        <>
          Every night of the next 180 days, grouped by how far away it is. <strong>Us now</strong>: share of
          sellable nights already sold. <strong>Our usual</strong>: what our own history says should be on the
          books at that distance. <strong>Market</strong>: the PriceLabs comp set&apos;s occupancy for the same
          nights{data.market?.capturedAt ? ` (snapshot ${data.market.capturedAt.slice(0, 10)})` : ''}. All
          channels, whatever the channel filter says — a gap to the market is about total demand.
        </>
      }
    >
      {!hasMarket && (
        <Callout tone="amber">
          No PriceLabs snapshot is available, so only our own history is shown as the benchmark.
        </Callout>
      )}
      <div className={`grid grid-cols-1 ${classes.length > 1 ? 'lg:grid-cols-2' : ''} gap-6 ${hasMarket ? '' : 'mt-4'}`}>
        {classes.map((c) => {
          const chartData = c.forward.map((f) => ({
            band: f.label.replace(' days', ' d'),
            'Us now': Math.round(f.occupancy * 100),
            'Our usual': f.historyOccupancy == null ? null : Math.round(f.historyOccupancy * 100),
            Market: f.marketOccupancy == null ? null : Math.round(f.marketOccupancy * 100),
          }));
          const gaps = c.forward.filter(
            (f) =>
              f.availableNights > 0 &&
              ((f.marketOccupancy != null && f.occupancy - f.marketOccupancy < -0.08) ||
                (f.historyOccupancy != null && f.occupancy - f.historyOccupancy < -0.08)),
          );
          return (
            <div key={c.classId}>
              <p className="text-xs font-semibold text-gray-700 mb-2">
                <ClassName block={c} />
              </p>
              <div style={{ height: 230 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                    <XAxis dataKey="band" interval={0} tick={{ ...AXIS_TICK_DARK, fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis
                      domain={[0, 100]}
                      tickFormatter={(v) => `${v}%`}
                      tick={AXIS_TICK}
                      axisLine={false}
                      tickLine={false}
                      width={40}
                    />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      formatter={(value, name) => [value == null ? '—' : `${value} %`, String(name)]}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="Us now" fill={CLASS_COLORS[c.classId]} radius={[4, 4, 0, 0]} maxBarSize={22} />
                    <Bar dataKey="Our usual" fill={HISTORY_COLOR} radius={[4, 4, 0, 0]} maxBarSize={22} />
                    {hasMarket && (
                      <Line type="monotone" dataKey="Market" stroke={MARKET_COLOR} strokeWidth={2} dot={{ r: 3 }} />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              {gaps.length > 0 ? (
                <ul className="mt-2 space-y-1 text-[11px] text-rose-700">
                  {gaps.map((f) => (
                    <li key={f.label}>
                      <strong>{f.label} out</strong>: {pct(f.occupancy, 0)} sold ({f.onBooks} of{' '}
                      {f.availableNights} nights)
                      {f.historyOccupancy != null && ` · usual ${pct(f.historyOccupancy, 0)}`}
                      {f.marketOccupancy != null && ` · market ${pct(f.marketOccupancy, 0)}`}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-[11px] text-emerald-700">No band more than 8 points behind.</p>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-gray-400 mt-4">
        The comp set is Airbnb + VRBO listings (no Booking.com), and PriceLabs counts host-blocked nights as
        occupied, so far-out market figures read a little high. Treat a gap of a few points as noise and a
        gap of 10+ points — especially against our own usual — as a signal to act on price or promotion for
        those dates.
      </p>
    </Card>
  );
}

// ── 4. Cancellations and resale ──────────────────────────────────────────────

function Cancellations({
  classes,
  all,
}: {
  classes: BookingWindowClassBlock[];
  all: BookingWindowClassBlock;
}) {
  const chartData = all.bands.map((b) => {
    const row: Record<string, number | string | null> = { band: b.label };
    for (const c of classes) {
      const band = c.bands.find((x) => x.id === b.id);
      row[c.label] = band && band.bookedBookings > 0 ? Math.round(band.cancellationRate * 100) : null;
    }
    return row;
  });

  return (
    <Card
      title="4 · Do far-out bookings cancel more — and do we re-sell?"
      subtitle={
        <>
          Guest cancellations only — a checkout abandoned within two hours is not a guest changing plans and
          is excluded from both sides. A cancelled night counts as <strong>re-sold</strong> only if the unit
          still ended up full that night (Urban trio and Deluxe pair are interchangeable); a later booking
          that took a room that was free anyway replaced nothing. Values use the booked rate, recovered from
          Beds24&apos;s per-night rate lines because Beds24 zeroes the price of most cancellations.
        </>
      }
    >
      <div className={`grid grid-cols-1 ${classes.length > 1 ? 'lg:grid-cols-2' : ''} gap-4 mb-6`}>
        {classes.map((c) => {
          const x = c.cancellations;
          return (
            <div key={c.classId} className="rounded-lg border border-gray-100 p-4">
              <p className="text-xs font-semibold text-gray-700 mb-3">
                <ClassName block={c} />
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Tile
                  label="Cancelled"
                  tone={x.cancellationRate > 0.15 ? 'rose' : 'slate'}
                  value={pct(x.cancellationRate, 1)}
                  hint={`${x.cancelledBookings} of ${x.bookedBookings} bookings · ${x.avgNoticeDays == null ? '—' : days(x.avgNoticeDays)} notice`}
                />
                <Tile
                  label="Re-sold"
                  tone={x.resaleRate != null && x.resaleRate >= 0.7 ? 'emerald' : 'amber'}
                  value={pctOrDash(x.resaleRate)}
                  hint={`${x.resoldNights} of ${x.pastCancelledNights} freed nights${x.openNights > 0 ? ` · ${x.openNights} still ahead` : ''}`}
                />
                <Tile
                  label="Re-sale rate vs original"
                  tone="sky"
                  value={x.resalePriceRatio == null ? '—' : pct(x.resalePriceRatio, 0)}
                  hint={x.resaleLeadDays == null ? undefined : `replacement booked ~${days(x.resaleLeadDays)} before the night`}
                />
                <Tile
                  label="Value lost"
                  tone="slate"
                  value={czk(x.lostValue)}
                  hint={`${x.lostNights} nights never re-sold · ${czk(x.cancelledValue)} cancelled in total`}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Cancellation rate by booking window
          </p>
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                <XAxis dataKey="band" interval={0} tick={{ ...AXIS_TICK_DARK, fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis
                  domain={[0, 'auto']}
                  tickFormatter={(v) => `${v}%`}
                  tick={AXIS_TICK}
                  axisLine={false}
                  tickLine={false}
                  width={40}
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(value, name) => [value == null ? '—' : `${value} %`, String(name)]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {classes.map((c) => (
                  <Line
                    key={c.classId}
                    type="monotone"
                    dataKey={c.label}
                    stroke={CLASS_COLORS[c.classId]}
                    strokeWidth={2.5}
                    dot={{ r: 3 }}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div>
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-3">
            How much notice
          </p>
          {all.cancellations.notice.length === 0 ? (
            <Empty message="No guest cancellations in this period." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="py-2 text-left text-[11px] font-medium text-gray-500 uppercase tracking-wide">
                    Cancelled
                  </th>
                  {classes.map((c) => (
                    <th key={c.classId} className="py-2 text-right text-[11px] font-medium text-gray-500 uppercase tracking-wide">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {all.cancellations.notice.map((b) => (
                  <tr key={b.label} className="hover:bg-gray-50">
                    <Td align="left">{b.label}</Td>
                    {classes.map((c) => {
                      const x = c.cancellations.notice.find((y) => y.label === b.label);
                      return (
                        <Td key={c.classId}>
                          {x ? (
                            <>
                              {num(x.cancelled)} <span className="text-[11px] text-gray-400">{pct(x.share, 0)}</span>
                            </>
                          ) : (
                            '—'
                          )}
                        </Td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-[11px] text-gray-400 mt-3">
            Late cancellations are the expensive ones — there is little time left to re-sell. A re-sale rate
            above 100 % of the original usually means a long, discounted stay was cancelled and re-sold as
            short stays at full rate.
          </p>
        </div>
      </div>
    </Card>
  );
}

// ── 5. Channels ──────────────────────────────────────────────────────────────

function Channels({
  classes,
  all,
}: {
  classes: BookingWindowClassBlock[];
  all: BookingWindowClassBlock;
}) {
  const [selected, setSelected] = useState<ClassKey>(classes[0]?.classId ?? 'all');
  const block = [...classes, all].find((c) => c.classId === selected) ?? all;
  const rows = block.channels.filter((r) => r.nights > 0);
  const bands = block.bands.map((b) => ({ id: b.id, label: b.label }));

  return (
    <Card
      title="5 · Channels — what works, and how far ahead each sells"
      subtitle={
        <>
          Gross profit per night is after each channel&apos;s own commission and payment fees, so it is the
          like-for-like comparison; gross ADR is not. Small channels are shown with their booking counts —
          a handful of stays is an anecdote, not a rate.
        </>
      }
      actions={<ClassToggle value={selected} onChange={setSelected} options={[...classes, all]} />}
    >
      {rows.length === 0 ? (
        <Empty />
      ) : (
        <>
          <Table
            columns={[
              'Channel',
              'Bookings',
              'Nights',
              'Share',
              'Gross ADR',
              'GP / night',
              'Stay',
              'Median window',
              'Nights ≥15 d',
              'Cancelled',
            ]}
          >
            {rows.map((r) => (
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
                <Td>{num(r.nights)}</Td>
                <Td muted>{pct(r.nightShare, 0)}</Td>
                <Td>{czk(r.adr)}</Td>
                <Td bold>{czk(r.gpPerNight)}</Td>
                <Td muted>{num(r.avgLos, 1)} n</Td>
                <Td>{r.medianLeadDays == null ? '—' : days(r.medianLeadDays)}</Td>
                <Td>{pct(r.share15Plus, 0)}</Td>
                <Td className={r.cancellationRate > 0.2 && r.bookedBookings >= 10 ? '!text-rose-600 font-semibold' : ''}>
                  {r.bookedBookings > 0 ? `${pct(r.cancellationRate, 0)} (${r.bookedBookings})` : '—'}
                </Td>
              </tr>
            ))}
          </Table>

          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mt-6 mb-3">
            GP per night by channel × booking window — {block.label}
          </p>
          <div className="overflow-x-auto -mx-2 px-2">
            <table className="w-full text-xs min-w-[640px]">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="py-2 text-left text-[11px] font-medium text-gray-500 uppercase tracking-wide">Channel</th>
                  {bands.map((b) => (
                    <th key={b.id} className="py-2 text-right text-[11px] font-medium text-gray-500 whitespace-nowrap">
                      {b.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map((r) => {
                  const values = r.bands.map((b) => b.gpPerNight).filter((v): v is number => v != null);
                  const max = Math.max(...values, 1);
                  return (
                    <tr key={r.channel}>
                      <td className="py-2 text-gray-700 font-medium">{r.channel}</td>
                      {r.bands.map((b) => (
                        <td key={b.id} className="py-1 pl-1">
                          {b.gpPerNight == null ? (
                            <div className="text-right text-gray-300 pr-2">—</div>
                          ) : (
                            <div
                              className="rounded px-2 py-1 text-right tabular-nums"
                              style={heatStyle((b.gpPerNight / max) * (b.nights >= 5 ? 1 : 0.3), 'emerald')}
                              title={`${num(b.nights)} nights`}
                            >
                              {num(Math.round(b.gpPerNight))}
                              <span className="block text-[9px] opacity-70">{b.nights} n</span>
                            </div>
                          )}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-gray-400 mt-3">
            Kč gross profit per night; colour is relative within each row, faded under 5 nights.
          </p>
        </>
      )}
    </Card>
  );
}

// ── 6. Promo calendar ────────────────────────────────────────────────────────

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  ahead: { label: 'Ahead — hold or raise rates', cls: 'bg-emerald-50 text-emerald-700' },
  'on-pace': { label: 'On pace', cls: 'bg-gray-100 text-gray-600' },
  behind: { label: 'Behind — promote now', cls: 'bg-rose-50 text-rose-700' },
  'too-early': { label: 'Too early to judge', cls: 'bg-gray-50 text-gray-400' },
};

function PromoCalendar({ data, classes }: { data: BookingWindowResponse; classes: BookingWindowClassBlock[] }) {
  const rows = classes.flatMap((c) => c.promo.map((p) => ({ c, p })));
  if (rows.length === 0) return null;
  const months = [...new Set(rows.map((r) => r.p.month))].sort();

  return (
    <Card
      title="6 · Promo calendar — when each month's demand arrives"
      subtitle={
        <>
          For the coming months: what is on the books today against what our history says should be by now
          (pace), and the dates by which a mid-month night is typically 25 %, 50 % and 75 % sold. A promotion
          has to be live <em>before</em>{' '}the 25 % date to move early demand; after the 75 % date only
          last-minute levers are left. Dates come from the period&apos;s own booking-lead distribution
          {classes
            .filter((c) => c.nightLeads)
            .map((c) => ` (${c.label}: half of nights booked ${days(c.nightLeads?.p50 ?? 0)}+ ahead)`)
            .join('')}
          .
        </>
      }
    >
      <Table
        columns={[
          'Stay month',
          'Class',
          'Sellable',
          'On books',
          'Usual by now',
          'Market',
          'Pace',
          '25 % sold by',
          '50 % by',
          '75 % by',
        ]}
      >
        {months.flatMap((month) =>
          rows
            .filter((r) => r.p.month === month)
            .map(({ c, p }, i) => {
              const status = STATUS_STYLE[p.status] ?? STATUS_STYLE['too-early'];
              const past = (iso: string | null) => (iso != null && iso < data.todayIso ? 'text-gray-400 line-through' : '');
              return (
                <tr key={`${month}-${c.classId}`} className={`hover:bg-gray-50 ${i === 0 ? 'border-t border-gray-100' : ''}`}>
                  <Td align="left">{i === 0 ? <span className="font-medium text-gray-800">{monthLabel(month)}</span> : ''}</Td>
                  <Td align="left">
                    <ClassName block={c} />
                  </Td>
                  <Td muted>{num(p.availableNights)}</Td>
                  <Td bold>
                    {pct(p.occupancy, 0)} <span className="text-[10px] text-gray-400">({p.onBooks})</span>
                  </Td>
                  <Td>{pctOrDash(p.expectedOccupancy)}</Td>
                  <Td muted>{pctOrDash(p.marketOccupancy)}</Td>
                  <Td>
                    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${status.cls}`}>
                      {status.label}
                      {p.pace != null && p.status !== 'too-early' ? ` · ${pct(p.pace, 0)}` : ''}
                    </span>
                  </Td>
                  <Td className={past(p.quarterBookedBy)}>{dateShort(p.quarterBookedBy)}</Td>
                  <Td className={past(p.halfBookedBy)}>{dateShort(p.halfBookedBy)}</Td>
                  <Td className={past(p.threeQuartersBookedBy)}>{dateShort(p.threeQuartersBookedBy)}</Td>
                </tr>
              );
            }),
        )}
      </Table>
      <p className="text-[11px] text-gray-400 mt-3">
        Pace = on the books ÷ usual by now; inside ±15 % is on pace. &quot;Usual&quot; is our pooled history
        at the same distance from each night, so it carries no month-specific seasonality yet (under a year of
        trading) — read it alongside the market column for holiday months. Struck-through dates have passed.
      </p>
    </Card>
  );
}

// ── 6b. When bookings arrive ─────────────────────────────────────────────────

function WhenBookingsArrive({
  classes,
  all,
}: {
  classes: BookingWindowClassBlock[];
  all: BookingWindowClassBlock;
}) {
  const [selected, setSelected] = useState<ClassKey>(classes[0]?.classId ?? 'all');
  const block = [...classes, all].find((c) => c.classId === selected) ?? all;

  return (
    <Card
      title="6 · When bookings arrive"
      subtitle="Which month each stay month was booked in, the hour and weekday bookings are made, and whether the booking window is moving."
      actions={<ClassToggle value={selected} onChange={setSelected} options={[...classes, all]} />}
    >
      <ProductionMatrix block={block} />
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mt-6">
        <BookingClock block={block} />
        <Trend classes={classes} all={all} />
      </div>
    </Card>
  );
}

function ProductionMatrix({ block }: { block: BookingWindowClassBlock }) {
  const cells = block.production;
  const { bookedMonths, stayMonths, byKey, stayTotals } = useMemo(() => {
    const byKey = new Map(cells.map((c) => [`${c.bookedMonth}|${c.stayMonth}`, c.nights]));
    const stayTotals = new Map<string, number>();
    for (const c of cells) stayTotals.set(c.stayMonth, (stayTotals.get(c.stayMonth) ?? 0) + c.nights);
    return {
      bookedMonths: [...new Set(cells.map((c) => c.bookedMonth))].sort(),
      stayMonths: [...new Set(cells.map((c) => c.stayMonth))].sort(),
      byKey,
      stayTotals,
    };
  }, [cells]);

  if (cells.length === 0) return <Empty />;

  return (
    <div>
      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
        Stay month (columns) by the month it was booked (rows) — {block.label}
      </p>
      <p className="text-[11px] text-gray-400 mb-3">
        Each column adds to 100 %: the share of that month&apos;s sold nights booked in each month. Read down a
        column to see how early a month fills; the row a promo would have to run in is the one with the mass.
      </p>
      <div className="overflow-x-auto -mx-2 px-2">
        <table className="border-separate text-[11px]" style={{ borderSpacing: '2px' }}>
          <thead>
            <tr>
              <th className="text-left text-[10px] font-medium text-gray-400 pr-2">Booked ↓ / Stay →</th>
              {stayMonths.map((m) => (
                <th key={m} className="text-[10px] font-medium text-gray-500 px-1 whitespace-nowrap">
                  {monthShort(m)} {m.slice(2, 4)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bookedMonths.map((bm) => (
              <tr key={bm}>
                <td className="font-medium text-gray-600 pr-2 whitespace-nowrap">
                  {monthShort(bm)} {bm.slice(2, 4)}
                </td>
                {stayMonths.map((sm) => {
                  const nights = byKey.get(`${bm}|${sm}`) ?? 0;
                  const share = nights / Math.max(stayTotals.get(sm) ?? 0, 1);
                  return (
                    <td key={sm}>
                      <div
                        className="rounded-sm text-center tabular-nums"
                        style={{
                          minWidth: 40,
                          padding: '3px 2px',
                          ...(nights === 0 ? { backgroundColor: '#F9FAFB', color: '#D1D5DB' } : heatStyle(share * 1.6)),
                        }}
                        title={`${nights} nights of ${stayTotals.get(sm) ?? 0} stayed in ${monthLabel(sm)} were booked in ${monthLabel(bm)}`}
                      >
                        {nights === 0 ? '·' : pct(share, 0)}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BookingClock({ block }: { block: BookingWindowClassBlock }) {
  const cells = block.heat;
  if (cells.length === 0) return null;

  const byKey = new Map(cells.map((c) => [`${c.isoDow}|${c.hour}`, c.bookings]));
  const max = Math.max(...cells.map((c) => c.bookings), 1);
  const total = cells.reduce((acc, c) => acc + c.bookings, 0);
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const byHour = hours.map((h) => cells.filter((c) => c.hour === h).reduce((a, c) => a + c.bookings, 0));
  const byDow = [1, 2, 3, 4, 5, 6, 7].map((d) => cells.filter((c) => c.isoDow === d).reduce((a, c) => a + c.bookings, 0));
  const peakHour = byHour.indexOf(Math.max(...byHour));
  const peakDow = byDow.indexOf(Math.max(...byDow));
  const eveningShare = byHour.slice(18).reduce((a, v) => a + v, 0) / Math.max(total, 1);

  return (
    <div>
      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Booking clock</p>
      <p className="text-[11px] text-gray-400 mb-3">
        Europe/Prague time. {pct(eveningShare, 0)} of bookings land after 18:00, peaking at {peakHour}:00;
        busiest day {ISO_DOW_LABELS[peakDow]}. Launch a promotion or rate change before the peak, not after.
      </p>
      <div className="overflow-x-auto -mx-2 px-2">
        <table className="border-separate" style={{ borderSpacing: '2px' }}>
          <thead>
            <tr>
              <th className="w-8" />
              {hours.map((h) => (
                <th key={h} className="text-[9px] font-medium text-gray-400 tabular-nums" style={{ minWidth: 14 }}>
                  {h % 3 === 0 ? h : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[1, 2, 3, 4, 5, 6, 7].map((dow) => (
              <tr key={dow}>
                <td className="text-[10px] font-medium text-gray-600 pr-1.5 whitespace-nowrap">{ISO_DOW_LABELS[dow - 1]}</td>
                {hours.map((h) => {
                  const value = byKey.get(`${dow}|${h}`) ?? 0;
                  return (
                    <td key={h}>
                      <div
                        className="h-4 rounded-sm"
                        style={value === 0 ? { backgroundColor: '#F9FAFB' } : heatStyle(value / max, 'emerald')}
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
      <p className="text-[10px] text-gray-400 mt-2">{num(total)} bookings arriving in the period.</p>
    </div>
  );
}

function Trend({ classes, all }: { classes: BookingWindowClassBlock[]; all: BookingWindowClassBlock }) {
  const months = all.trend.map((t) => t.month);
  if (months.length < 2) return null;
  const chartData = months.map((month) => {
    const row: Record<string, number | string | null> = { month: monthShort(month) + ' ' + month.slice(2, 4) };
    for (const c of classes) {
      const t = c.trend.find((x) => x.month === month);
      row[c.label] = t && t.bookings >= 3 ? Math.round(t.medianLeadDays) : null;
      row[`${c.label} bookings`] = t?.bookings ?? 0;
    }
    return row;
  });

  return (
    <div>
      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
        Is the booking window moving?
      </p>
      <p className="text-[11px] text-gray-400 mb-3">
        Median days ahead, by the month the booking was made — whole history, cancellations excluded. Months
        with under 3 bookings are skipped.
      </p>
      <div style={{ height: 210 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="month" tick={{ ...AXIS_TICK_DARK, fontSize: 10 }} axisLine={false} tickLine={false} />
            <YAxis yAxisId="days" tickFormatter={(v) => `${v}d`} tick={AXIS_TICK} axisLine={false} tickLine={false} width={36} />
            <YAxis yAxisId="count" orientation="right" tick={AXIS_TICK} axisLine={false} tickLine={false} width={30} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value, name) =>
                String(name).endsWith('bookings')
                  ? [num(Number(value)), String(name)]
                  : [value == null ? '—' : `${value} days`, `${name} median`]
              }
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {classes.map((c) => (
              <Bar
                key={`${c.classId}-b`}
                yAxisId="count"
                dataKey={`${c.label} bookings`}
                fill={CLASS_COLORS[c.classId]}
                fillOpacity={0.18}
                maxBarSize={14}
                legendType="none"
              />
            ))}
            {classes.map((c) => (
              <Line
                key={c.classId}
                yAxisId="days"
                type="monotone"
                dataKey={c.label}
                stroke={CLASS_COLORS[c.classId]}
                strokeWidth={2.5}
                dot={{ r: 3 }}
                connectNulls
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

'use client';
/**
 * Overview.
 *
 * Structured around RevPAR rather than revenue, because RevPAR is the only
 * headline number that cannot be gamed by adding rooms or discounting: it is
 * occupancy × ADR, so every other chart on the page exists to explain which of
 * those two moved. The layout follows that logic top to bottom —
 * headline → decomposition → where it came from (room, channel) → who the guests
 * were → what is already sold ahead.
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
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CHANNEL_COLORS, CHANNEL_COLOR_FALLBACK } from '@/utils/channelColors';
import type { MarketResponse, OverviewResponse } from '@/utils/analyticsTypes';
import {
  AXIS_TICK,
  AXIS_TICK_DARK,
  Callout,
  Card,
  czk,
  czkAxis,
  days,
  Delta,
  Empty,
  GRID_STROKE,
  monthShort,
  num,
  pct,
  Provisional,
  ROOM_COLORS,
  Table,
  Td,
  Tile,
  TOOLTIP_STYLE,
  UNIT_COLORS,
} from './kit';

const channelColor = (channel: string) => CHANNEL_COLORS[channel] ?? CHANNEL_COLOR_FALLBACK;

export default function OverviewSection({
  data,
  market,
}: {
  data: OverviewResponse;
  market: MarketResponse | null;
}) {
  const { kpis, previous } = data;

  if (kpis.availableNights === 0) {
    return <Empty message="No available room-nights in this period — nothing to report." />;
  }

  return (
    <>
      <HeadlineTiles data={data} market={market} />
      <RevparDecomposition data={data} />
      <RevenueBridge data={data} />
      <UnitLeagueTable data={data} />
      <ChannelEconomics data={data} />
      <GuestMix data={data} />
      <ForwardBook data={data} />
      <details className="group">
        <summary className="cursor-pointer list-none text-sm font-medium text-gray-500 hover:text-gray-700 py-2">
          <span className="group-open:hidden">Show the per-room breakdown ▾</span>
          <span className="hidden group-open:inline">Hide the per-room breakdown ▴</span>
        </summary>
        <div className="space-y-6 mt-4">
          <Callout tone="slate" title="Read this for wear and cleaning, not for pricing">
            Beds24 decides which of the interchangeable studios a booking lands in, so a single
            room out-performing its siblings usually reflects the allocator&apos;s packing order
            rather than demand. The unit table above is the fair comparison.
          </Callout>
          <RoomLeagueTable data={data} />
        </div>
      </details>
      {previous && previous.availableNights === 0 && (
        <Callout tone="slate">
          No comparison shown on the tiles: the equally-long window before this one has no trading
          history, so a change figure would be meaningless rather than zero.
        </Callout>
      )}
    </>
  );
}

// ── Headline ─────────────────────────────────────────────────────────────────

function HeadlineTiles({ data, market }: { data: OverviewResponse; market: MarketResponse | null }) {
  const { kpis: k, previous: p } = data;
  const comparable = p && p.availableNights > 0 ? p : null;

  /**
   * The 30-day forward MPI, shown beside occupancy.
   *
   * 30 days rather than the selected window on purpose: MPI is only actionable
   * forward, and the market snapshot is a forward-looking dataset. It is labelled
   * as such rather than being quietly mixed into the period figures.
   */
  const mpi30 = market?.portfolio.find((h) => h.horizonDays === 30) ?? null;

  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Tile
          label="RevPAR"
          tone="indigo"
          value={czk(k.revpar)}
          hint="Revenue per available night — occupancy × ADR"
          delta={<Delta current={k.revpar} previous={comparable?.revpar} />}
        />
        <Tile
          label="Occupancy"
          tone="emerald"
          value={pct(k.occupancy, 1)}
          hint={`${num(k.soldNights)} of ${num(k.availableNights)} nights sold`}
          delta={
            <Delta current={k.occupancy} previous={comparable?.occupancy} format="points" />
          }
        />
        <Tile
          label="ADR"
          tone="sky"
          value={czk(k.adr)}
          hint="Average price per sold night"
          delta={<Delta current={k.adr} previous={comparable?.adr} />}
        />
        <Tile
          label="Net RevPAR"
          tone="violet"
          value={czk(k.netRevpar)}
          hint={`After ${pct(k.takeRate, 1)} distribution cost`}
          delta={<Delta current={k.netRevpar} previous={comparable?.netRevpar} />}
        />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Tile
          label="Gross booking value"
          value={czk(k.gbv)}
          hint={`${num(k.bookings)} bookings`}
          delta={<Delta current={k.gbv} previous={comparable?.gbv} />}
        />
        <Tile
          label="Net sales"
          value={czk(k.netSales)}
          hint={`−${czk(k.otaCommission + k.paymentFees)} to platforms`}
          delta={<Delta current={k.netSales} previous={comparable?.netSales} />}
        />
        <Tile
          label="Avg stay · party"
          value={`${num(k.avgLengthOfStay, 1)} n · ${num(k.avgPartySize, 1)} p`}
          hint="Nights per booking · guests per booking"
        />
        <Tile
          label="Guest score"
          value={k.avgReviewScore == null ? '—' : `${num(k.avgReviewScore, 2)} / 10`}
          hint={
            k.reviewCount > 0
              ? `${num(k.reviewCount)} reviews, normalised across channels`
              : 'No reviews synced for this window'
          }
        />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Tile
          label="Booking window"
          value={days(k.medianLeadDays)}
          hint={`Median. Mean ${days(k.avgLeadDays)} — pulled up by a few early bookings`}
        />
        <Tile
          label="MPI · next 30 days"
          tone={mpi30?.mpi == null ? 'slate' : mpi30.mpi >= 1 ? 'emerald' : 'rose'}
          value={mpi30?.mpi == null ? '—' : `${num(mpi30.mpi, 2)}×`}
          hint={
            mpi30?.mpi == null
              ? 'No market snapshot captured yet'
              : `Forward: ${pct(mpi30.ourOccupancy, 0)} on the books vs ${pct(mpi30.marketOccupancy ?? 0, 0)} market`
          }
        />
        <Tile
          label="Cancellation rate"
          tone={k.cancellationRate > 0.2 ? 'rose' : 'slate'}
          value={pct(k.cancellationRate, 1)}
          hint="Guest cancellations ÷ arrivals due in this window. Abandoned checkouts excluded"
          delta={
            <Delta
              current={k.cancellationRate}
              previous={comparable?.cancellationRate}
              format="points"
              higherIsBetter={false}
            />
          }
        />
        <Tile
          label="Distribution take rate"
          tone={k.takeRate > 0.18 ? 'amber' : 'slate'}
          value={pct(k.takeRate, 1)}
          hint="Commission + payment fees ÷ gross"
          delta={
            <Delta
              current={k.takeRate}
              previous={comparable?.takeRate}
              format="points"
              higherIsBetter={false}
            />
          }
        />
        <Tile
          label="Nights sold"
          value={num(k.soldNights)}
          hint={`Across ${num(k.availableNights)} available`}
          delta={<Delta current={k.soldNights} previous={comparable?.soldNights} />}
        />
      </div>
    </>
  );
}

// ── RevPAR = occupancy × ADR ──────────────────────────────────────────────────

function RevparDecomposition({ data }: { data: OverviewResponse }) {
  const chartData = data.monthly.map((m) => ({
    month: monthShort(m.month),
    fullMonth: m.month,
    RevPAR: Math.round(m.revpar),
    'Net RevPAR': Math.round(m.netRevpar),
    Occupancy: Math.round(m.occupancy * 100),
    ADR: Math.round(m.adr),
    partial: m.partial,
  }));

  if (chartData.length === 0) return null;

  return (
    <Card
      title="RevPAR, and what drove it"
      subtitle="Bars are revenue per available night; lines are the two factors behind it. When RevPAR moves and ADR does not, the move came from occupancy — and vice versa. Hatched bars are months that have not finished."
    >
      <div style={{ height: 300 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="month" tick={AXIS_TICK_DARK} axisLine={false} tickLine={false} />
            <YAxis
              yAxisId="money"
              tickFormatter={czkAxis}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={48}
            />
            <YAxis
              yAxisId="occ"
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
                name === 'Occupancy' ? [`${value} %`, name] : [czk(Number(value)), name]
              }
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {/* Explicit fill so the legend swatch is indigo rather than the default
                black — the per-bar <Cell> below still overrides the actual bars. */}
            <Bar yAxisId="money" dataKey="RevPAR" fill="#6366F1" radius={[5, 5, 0, 0]} maxBarSize={44}>
              {chartData.map((d) => (
                <Cell
                  key={d.fullMonth}
                  fill="#6366F1"
                  fillOpacity={d.partial ? 0.45 : 1}
                  stroke={d.partial ? '#6366F1' : undefined}
                  strokeDasharray={d.partial ? '3 2' : undefined}
                />
              ))}
            </Bar>
            <Line
              yAxisId="occ"
              type="monotone"
              dataKey="Occupancy"
              stroke="#10B981"
              strokeWidth={2}
              dot={{ r: 3 }}
            />
            <Line
              yAxisId="money"
              type="monotone"
              dataKey="ADR"
              stroke="#F59E0B"
              strokeWidth={2}
              dot={{ r: 3 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="border-t border-gray-100 pt-4 mt-4">
        <Table
          columns={['Month', 'Occupancy', 'ADR', 'RevPAR', 'Net RevPAR', 'Nights', 'GBV', 'Bookings']}
        >
          {data.monthly.map((m) => (
            <tr key={m.month} className="hover:bg-gray-50">
              <Td align="left">
                <span className="font-medium text-gray-800">{monthShort(m.month)}</span>
                <span className="text-gray-400 ml-1">{m.month.slice(0, 4)}</span>
                {m.partial && <Provisional />}
              </Td>
              <Td>{pct(m.occupancy, 1)}</Td>
              <Td>{czk(m.adr)}</Td>
              <Td bold>{czk(m.revpar)}</Td>
              <Td>{czk(m.netRevpar)}</Td>
              <Td>
                {num(m.soldNights)}
                <span className="text-gray-300"> / {num(m.availableNights)}</span>
              </Td>
              <Td>{czk(m.gbv)}</Td>
              <Td>{num(m.bookings)}</Td>
            </tr>
          ))}
        </Table>
      </div>
    </Card>
  );
}

// ── Revenue bridge ───────────────────────────────────────────────────────────

function RevenueBridge({ data }: { data: OverviewResponse }) {
  const { kpis } = data;
  if (kpis.gbv <= 0) return null;

  const steps = [
    { label: 'Gross booking value', amount: kpis.gbv, kind: 'total' as const },
    { label: 'OTA commission', amount: kpis.otaCommission, kind: 'deduction' as const },
    { label: 'Payment fees', amount: kpis.paymentFees, kind: 'deduction' as const },
    { label: 'Net sales', amount: kpis.netSales, kind: 'result' as const },
  ];

  return (
    <Card
      title="Where the gross went"
      subtitle="Distribution cost only. Operating costs and gross profit live in the Costs & commissions section."
    >
      <div className="space-y-2.5">
        {steps.map((s) => {
          const width = (s.amount / kpis.gbv) * 100;
          const tone =
            s.kind === 'deduction'
              ? 'bg-rose-400'
              : s.kind === 'result'
                ? 'bg-emerald-500'
                : 'bg-indigo-500';
          return (
            <div key={s.label}>
              <div className="flex items-baseline justify-between text-sm mb-1">
                <span className={s.kind === 'deduction' ? 'text-gray-500' : 'font-medium text-gray-800'}>
                  {s.kind === 'deduction' ? '− ' : ''}
                  {s.label}
                </span>
                <span className="flex items-baseline gap-2">
                  <span
                    className={
                      s.kind === 'deduction' ? 'text-rose-600' : 'font-semibold text-gray-900'
                    }
                  >
                    {czk(s.amount)}
                  </span>
                  <span className="text-[11px] text-gray-400 w-12 text-right">
                    {pct(s.amount / kpis.gbv, 1)}
                  </span>
                </span>
              </div>
              <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(width, 0.4)}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── Room league table ────────────────────────────────────────────────────────

type RoomMetric = 'revpar' | 'occupancy' | 'adr';

function RoomLeagueTable({ data }: { data: OverviewResponse }) {
  const [metric, setMetric] = useState<RoomMetric>('revpar');
  const rooms = data.rooms;

  const chartData = useMemo(
    () =>
      rooms.map((r) => ({
        room: r.room,
        value:
          metric === 'revpar'
            ? Math.round(r.revpar)
            : metric === 'adr'
              ? Math.round(r.adr)
              : Math.round(r.occupancy * 100),
      })),
    [rooms, metric],
  );

  if (rooms.length === 0) return <Card title="By room"><Empty /></Card>;

  const best = rooms.reduce((a, b) => (b.revparIndex > a.revparIndex ? b : a));
  const worst = rooms.reduce((a, b) => (b.revparIndex < a.revparIndex ? b : a));

  const METRIC_LABELS: Record<RoomMetric, string> = {
    revpar: 'RevPAR',
    occupancy: 'Occupancy',
    adr: 'ADR',
  };

  return (
    <Card
      title="By room"
      subtitle={
        <>
          RevPAR index compares each room to the portfolio average, so it is fair across rooms that
          opened at different times — {best.room} earns {num(best.revparIndex, 2)}× the average per
          available night, {worst.room} {num(worst.revparIndex, 2)}×.
        </>
      }
      actions={
        <div className="flex gap-1">
          {(Object.keys(METRIC_LABELS) as RoomMetric[]).map((m) => (
            <button
              key={m}
              onClick={() => setMetric(m)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                metric === m
                  ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                  : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
              }`}
            >
              {METRIC_LABELS[m]}
            </button>
          ))}
        </div>
      }
    >
      <div style={{ height: 200 }} className="mb-5">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} barCategoryGap="30%" margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="room" tick={AXIS_TICK_DARK} axisLine={false} tickLine={false} />
            <YAxis
              tickFormatter={metric === 'occupancy' ? (v) => `${v}%` : czkAxis}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={48}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              cursor={{ fill: '#F9FAFB' }}
              formatter={(value) => [
                metric === 'occupancy' ? `${value} %` : czk(Number(value)),
                METRIC_LABELS[metric],
              ]}
            />
            <Bar dataKey="value" fill="#6366F1" radius={[5, 5, 0, 0]}>
              {chartData.map((d) => (
                <Cell key={d.room} fill={ROOM_COLORS[d.room] ?? '#6366F1'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <Table
        columns={['Room', 'Occupancy', 'ADR', 'RevPAR', 'Index', 'Nights', 'Bookings', 'Avg stay', 'Score']}
      >
        {rooms.map((r) => (
          <tr key={r.room} className="hover:bg-gray-50">
            <Td align="left">
              <span className="inline-flex items-center gap-2">
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: ROOM_COLORS[r.room] ?? '#6366F1' }}
                />
                <span className="font-medium text-gray-800">{r.room}</span>
                <span className="text-[10px] uppercase tracking-wide text-gray-300">{r.category}</span>
              </span>
            </Td>
            <Td>{pct(r.occupancy, 1)}</Td>
            <Td>{czk(r.adr)}</Td>
            <Td bold>{czk(r.revpar)}</Td>
            <Td
              className={
                r.revparIndex >= 1.1
                  ? '!text-emerald-600 font-semibold'
                  : r.revparIndex <= 0.9
                    ? '!text-rose-600 font-semibold'
                    : ''
              }
            >
              {num(r.revparIndex, 2)}×
            </Td>
            <Td>
              {num(r.soldNights)}
              <span className="text-gray-300"> / {num(r.availableNights)}</span>
            </Td>
            <Td>{num(r.bookings)}</Td>
            <Td>{num(r.avgLengthOfStay, 1)} n</Td>
            <Td muted={r.avgReviewScore == null}>
              {r.avgReviewScore == null ? '—' : num(r.avgReviewScore, 1)}
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

// ── Channel economics ────────────────────────────────────────────────────────

function ChannelEconomics({ data }: { data: OverviewResponse }) {
  const channels = data.channels;
  if (channels.length === 0) return null;

  const chartData = channels.map((c) => ({
    channel: c.channel,
    'Net ADR': Math.round(c.netAdr),
    Commission: Math.round(c.adr - c.netAdr),
    color: channelColor(c.channel),
  }));

  const best = channels.reduce((a, b) => (b.netAdr > a.netAdr ? b : a));

  return (
    <Card
      title="Channel economics"
      subtitle={
        <>
          Gross ADR is what the guest paid; net ADR is what the business kept. Comparing channels on
          gross alone hides the commission — on this window {best.channel} nets the most per night at{' '}
          {czk(best.netAdr)}.
        </>
      }
    >
      <div style={{ height: 220 }} className="mb-5">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} barCategoryGap="30%" margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="channel" tick={AXIS_TICK_DARK} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={czkAxis} tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              cursor={{ fill: '#F9FAFB' }}
              formatter={(value, name) => [czk(Number(value)), name]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="Net ADR" stackId="adr" fill="#6366F1" radius={[0, 0, 0, 0]}>
              {chartData.map((d) => (
                <Cell key={d.channel} fill={d.color} />
              ))}
            </Bar>
            <Bar dataKey="Commission" stackId="adr" fill="#FCA5A5" radius={[5, 5, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <Table
        columns={[
          'Channel',
          'Nights',
          'Share',
          'Gross ADR',
          'Net ADR',
          'Take rate',
          'Net sales',
          'Avg stay',
          'Lead',
          'Cancel',
        ]}
      >
        {channels.map((c) => (
          <tr key={c.channel} className="hover:bg-gray-50">
            <Td align="left">
              <span className="inline-flex items-center gap-2">
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: channelColor(c.channel) }}
                />
                <span className="font-medium text-gray-800">{c.channel}</span>
              </span>
            </Td>
            <Td>{num(c.soldNights)}</Td>
            <Td>{pct(c.nightShare, 1)}</Td>
            <Td>{czk(c.adr)}</Td>
            <Td bold>{czk(c.netAdr)}</Td>
            <Td className={c.effectiveCommissionRate > 0.18 ? '!text-rose-600 font-medium' : ''}>
              {pct(c.effectiveCommissionRate, 1)}
            </Td>
            <Td>{czk(c.netSales)}</Td>
            <Td>{num(c.avgLengthOfStay, 1)} n</Td>
            <Td>{days(c.avgLeadDays)}</Td>
            <Td className={c.cancellationRate > 0.2 ? '!text-rose-600 font-medium' : ''}>
              {pct(c.cancellationRate, 0)}
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

// ── Guest mix ────────────────────────────────────────────────────────────────

function GuestMix({ data }: { data: OverviewResponse }) {
  const topNationalities = data.nationalities.slice(0, 12);
  const rest = data.nationalities.slice(12);
  const restBookings = rest.reduce((acc, r) => acc + r.bookings, 0);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card
        title="Length of stay"
        subtitle="Bookings by nights booked. Short stays dominate volume but carry a full turnover cost each — see Costs & commissions."
      >
        <DistributionBars
          rows={data.lengthOfStay.map((b) => ({ label: b.label, value: b.bookings, share: b.share }))}
        />
      </Card>

      <Card title="Party size" subtitle="Guests per booking, as declared on the channel.">
        <DistributionBars
          rows={data.partySize.map((b) => ({ label: b.label, value: b.bookings, share: b.share }))}
          hue="emerald"
        />
      </Card>

      <Card
        title="Guest origin"
        subtitle="By gross booking value. Nationality comes from the channel and is blank on some direct bookings."
        className="lg:col-span-2"
      >
        {topNationalities.length === 0 ? (
          <Empty />
        ) : (
          <Table columns={['Country', 'Bookings', 'Nights', 'GBV', 'ADR', 'Avg stay']}>
            {topNationalities.map((row) => (
              <tr key={row.code} className="hover:bg-gray-50">
                <Td align="left">
                  <span className="font-medium text-gray-800">{row.code}</span>
                </Td>
                <Td>{num(row.bookings)}</Td>
                <Td>{num(row.nights)}</Td>
                <Td bold>{czk(row.gbv)}</Td>
                <Td>{czk(row.adr)}</Td>
                <Td>{num(row.avgLengthOfStay, 1)} n</Td>
              </tr>
            ))}
            {rest.length > 0 && (
              <tr>
                <Td align="left" muted>
                  {rest.length} more countries
                </Td>
                <Td muted>{num(restBookings)}</Td>
                <Td muted>{num(rest.reduce((a, r) => a + r.nights, 0))}</Td>
                <Td muted>{czk(rest.reduce((a, r) => a + r.gbv, 0))}</Td>
                <Td muted>—</Td>
                <Td muted>—</Td>
              </tr>
            )}
          </Table>
        )}
      </Card>
    </div>
  );
}

function DistributionBars({
  rows,
  hue = 'indigo',
}: {
  rows: { label: string; value: number; share: number }[];
  hue?: 'indigo' | 'emerald';
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const bar = hue === 'indigo' ? 'bg-indigo-500' : 'bg-emerald-500';
  if (rows.every((r) => r.value === 0)) return <Empty />;
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div key={r.label}>
          <div className="flex items-baseline justify-between text-sm mb-1">
            <span className="text-gray-700">{r.label}</span>
            <span className="text-gray-500">
              <span className="font-semibold text-gray-800">{num(r.value)}</span>{' '}
              <span className="text-[11px] text-gray-400">{pct(r.share, 0)}</span>
            </span>
          </div>
          <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
            <div className={`h-full rounded-full ${bar}`} style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Forward book ─────────────────────────────────────────────────────────────

function ForwardBook({ data }: { data: OverviewResponse }) {
  const pace = data.pace;
  if (pace.length === 0) return null;

  const chartData = pace.map((p) => ({
    month: monthShort(p.month),
    'On the books': Math.round(p.occupancyOnBooks * 100),
    ADR: Math.round(p.adrOnBooks),
  }));

  return (
    <Card
      title="On the books, next six months"
      subtitle="Occupancy already sold for each future month, and the ADR it was sold at. The pace column compares against the previous month measured at the same distance out — a stand-in for same-time-last-year until a second year of data exists."
    >
      <div style={{ height: 220 }} className="mb-5">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
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
                name === 'ADR' ? [czk(Number(value)), name] : [`${value} %`, name]
              }
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar yAxisId="occ" dataKey="On the books" fill="#818CF8" radius={[5, 5, 0, 0]} maxBarSize={44} />
            <Line yAxisId="money" type="monotone" dataKey="ADR" stroke="#F59E0B" strokeWidth={2} dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <Table columns={['Month', 'Days out', 'Nights sold', 'Occupancy', 'GBV', 'ADR', 'Pace vs prev. month']}>
        {pace.map((p) => (
          <tr key={p.month} className="hover:bg-gray-50">
            <Td align="left">
              <span className="font-medium text-gray-800">{monthShort(p.month)}</span>
              <span className="text-gray-400 ml-1">{p.month.slice(0, 4)}</span>
            </Td>
            <Td muted>{p.daysOut <= 0 ? 'in progress' : `${num(p.daysOut)} d`}</Td>
            <Td>
              {num(p.nightsOnBooks)}
              <span className="text-gray-300"> / {num(p.availableNights)}</span>
            </Td>
            <Td bold>{pct(p.occupancyOnBooks, 1)}</Td>
            <Td>{czk(p.gbvOnBooks)}</Td>
            <Td>{p.nightsOnBooks > 0 ? czk(p.adrOnBooks) : '—'}</Td>
            <Td>
              {p.paceVsPrevMonth == null ? (
                <span className="text-gray-300">no base</span>
              ) : (
                <span
                  className={
                    p.paceVsPrevMonth > 0.05
                      ? 'text-emerald-600 font-medium'
                      : p.paceVsPrevMonth < -0.05
                        ? 'text-rose-600 font-medium'
                        : 'text-gray-500'
                  }
                >
                  {p.paceVsPrevMonth > 0 ? '+' : '−'}
                  {pct(Math.abs(p.paceVsPrevMonth), 0)}
                  <span className="text-gray-400 font-normal"> ({num(p.nightsAtSameLeadPrevMonth ?? 0)} n)</span>
                </span>
              )}
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

// ── Sellable-unit league table ───────────────────────────────────────────────

/**
 * Performance per sellable unit, which is the only fair comparison the portfolio
 * supports.
 *
 * K.102, K.103 and K.106 are one listing sold interchangeably, and Beds24 chooses
 * which physical studio takes each booking. Compared per room, the allocator's
 * packing order shows up as a performance difference; compared per unit, the numbers
 * mean what they appear to mean.
 *
 * The sold-out column is the one with a decision attached. A unit that had nothing
 * left to sell on most of its open dates was not rationing demand by price.
 */
function UnitLeagueTable({ data }: { data: OverviewResponse }) {
  const [metric, setMetric] = useState<RoomMetric>('revpar');
  const units = data.units;

  if (units.length === 0)
    return (
      <Card title="By sellable unit">
        <Empty />
      </Card>
    );

  const chartData = units.map((u) => ({
    unit: u.shortLabel,
    unitId: u.unitId,
    value:
      metric === 'revpar'
        ? Math.round(u.revpar)
        : metric === 'adr'
          ? Math.round(u.adr)
          : Math.round(u.occupancy * 100),
  }));

  const best = units.reduce((a, b) => (b.revparIndex > a.revparIndex ? b : a));
  const worst = units.reduce((a, b) => (b.revparIndex < a.revparIndex ? b : a));
  const tightest = units.reduce((a, b) => (b.soldOutRate > a.soldOutRate ? b : a));

  const METRIC_LABELS: Record<RoomMetric, string> = {
    revpar: 'RevPAR',
    occupancy: 'Occupancy',
    adr: 'ADR',
  };

  return (
    <Card
      title="By sellable unit"
      subtitle={
        <>
          The grain the market buys: {units.map((u) => `${u.shortLabel} (${u.rooms.length})`).join(', ')}.
          {best.unitId !== worst.unitId && (
            <>
              {' '}
              {best.shortLabel} earns {num(best.revparIndex, 2)}× portfolio RevPAR against{' '}
              {num(worst.revparIndex, 2)}× for {worst.shortLabel}.
            </>
          )}{' '}
          {tightest.soldOutRate > 0.5 && (
            <>
              {tightest.shortLabel} had nothing left to sell on {pct(tightest.soldOutRate, 0)} of its
              open dates.
            </>
          )}
        </>
      }
      actions={
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          {(Object.keys(METRIC_LABELS) as RoomMetric[]).map((m) => (
            <button
              key={m}
              onClick={() => setMetric(m)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                metric === m ? 'bg-white shadow-sm text-indigo-700' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {METRIC_LABELS[m]}
            </button>
          ))}
        </div>
      }
    >
      <div style={{ height: 200 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="unit" tick={AXIS_TICK_DARK} axisLine={false} tickLine={false} />
            <YAxis
              tickFormatter={metric === 'occupancy' ? (v) => `${v}%` : czkAxis}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={48}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value) => [
                metric === 'occupancy' ? `${value} %` : czk(Number(value)),
                METRIC_LABELS[metric],
              ]}
            />
            <Bar dataKey="value" radius={[5, 5, 0, 0]} maxBarSize={64} fill="#6366F1">
              {chartData.map((d) => (
                <Cell key={d.unitId} fill={UNIT_COLORS[d.unitId] ?? '#6366F1'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="border-t border-gray-100 pt-4 mt-4">
        <Table
          columns={[
            'Unit',
            'Rooms',
            'Occupancy',
            'Sold out',
            'ADR',
            'RevPAR',
            'Index',
            'Net RevPAR',
            'Nights',
            'LOS',
          ]}
        >
          {units.map((u) => (
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
              <Td muted className="!text-[11px]">
                {u.rooms.join(' · ')}
              </Td>
              <Td>{pct(u.occupancy, 1)}</Td>
              <Td className={u.soldOutRate >= 0.7 ? '!text-rose-600 font-semibold' : ''}>
                {pct(u.soldOutRate, 0)}
                <span className="text-gray-300">
                  {' '}
                  {u.soldOutDates}/{u.openDates}
                </span>
              </Td>
              <Td>{czk(u.adr)}</Td>
              <Td bold>{czk(u.revpar)}</Td>
              <Td
                className={
                  u.revparIndex >= 1.1
                    ? '!text-emerald-600'
                    : u.revparIndex <= 0.9
                      ? '!text-rose-600'
                      : ''
                }
              >
                {num(u.revparIndex, 2)}×
              </Td>
              <Td muted>{czk(u.netRevpar)}</Td>
              <Td muted>
                {num(u.soldNights)}
                <span className="text-gray-300"> / {num(u.availableNights)}</span>
              </Td>
              <Td muted>{num(u.avgLengthOfStay, 1)}</Td>
            </tr>
          ))}
        </Table>
      </div>

      <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">
        Sold out = calendar dates on which every available room in the unit was sold. For a
        single-room unit that equals occupancy; for the multi-room units it is the number that
        matters, because it is the only one that says demand went unmet.
      </p>
    </Card>
  );
}

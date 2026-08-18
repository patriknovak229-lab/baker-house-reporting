'use client';
/**
 * Costs & commissions.
 *
 * Two cost families with different mechanics, kept visually apart because
 * conflating them is what makes cost dashboards useless:
 *
 *   DISTRIBUTION — commission and payment fees, a PERCENTAGE of revenue.
 *   OPERATING    — cleaning, laundry, consumables, wear & tear, misc and
 *                  subscriptions, a FLAT AMOUNT per checkout or per month.
 *
 * The stay-length card is the section's argument: because turnover cost is flat
 * per checkout, a one-night booking pays a full cleaning out of one night's
 * revenue, and the same ADR produces very different contribution depending on
 * how long the guest stays.
 */
import { useState } from 'react';
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
import {
  VARIABLE_COST_KEYS,
  VARIABLE_COST_LABELS,
  type CostsResponse,
} from '@/utils/analyticsTypes';
import {
  AXIS_TICK,
  AXIS_TICK_DARK,
  Callout,
  Card,
  COST_COLORS,
  czk,
  czkAxis,
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
} from './kit';

const channelColor = (channel: string) => CHANNEL_COLORS[channel] ?? CHANNEL_COLOR_FALLBACK;

export default function CostsSection({ data }: { data: CostsResponse }) {
  return (
    <>
      {data.notes.length > 0 && (
        <div className="space-y-2">
          {data.notes.map((note, i) => (
            <Callout key={i} tone="amber">
              {note}
            </Callout>
          ))}
        </div>
      )}

      <HeadlineTiles data={data} />
      <ProfitBridge data={data} />
      <CommissionTrend data={data} />
      <StayLengthEconomics data={data} />
      <ChannelContribution data={data} />
      <OperatingCostShape data={data} />
      <GeniusCard data={data} />
      <SupplierLedger data={data} />
      <SettlementCheck data={data} />
    </>
  );
}

// ── Headline ─────────────────────────────────────────────────────────────────

function HeadlineTiles({ data }: { data: CostsResponse }) {
  const t = data.totals;
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Tile
          label="Gross profit"
          tone="emerald"
          value={czk(t.grossProfit)}
          hint={`${pct(t.grossMargin, 1)} of gross booking value`}
        />
        <Tile
          label="GOPAR"
          tone="indigo"
          value={czk(t.gopar)}
          hint="Gross profit per available night — the profit twin of RevPAR"
        />
        <Tile
          label="Distribution cost"
          tone="rose"
          value={czk(t.otaCommission + t.paymentFees)}
          hint={`${pct(t.otaCommissionRate, 1)} commission plus ${czk(t.paymentFees)} in payment fees`}
        />
        <Tile
          label="Operating cost"
          tone="amber"
          value={czk(t.totalVariableCosts)}
          hint={`${czk(t.cpor)} per occupied night`}
        />
      </div>

      <div className="grid grid-cols-3 lg:grid-cols-6 gap-3">
        {VARIABLE_COST_KEYS.map((key) => (
          <div key={key} className="bg-white rounded-lg border border-gray-200 p-3">
            <div className="flex items-center gap-1.5 mb-1">
              <span
                className="inline-block w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: COST_COLORS[key] }}
              />
              <p className="text-[10px] uppercase tracking-wide text-gray-400 truncate">
                {VARIABLE_COST_LABELS[key]}
              </p>
            </div>
            <p className="text-sm font-semibold text-gray-900">{czk(t.costs[key])}</p>
            <p className="text-[10px] text-gray-400">
              {t.totalVariableCosts > 0 ? pct(t.costs[key] / t.totalVariableCosts, 0) : '—'} of operating
            </p>
          </div>
        ))}
      </div>
    </>
  );
}

// ── Gross-profit bridge ──────────────────────────────────────────────────────

function ProfitBridge({ data }: { data: CostsResponse }) {
  const t = data.totals;
  if (t.gbv <= 0) return <Card title="Gross profit bridge"><Empty /></Card>;

  const steps: { label: string; amount: number; kind: 'total' | 'distribution' | 'operating' | 'result' }[] = [
    { label: 'Gross booking value', amount: t.gbv, kind: 'total' },
    { label: 'OTA commission', amount: t.otaCommission, kind: 'distribution' },
    { label: 'Payment fees', amount: t.paymentFees, kind: 'distribution' },
    ...VARIABLE_COST_KEYS.filter((k) => t.costs[k] > 0).map((k) => ({
      label: VARIABLE_COST_LABELS[k],
      amount: t.costs[k],
      kind: 'operating' as const,
    })),
    { label: 'Gross profit', amount: t.grossProfit, kind: 'result' },
  ];

  const tone = {
    total: 'bg-indigo-500',
    distribution: 'bg-rose-400',
    operating: 'bg-amber-400',
    result: 'bg-emerald-500',
  } as const;

  return (
    <Card
      title="Gross profit bridge"
      subtitle="Distribution cost in red, operating cost in amber. Every bar is a share of gross booking value, so the two families are directly comparable in size for the first time."
    >
      <div className="space-y-2.5">
        {steps.map((s) => (
          <div key={s.label}>
            <div className="flex items-baseline justify-between text-sm mb-1">
              <span
                className={
                  s.kind === 'total' || s.kind === 'result' ? 'font-medium text-gray-800' : 'text-gray-500'
                }
              >
                {s.kind === 'distribution' || s.kind === 'operating' ? '− ' : ''}
                {s.label}
              </span>
              <span className="flex items-baseline gap-2">
                <span
                  className={
                    s.kind === 'distribution'
                      ? 'text-rose-600'
                      : s.kind === 'operating'
                        ? 'text-amber-700'
                        : 'font-semibold text-gray-900'
                  }
                >
                  {czk(s.amount)}
                </span>
                <span className="text-[11px] text-gray-400 w-12 text-right">{pct(s.amount / t.gbv, 1)}</span>
              </span>
            </div>
            <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
              <div
                className={`h-full rounded-full ${tone[s.kind]}`}
                style={{ width: `${Math.max((s.amount / t.gbv) * 100, 0.4)}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-gray-100 pt-4 mt-5">
        <Table columns={['Month', 'GBV', 'Distribution', 'Operating', 'Gross profit', 'Margin', 'CPOR', 'GOPAR']}>
          {data.monthly.map((m) => (
            <tr key={m.month} className="hover:bg-gray-50">
              <Td align="left">
                <span className="font-medium text-gray-800">{monthShort(m.month)}</span>
                <span className="text-gray-400 ml-1">{m.month.slice(0, 4)}</span>
                {m.partial && <Provisional />}
              </Td>
              <Td>{czk(m.gbv)}</Td>
              <Td className="!text-rose-600">{czk(m.otaCommission + m.paymentFees)}</Td>
              <Td className="!text-amber-700">{czk(m.totalVariableCosts)}</Td>
              <Td bold>{czk(m.grossProfit)}</Td>
              <Td>{pct(m.grossMargin, 1)}</Td>
              <Td>{m.soldNights > 0 ? czk(m.cpor) : '—'}</Td>
              <Td>{czk(m.gopar)}</Td>
            </tr>
          ))}
        </Table>
      </div>
    </Card>
  );
}

// ── Commission over time ─────────────────────────────────────────────────────

function CommissionTrend({ data }: { data: CostsResponse }) {
  const months = [...new Set(data.commissionByChannelMonth.map((r) => r.month))].sort();
  const channels = [...new Set(data.commissionByChannelMonth.map((r) => r.channel))];
  if (months.length === 0) return null;

  const byKey = new Map(data.commissionByChannelMonth.map((r) => [`${r.month}|${r.channel}`, r]));

  const chartData = months.map((month) => {
    const row: Record<string, number | string> = { month: monthShort(month) };
    let gbv = 0;
    let commission = 0;
    for (const channel of channels) {
      const r = byKey.get(`${month}|${channel}`);
      row[channel] = Math.round((r?.commission ?? 0) + (r?.paymentFees ?? 0));
      gbv += r?.gbv ?? 0;
      commission += (r?.commission ?? 0) + (r?.paymentFees ?? 0);
    }
    row['Effective rate'] = gbv > 0 ? Math.round((commission / gbv) * 1000) / 10 : 0;
    return row;
  });

  return (
    <Card
      title="Commission paid to platforms"
      subtitle="Stacked by channel, with the blended effective rate on the right axis. The rate is the number to watch — total commission rises with volume, but the rate only moves when the channel mix or the rate plans change."
    >
      <div style={{ height: 280 }}>
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
              yAxisId="rate"
              orientation="right"
              tickFormatter={(v) => `${v}%`}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={44}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value, name) =>
                name === 'Effective rate' ? [`${value} %`, name] : [czk(Number(value)), name]
              }
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {channels.map((channel) => (
              <Bar
                key={channel}
                yAxisId="money"
                dataKey={channel}
                stackId="commission"
                fill={channelColor(channel)}
                maxBarSize={48}
              />
            ))}
            <Line
              yAxisId="rate"
              type="monotone"
              dataKey="Effective rate"
              stroke="#111827"
              strokeWidth={2}
              dot={{ r: 3 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="border-t border-gray-100 pt-4 mt-4">
        <Table columns={['Channel', 'Gross', 'Commission', 'Payment fees', 'Effective rate', 'Share of cost']}>
          {(() => {
            const totalCost = data.commissionByChannel.reduce(
              (acc, r) => acc + r.commission + r.paymentFees,
              0,
            );
            return data.commissionByChannel.map((r) => (
              <tr key={r.channel} className="hover:bg-gray-50">
                <Td align="left">
                  <span className="inline-flex items-center gap-2">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: channelColor(r.channel) }}
                    />
                    <span className="font-medium text-gray-800">{r.channel}</span>
                  </span>
                </Td>
                <Td>{czk(r.gbv)}</Td>
                <Td bold className="!text-rose-600">
                  {czk(r.commission)}
                </Td>
                <Td>{czk(r.paymentFees)}</Td>
                <Td className={r.effectiveRate > 0.18 ? '!text-rose-600 font-semibold' : ''}>
                  {pct(r.effectiveRate, 1)}
                </Td>
                <Td muted>{totalCost > 0 ? pct((r.commission + r.paymentFees) / totalCost, 0) : '—'}</Td>
              </tr>
            ));
          })()}
        </Table>
      </div>
    </Card>
  );
}

// ── Stay-length economics ────────────────────────────────────────────────────

function StayLengthEconomics({ data }: { data: CostsResponse }) {
  const rows = data.losEconomics;
  if (rows.length === 0) {
    return (
      <Card title="Does stay length pay?">
        <Empty message="No checkouts with cost data in this period." />
      </Card>
    );
  }

  const chartData = rows.map((r) => ({
    label: r.label,
    'Net sales / booking': Math.round(r.netSalesPerBooking),
    'Turnover cost / booking': Math.round(r.turnoverCostPerBooking),
    'Contribution / night': Math.round(r.contributionPerNight),
  }));

  const best = rows.reduce((a, b) => (b.contributionPerNight > a.contributionPerNight ? b : a));
  const worst = rows.reduce((a, b) => (b.contributionPerNight < a.contributionPerNight ? b : a));
  const oneNight = rows.find((r) => r.label === '1 night');

  return (
    <Card
      title="Does stay length pay?"
      subtitle={
        <>
          Cleaning, laundry and a consumables set are charged once per checkout regardless of stay
          length, so short stays carry the same turnover cost spread over fewer nights. Per night,{' '}
          <strong>{best.label}</strong> stays contribute {czk(best.contributionPerNight)} against{' '}
          {czk(worst.contributionPerNight)} for <strong>{worst.label}</strong>
          {oneNight
            ? ` — a one-night booking spends ${czk(oneNight.turnoverCostPerBooking)} of its ${czk(oneNight.netSalesPerBooking)} net revenue on turnover alone`
            : ''}
          . Commission is already deducted; the comparison is contribution, not revenue.
        </>
      }
    >
      <div style={{ height: 280 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="label" tick={AXIS_TICK_DARK} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={czkAxis} tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} />
            <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value, name) => [czk(Number(value)), name]} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="Net sales / booking" stackId="b" fill="#A5B4FC" maxBarSize={52} />
            <Bar dataKey="Turnover cost / booking" stackId="c" fill="#FBBF24" maxBarSize={52} />
            <Line
              type="monotone"
              dataKey="Contribution / night"
              stroke="#059669"
              strokeWidth={2.5}
              dot={{ r: 4 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="border-t border-gray-100 pt-4 mt-4">
        <Table
          columns={[
            'Stay length',
            'Bookings',
            'Nights',
            'Net sales / booking',
            'Turnover cost / booking',
            'Contribution / booking',
            'Contribution / night',
          ]}
        >
          {rows.map((r) => (
            <tr key={r.label} className="hover:bg-gray-50">
              <Td align="left">
                <span className="font-medium text-gray-800">{r.label}</span>
              </Td>
              <Td>{num(r.bookings)}</Td>
              <Td>{num(r.nights)}</Td>
              <Td>{czk(r.netSalesPerBooking)}</Td>
              <Td className="!text-amber-700">{czk(r.turnoverCostPerBooking)}</Td>
              <Td>{czk(r.contributionPerBooking)}</Td>
              <Td
                bold
                className={
                  r.contributionPerNight === best.contributionPerNight
                    ? '!text-emerald-600'
                    : r.contributionPerNight === worst.contributionPerNight
                      ? '!text-rose-600'
                      : ''
                }
              >
                {czk(r.contributionPerNight)}
              </Td>
            </tr>
          ))}
        </Table>
      </div>
    </Card>
  );
}

// ── Channel contribution ─────────────────────────────────────────────────────

function ChannelContribution({ data }: { data: CostsResponse }) {
  const rows = data.channelProfit;
  if (rows.length === 0) return null;

  const chartData = rows.map((r) => ({
    channel: r.channel,
    'Contribution / night': Math.round(r.contributionPerNight),
    colour: channelColor(r.channel),
  }));

  const best = rows.reduce((a, b) => (b.contributionPerNight > a.contributionPerNight ? b : a));

  return (
    <Card
      title="What each channel is actually worth"
      subtitle={
        <>
          Gross ADR minus commission, payment fees AND the turnover cost of servicing the stay, landed
          on a per-night basis — the only comparison that is fair between a high-ADR channel with 17%
          commission and a direct booking with none. {best.channel} contributes{' '}
          {czk(best.contributionPerNight)} per night here.
        </>
      }
    >
      <div style={{ height: 220 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} barCategoryGap="30%" margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="channel" tick={AXIS_TICK_DARK} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={czkAxis} tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              cursor={{ fill: '#F9FAFB' }}
              formatter={(value) => [czk(Number(value)), 'Contribution / night']}
            />
            <Bar dataKey="Contribution / night" fill="#6366F1" radius={[5, 5, 0, 0]}>
              {chartData.map((d) => (
                <Cell key={d.channel} fill={d.colour} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="border-t border-gray-100 pt-4 mt-4">
        <Table
          columns={[
            'Channel',
            'Bookings',
            'Nights',
            'Gross ADR',
            'Commission',
            'Turnover cost',
            'Contribution',
            'Per night',
            'Margin',
          ]}
        >
          {rows.map((r) => (
            <tr key={r.channel} className="hover:bg-gray-50">
              <Td align="left">
                <span className="inline-flex items-center gap-2">
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: channelColor(r.channel) }}
                  />
                  <span className="font-medium text-gray-800">{r.channel}</span>
                </span>
              </Td>
              <Td>{num(r.bookings)}</Td>
              <Td>{num(r.soldNights)}</Td>
              <Td>{czk(r.adr)}</Td>
              <Td className="!text-rose-600">{czk(r.otaCommission + r.paymentFees)}</Td>
              <Td className="!text-amber-700">{czk(r.variableCosts)}</Td>
              <Td>{czk(r.contribution)}</Td>
              <Td bold>{czk(r.contributionPerNight)}</Td>
              <Td>{pct(r.contributionMargin, 1)}</Td>
            </tr>
          ))}
        </Table>
        <p className="text-[11px] text-gray-400 mt-3">
          Turnover cost is attributed by checkout date, so this table covers stays that ENDED in the
          window. Small differences from the channel table on Overview (which counts nights slept) are
          expected at the period edges.
        </p>
      </div>
    </Card>
  );
}

// ── Operating cost shape ─────────────────────────────────────────────────────

function OperatingCostShape({ data }: { data: CostsResponse }) {
  const [view, setView] = useState<'month' | 'room'>('month');

  const monthData = data.monthly.map((m) => {
    const row: Record<string, number | string> = { key: monthShort(m.month), CPOR: Math.round(m.cpor) };
    for (const k of VARIABLE_COST_KEYS) row[VARIABLE_COST_LABELS[k]] = Math.round(m.costs[k]);
    return row;
  });

  const roomData = data.costByRoom.map((r) => {
    const row: Record<string, number | string> = { key: r.room, CPOR: Math.round(r.cpor) };
    for (const k of VARIABLE_COST_KEYS) row[VARIABLE_COST_LABELS[k]] = Math.round(r.costs[k]);
    return row;
  });

  const chartData = view === 'month' ? monthData : roomData;
  if (chartData.length === 0) return null;

  return (
    <Card
      title="Operating cost composition"
      subtitle="Stacked cost by category, with cost per occupied night on the right axis. CPOR is the comparable figure: total cost rises with occupancy, so only the per-night number tells you whether servicing a stay got more expensive."
      actions={
        <div className="flex gap-1">
          {(['month', 'room'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors capitalize ${
                view === v
                  ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                  : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
              }`}
            >
              By {v}
            </button>
          ))}
        </div>
      }
    >
      <div style={{ height: 280 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="key" tick={AXIS_TICK_DARK} axisLine={false} tickLine={false} />
            <YAxis
              yAxisId="money"
              tickFormatter={czkAxis}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={48}
            />
            <YAxis
              yAxisId="cpor"
              orientation="right"
              tickFormatter={czkAxis}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={48}
            />
            <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value, name) => [czk(Number(value)), name]} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {VARIABLE_COST_KEYS.map((k) => (
              <Bar
                key={k}
                yAxisId="money"
                dataKey={VARIABLE_COST_LABELS[k]}
                stackId="cost"
                fill={COST_COLORS[k]}
                maxBarSize={48}
              />
            ))}
            <Line yAxisId="cpor" type="monotone" dataKey="CPOR" stroke="#111827" strokeWidth={2} dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {view === 'room' && (
        <div className="border-t border-gray-100 pt-4 mt-4">
          <Table
            columns={[
              'Room',
              'Nights',
              ...VARIABLE_COST_KEYS.map((k) => VARIABLE_COST_LABELS[k]),
              'Total',
              'CPOR',
            ]}
          >
            {data.costByRoom.map((r) => (
              <tr key={r.room} className="hover:bg-gray-50">
                <Td align="left">
                  <span className="inline-flex items-center gap-2">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: ROOM_COLORS[r.room] ?? '#6366F1' }}
                    />
                    <span className="font-medium text-gray-800">{r.room}</span>
                  </span>
                </Td>
                <Td>{num(r.soldNights)}</Td>
                {VARIABLE_COST_KEYS.map((k) => (
                  <Td key={k} muted={r.costs[k] === 0}>
                    {r.costs[k] === 0 ? '—' : czk(r.costs[k])}
                  </Td>
                ))}
                <Td>{czk(r.total)}</Td>
                <Td bold>{r.soldNights > 0 ? czk(r.cpor) : '—'}</Td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </Card>
  );
}

// ── Genius ───────────────────────────────────────────────────────────────────

function GeniusCard({ data }: { data: CostsResponse }) {
  const g = data.geniusImpact;
  if (!g) return null;

  const chartData = [
    { label: 'Genius', ADR: Math.round(g.geniusAdr) },
    { label: 'Non-Genius', ADR: Math.round(g.nonGeniusAdr) },
  ];

  return (
    <Card
      title="What Genius costs"
      subtitle={
        <>
          Booking.com&apos;s Genius discount never appears as a line item — it is baked into the rate,
          so it is invisible in the P&amp;L. Beds24 does keep the marker, which makes the comparison
          possible: {pct(g.geniusNightShare, 0)} of Booking.com nights are Genius.{' '}
          {g.comparable && g.adrDelta != null ? (
            <>
              Their ADR sits {g.adrDelta < 0 ? 'below' : 'above'} non-Genius by{' '}
              {pct(Math.abs(g.adrDelta), 1)}. Read as a correlation, not an experiment — Genius members
              may also book different rooms and seasons.
            </>
          ) : (
            <>
              The non-Genius group is only {num(g.nonGeniusBookings)} booking
              {g.nonGeniusBookings === 1 ? '' : 's'}, below the {num(g.minComparisonBookings)} needed
              for the ADR gap to mean anything, so it is not shown. That near-total Genius penetration
              is itself the finding: the programme is effectively the standard rate here, not a
              discount applied to some guests.
            </>
          )}
        </>
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-center">
        <div style={{ height: 180 }} className="lg:col-span-2">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} barCategoryGap="40%" margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={GRID_STROKE} vertical={false} />
              <XAxis dataKey="label" tick={AXIS_TICK_DARK} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={czkAxis} tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                cursor={{ fill: '#F9FAFB' }}
                formatter={(value) => [czk(Number(value)), 'ADR']}
              />
              <Bar dataKey="ADR" fill="#003B95" radius={[5, 5, 0, 0]}>
                <Cell fill="#003B95" />
                <Cell fill="#93C5FD" />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="space-y-3">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-gray-400">Genius bookings</p>
            <p className="text-xl font-semibold text-gray-900">{num(g.geniusBookings)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-gray-400">Non-Genius bookings</p>
            <p className="text-xl font-semibold text-gray-900">{num(g.nonGeniusBookings)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-gray-400">ADR gap</p>
            <p
              className={`text-xl font-semibold ${
                g.adrDelta == null ? 'text-gray-400' : g.adrDelta < 0 ? 'text-rose-600' : 'text-emerald-600'
              }`}
            >
              {g.adrDelta == null
                ? 'n/a'
                : `${g.adrDelta > 0 ? '+' : '−'}${czk(Math.abs(g.geniusAdr - g.nonGeniusAdr))}`}
            </p>
            <p className="text-[10px] text-gray-400">
              {g.adrDelta == null ? 'sample too small' : 'per night'}
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ── Supplier ledger ──────────────────────────────────────────────────────────

function SupplierLedger({ data }: { data: CostsResponse }) {
  if (data.supplierMix.length === 0) return null;

  const total = data.supplierMix.reduce((acc, r) => acc + r.amount, 0);
  const chartData = data.supplierMix.map((r) => ({ label: r.label, Amount: Math.round(r.amount) }));

  return (
    <Card
      title="Supplier ledger, for contrast"
      subtitle="What was actually invoiced in this window, by category. This will NOT tie to the operating costs above and should not be forced to: the cost engine is accrual-by-checkout (what a stay cost to service) while invoices are cash-by-invoice-date (what was purchased). A pallet of linen bought in April serves stays into August. The gap between the two is the interesting part."
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div style={{ height: 260 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 4, right: 16, left: 8, bottom: 0 }}
              barCategoryGap="25%"
            >
              <CartesianGrid stroke={GRID_STROKE} horizontal={false} />
              <XAxis type="number" tickFormatter={czkAxis} tick={AXIS_TICK} axisLine={false} tickLine={false} />
              <YAxis
                type="category"
                dataKey="label"
                tick={{ ...AXIS_TICK_DARK, fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={100}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                cursor={{ fill: '#F9FAFB' }}
                formatter={(value) => [czk(Number(value)), 'Invoiced']}
              />
              <Bar dataKey="Amount" fill="#6366F1" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div>
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Largest suppliers
          </p>
          <Table columns={['Supplier', 'Invoices', 'Amount', 'Share']}>
            {data.topSuppliers.map((s) => (
              <tr key={s.supplier} className="hover:bg-gray-50">
                <Td align="left" className="max-w-[220px] truncate">
                  <span className="font-medium text-gray-800">{s.supplier}</span>
                </Td>
                <Td>{num(s.invoices)}</Td>
                <Td bold>{czk(s.amount)}</Td>
                <Td muted>{total > 0 ? pct(s.amount / total, 0) : '—'}</Td>
              </tr>
            ))}
          </Table>
        </div>
      </div>
    </Card>
  );
}

// ── Settlement cross-check ───────────────────────────────────────────────────

function SettlementCheck({ data }: { data: CostsResponse }) {
  const rows = data.settlementVariance;
  if (rows.length === 0) return null;

  const flagged = rows.filter((r) => r.variancePct != null && Math.abs(r.variancePct) > 0.15);

  return (
    <Card
      title="Commission cross-check"
      subtitle={
        <>
          The commission the platform charged on its own settlement statements, against what Beds24
          recorded for stays in the same period. The only independent check on the largest single cost
          line. It will never tie exactly — statements settle on payout dates while Beds24 records per
          booking — so read a few percent as timing and a large gap as a question.
          {flagged.length > 0 && (
            <>
              {' '}
              <strong>
                {flagged.length} period{flagged.length === 1 ? '' : 's'} differ by over 15% — worth a look.
              </strong>
            </>
          )}
        </>
      }
    >
      <Table
        columns={['Period', 'Statement gross', 'Statement commission', 'Beds24 commission', 'Difference', '']}
      >
        {rows.map((r) => {
          const big = r.variancePct != null && Math.abs(r.variancePct) > 0.15;
          return (
            <tr key={`${r.name}-${r.periodStart}`} className="hover:bg-gray-50">
              <Td align="left">
                <span className="font-medium text-gray-800">{r.name}</span>
                <span className="block text-[11px] text-gray-400">
                  {r.periodStart} → {r.periodEnd}
                </span>
              </Td>
              <Td>{r.statementGross == null ? '—' : czk(r.statementGross)}</Td>
              <Td>{r.statementCommission == null ? '—' : czk(r.statementCommission)}</Td>
              <Td>{czk(r.beds24Commission)}</Td>
              <Td bold className={big ? '!text-rose-600' : ''}>
                {r.variance == null
                  ? '—'
                  : `${r.variance > 0 ? '+' : '−'}${czk(Math.abs(r.variance))}`}
              </Td>
              <Td muted>
                {r.variancePct == null
                  ? ''
                  : `${r.variancePct > 0 ? '+' : '−'}${pct(Math.abs(r.variancePct), 1)}`}
              </Td>
            </tr>
          );
        })}
      </Table>
    </Card>
  );
}

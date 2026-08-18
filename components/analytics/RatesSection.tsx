'use client';
/**
 * Rates — what the ADR is actually made of, and whether the pricing strategy is landing.
 *
 * ORDER IS AN ARGUMENT. The far-out premium test comes first because it answers a
 * question already asked of the pricing engine: it is configured to charge more for
 * booking early, and this is the measurement of whether that is being paid. Then the
 * mix, because ADR is an outcome of mix and not a decision. Price position against
 * the market comes last, deliberately — it is the least trustworthy number here and
 * should not anchor the reading.
 */
import { useState } from 'react';
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MarketResponse, RatesResponse } from '@/utils/analyticsTypes';
import {
  AXIS_TICK,
  AXIS_TICK_DARK,
  Callout,
  Card,
  czk,
  czkAxis,
  Empty,
  GRID_STROKE,
  monthShort,
  num,
  pct,
  SERIES_COLORS,
  Table,
  Td,
  Tile,
  TOOLTIP_STYLE,
} from './kit';

export default function RatesSection({
  data,
  market,
}: {
  data: RatesResponse;
  market: MarketResponse | null;
}) {
  return (
    <>
      <Headline data={data} />
      <FarOutTest data={data} />
      <PromotionMix data={data} />
      <PlanMix data={data} />
      <ChannelMixOverTime data={data} />
      <StayLengthMix data={data} />
      <PricePosition market={market} />
    </>
  );
}

// ── Headline ─────────────────────────────────────────────────────────────────

function Headline({ data }: { data: RatesResponse }) {
  const promotional = data.promoMix
    .filter((r) => r.label !== 'No promotion')
    .reduce((acc, r) => acc + r.nightShare, 0);

  const nonRefundable = data.planMix
    .filter((r) => r.label === 'Non-refundable')
    .reduce((acc, r) => acc + r.nightShare, 0);

  const { premium, nearDays, farDays } = data.configuredFarOutPremium;
  const achieved = data.achievedFarOutPremium;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <Tile label="ADR" tone="indigo" value={czk(data.adr)} hint="gross, per sold room-night" />
      <Tile
        label="Nights on a promotion"
        tone={promotional > 0.75 ? 'rose' : 'amber'}
        value={pct(promotional, 0)}
        hint="arrived on a discount off the pushed rate"
      />
      <Tile
        label="Non-refundable"
        tone="emerald"
        value={pct(nonRefundable, 0)}
        hint="of nights — the plan that barely cancels"
      />
      <Tile
        label={`Far-out premium (${farDays}d vs ${nearDays}d)`}
        tone={achieved === null ? 'slate' : achieved >= premium * 0.5 ? 'emerald' : 'rose'}
        value={achieved === null ? '—' : `${achieved > 0 ? '+' : '−'}${num(Math.abs(achieved) * 100, 0)} %`}
        hint={`configured to be +${num(premium * 100, 0)} %`}
      />
    </div>
  );
}

// ── The far-out premium test ─────────────────────────────────────────────────

/**
 * Achieved ADR by lead time, against the premium the pricing engine is configured
 * to charge for booking early.
 *
 * The risk-adjusted column is the one that decides the argument. Long-lead bookings
 * cancel at a multiple of last-minute ones, and a night sold at a premium that then
 * cancels is worth nothing — so ADR alone flatters the far-out end of the curve.
 */
function FarOutTest({ data }: { data: RatesResponse }) {
  const rows = data.leadAdr.filter((r) => r.nights > 0);
  if (rows.length === 0) return null;

  const { premium, nearDays, farDays } = data.configuredFarOutPremium;
  const achieved = data.achievedFarOutPremium;
  const reference = rows.find((r) => nearDays >= r.minDays && (r.maxDays === null || nearDays <= r.maxDays));

  const chartData = rows.map((r) => ({
    bucket: r.label,
    ADR: Math.round(r.adr),
    'Risk-adjusted ADR': Math.round(r.riskAdjustedAdr),
    Cancellation: Math.round(r.cancellationRate * 100),
  }));

  const best = rows.reduce((a, b) => (b.riskAdjustedAdr > a.riskAdjustedAdr ? b : a));
  const worst = rows
    .filter((r) => r.nights >= 20)
    .reduce((a, b) => (b.riskAdjustedAdr < a.riskAdjustedAdr ? b : a), rows[0]);

  return (
    <Card
      title="Is the far-out premium being paid?"
      subtitle={
        <>
          The pricing engine is set so a stay booked around {farDays} days out costs about{' '}
          {num(premium * 100, 0)}% more than the same stay booked {nearDays} days out. This is
          what actually happened: achieved ADR by how far ahead each night was sold, with the
          cancellation rate of that lead bucket beside it.
        </>
      }
    >
      {achieved !== null && (
        <div className="mb-5">
          <Callout
            tone={achieved >= premium * 0.5 ? 'sky' : 'amber'}
            title={
              achieved < 0
                ? `Nights sold ${farDays} days out earned ${num(Math.abs(achieved) * 100, 0)}% LESS than nights sold ${nearDays} days out`
                : `Achieved premium is +${num(achieved * 100, 0)}% against a configured +${num(premium * 100, 0)}%`
            }
          >
            {achieved < 0 ? (
              <>
                The premium is not being paid — it is being avoided. Two mechanisms are visible
                in the mix below: Booking.com&apos;s Early Booker Deal discounts exactly the
                far-out bookings the engine is trying to charge more for, and the far-out
                bucket cancels at{' '}
                {rows.find((r) => farDays >= r.minDays && (r.maxDays === null || farDays <= r.maxDays))
                  ? pct(
                      rows.find(
                        (r) => farDays >= r.minDays && (r.maxDays === null || farDays <= r.maxDays),
                      )!.cancellationRate,
                      0,
                    )
                  : 'a much higher rate'}
                , so a chunk of what does sell never arrives. On a risk-adjusted basis the best
                lead bucket is <strong>{best.label}</strong> at {czk(best.riskAdjustedAdr)} per
                night and the worst is <strong>{worst.label}</strong> at{' '}
                {czk(worst.riskAdjustedAdr)}.
              </>
            ) : (
              <>
                The premium is landing. Reference bucket {reference?.label ?? `${nearDays}d`} at{' '}
                {reference ? czk(reference.adr) : '—'}; on a risk-adjusted basis the strongest
                bucket is {best.label} at {czk(best.riskAdjustedAdr)}.
              </>
            )}
          </Callout>
        </div>
      )}

      <div style={{ height: 270 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="bucket" tick={{ ...AXIS_TICK_DARK, fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis
              yAxisId="money"
              tickFormatter={czkAxis}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={48}
            />
            <YAxis
              yAxisId="pct"
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
                name === 'Cancellation' ? [`${value} %`, 'Cancellation rate'] : [czk(Number(value)), name]
              }
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {reference && (
              <ReferenceLine
                yAxisId="money"
                y={Math.round(reference.adr)}
                stroke="#9CA3AF"
                strokeDasharray="4 3"
                label={{ value: 'reference', position: 'insideTopRight', fontSize: 10, fill: '#9CA3AF' }}
              />
            )}
            <Bar yAxisId="money" dataKey="ADR" fill="#A5B4FC" radius={[5, 5, 0, 0]} maxBarSize={34} />
            <Bar
              yAxisId="money"
              dataKey="Risk-adjusted ADR"
              fill="#6366F1"
              radius={[5, 5, 0, 0]}
              maxBarSize={34}
            />
            <Line
              yAxisId="pct"
              type="monotone"
              dataKey="Cancellation"
              stroke="#F43F5E"
              strokeWidth={2}
              dot={{ r: 3 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="border-t border-gray-100 pt-4 mt-4">
        <Table
          columns={['Booked', 'Nights', 'Share', 'ADR', 'vs reference', 'Cancels', 'Risk-adjusted ADR']}
        >
          {rows.map((r) => (
            <tr key={r.label} className="hover:bg-gray-50">
              <Td align="left">
                <span className="font-medium text-gray-800">{r.label}</span>
                {reference?.label === r.label && (
                  <span className="ml-2 text-[10px] text-gray-400 uppercase tracking-wide">reference</span>
                )}
              </Td>
              <Td>{num(r.nights)}</Td>
              <Td muted>{pct(r.nightShare, 1)}</Td>
              <Td>{czk(r.adr)}</Td>
              <Td
                className={
                  r.vsReference === null
                    ? '!text-gray-300'
                    : r.vsReference > 0.02
                      ? '!text-emerald-600'
                      : r.vsReference < -0.02
                        ? '!text-rose-600'
                        : ''
                }
              >
                {r.vsReference === null
                  ? '—'
                  : `${r.vsReference > 0 ? '+' : '−'}${num(Math.abs(r.vsReference) * 100, 0)} %`}
              </Td>
              <Td className={r.cancellationRate > 0.3 ? '!text-rose-600 font-semibold' : ''}>
                {pct(r.cancellationRate, 0)}
              </Td>
              <Td bold>{czk(r.riskAdjustedAdr)}</Td>
            </tr>
          ))}
        </Table>
      </div>

      <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">
        Stay basis: a night is counted in the bucket matching how far ahead it was booked.
        Risk-adjusted ADR = ADR × (1 − cancellation rate) for that bucket — the value that
        actually survives to arrival.
      </p>
    </Card>
  );
}

// ── Promotion mix ────────────────────────────────────────────────────────────

/**
 * Which promotion rewrote the price, and what it collected.
 *
 * The pricing engine sets a rate; the channel then discounts it under a promotion
 * name. This is the gap between the two, and it is where most of the ADR story
 * lives — with almost every OTA night arriving on some deal, the promotion mix
 * decides how much of the pushed rate is actually collected.
 */
function PromotionMix({ data }: { data: RatesResponse }) {
  const rows = data.promoMix;
  if (rows.length === 0) return <Card title="Promotions"><Empty /></Card>;

  // Same promotion can appear per channel; collapse for the chart.
  const byLabel = new Map<string, { nights: number; gbv: number }>();
  for (const r of rows) {
    const slot = byLabel.get(r.label) ?? { nights: 0, gbv: 0 };
    slot.nights += r.nights;
    slot.gbv += r.gbv;
    byLabel.set(r.label, slot);
  }
  const totalNights = [...byLabel.values()].reduce((acc, v) => acc + v.nights, 0);
  const chartData = [...byLabel.entries()]
    .map(([label, v]) => ({
      label,
      Share: Math.round((v.nights / Math.max(totalNights, 1)) * 100),
      ADR: Math.round(v.gbv / Math.max(v.nights, 1)),
    }))
    .sort((a, b) => b.Share - a.Share);

  const lastMinute = rows.filter((r) => r.label.includes('Last Minute') || r.label.includes('Super Last'));
  const lastMinuteShare = lastMinute.reduce((acc, r) => acc + r.nightShare, 0);
  const lastMinuteAdr =
    lastMinute.reduce((acc, r) => acc + r.gbv, 0) /
    Math.max(
      lastMinute.reduce((acc, r) => acc + r.nights, 0),
      1,
    );

  return (
    <Card
      title="Promotions — the discount off the pushed rate"
      subtitle={
        <>
          Parsed from what Beds24 recorded per night. The pricing engine decides a rate and the
          channel then rewrites it under a promotion, so this table is the difference between
          the price we set and the price we collected.
        </>
      }
    >
      {lastMinuteShare > 0.15 && lastMinuteAdr < data.adr && (
        <div className="mb-5">
          <Callout
            tone="amber"
            title={`Last-minute discounts cover ${pct(lastMinuteShare, 0)} of nights at ${czk(lastMinuteAdr)} — below the ${czk(data.adr)} average`}
          >
            Worth checking against the compression table on the Occupancy tab: the weekdays
            that sell out most often are also the ones a last-minute discount is most likely to
            land on. Discounting a night that was going to sell anyway is the most expensive
            promotion there is.
          </Callout>
        </div>
      )}

      <div style={{ height: 250 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="label" tick={{ ...AXIS_TICK, fontSize: 10 }} axisLine={false} tickLine={false} interval={0} angle={-18} textAnchor="end" height={54} />
            <YAxis
              yAxisId="share"
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
                name === 'Share' ? [`${value} % of nights`, 'Share'] : [czk(Number(value)), name]
              }
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <ReferenceLine
              yAxisId="money"
              y={Math.round(data.adr)}
              stroke="#9CA3AF"
              strokeDasharray="4 3"
              label={{ value: 'portfolio ADR', position: 'insideTopRight', fontSize: 10, fill: '#9CA3AF' }}
            />
            <Bar yAxisId="share" dataKey="Share" fill="#A5B4FC" radius={[5, 5, 0, 0]} maxBarSize={38} />
            <Line yAxisId="money" type="monotone" dataKey="ADR" stroke="#F59E0B" strokeWidth={2} dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="border-t border-gray-100 pt-4 mt-4">
        <MixTable rows={rows} portfolioAdr={data.adr} firstColumn="Promotion" />
      </div>
    </Card>
  );
}

// ── Rate plan mix ────────────────────────────────────────────────────────────

function PlanMix({ data }: { data: RatesResponse }) {
  const rows = data.planMix;
  if (rows.length === 0) return null;

  const risky = rows.filter((r) => r.nights >= 30 && r.cancellationRate > 0.25);

  return (
    <Card
      title="Rate plans"
      subtitle="The plan a booking sat on before any promotion rewrote it. Cancellation behaviour differs enormously between them, which matters more than the headline ADR."
    >
      {risky.length > 0 && (
        <div className="mb-5">
          <Callout tone="amber" title="Some plans cancel far more than others">
            {risky
              .map((r) => `${r.label} (${r.channel}) cancels ${pct(r.cancellationRate, 0)}`)
              .join('; ')}
            . A higher ADR on a plan that cancels a third of the time is not a higher ADR — the
            risk-adjusted view on the lead-time table above is the fair comparison.
          </Callout>
        </div>
      )}
      <MixTable rows={rows} portfolioAdr={data.adr} firstColumn="Rate plan" />
      {data.genius && <GeniusNote genius={data.genius} />}
    </Card>
  );
}

function GeniusNote({ genius }: { genius: NonNullable<RatesResponse['genius']> }) {
  return (
    <div className="mt-5 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
      <p className="text-xs font-semibold text-gray-700 mb-1">
        Booking.com Genius covers {pct(genius.geniusNightShare, 0)} of Booking.com nights
      </p>
      <p className="text-[11px] text-gray-600 leading-relaxed">
        {genius.comparable ? (
          <>
            Genius nights averaged {czk(genius.geniusAdr)} against {czk(genius.nonGeniusAdr)} for
            non-Genius —{' '}
            {genius.adrDelta === null
              ? 'no comparable gap'
              : `${genius.adrDelta > 0 ? '+' : '−'}${num(Math.abs(genius.adrDelta) * 100, 0)} %`}
            . Read that as a mix difference, not a discount measurement: the two groups differ in
            rate plan, lead time and stay dates as well as in Genius, so the gap is not the price
            of the programme on its own. At {pct(genius.geniusNightShare, 0)} penetration, Genius is
            effectively the standard rate on this channel.
          </>
        ) : (
          <>
            The ADR comparison is withheld: one side has fewer than{' '}
            {genius.minComparisonBookings} bookings, and a percentage computed off a handful of
            rows would read as a finding when it is noise.
          </>
        )}
      </p>
    </div>
  );
}

// ── Shared mix table ─────────────────────────────────────────────────────────

function MixTable({
  rows,
  portfolioAdr,
  firstColumn,
}: {
  rows: RatesResponse['planMix'];
  portfolioAdr: number;
  firstColumn: string;
}) {
  return (
    <Table
      columns={[firstColumn, 'Channel', 'Nights', 'Share', 'ADR', 'vs avg', 'LOS', 'Lead', 'Cancels']}
    >
      {rows.map((r) => (
        <tr key={`${r.label}|${r.channel}`} className="hover:bg-gray-50">
          <Td align="left">
            <span className="font-medium text-gray-800">{r.label}</span>
          </Td>
          <Td align="left" muted>
            {r.channel}
          </Td>
          <Td>{num(r.nights)}</Td>
          <Td muted>{pct(r.nightShare, 1)}</Td>
          <Td bold>{czk(r.adr)}</Td>
          <Td
            className={
              r.adrIndex > 0.02 ? '!text-emerald-600' : r.adrIndex < -0.02 ? '!text-rose-600' : ''
            }
          >
            {`${r.adrIndex > 0 ? '+' : '−'}${num(Math.abs(r.adrIndex) * 100, 0)} %`}
          </Td>
          <Td muted>{num(r.avgLengthOfStay, 1)}</Td>
          <Td muted>{num(r.avgLeadDays, 0)} d</Td>
          <Td className={r.cancellationRate > 0.3 ? '!text-rose-600' : ''}>
            {pct(r.cancellationRate, 0)}
          </Td>
        </tr>
      ))}
      <tr className="bg-gray-50/60">
        <Td align="left" bold>
          Portfolio
        </Td>
        <Td align="left" muted>
          all
        </Td>
        <Td bold>{num(rows.reduce((acc, r) => acc + r.nights, 0))}</Td>
        <Td muted>100 %</Td>
        <Td bold>{czk(portfolioAdr)}</Td>
        <Td muted>—</Td>
        <Td muted>—</Td>
        <Td muted>—</Td>
        <Td muted>—</Td>
      </tr>
    </Table>
  );
}

// ── Channel mix over time ────────────────────────────────────────────────────

/**
 * ADR against channel mix, month by month.
 *
 * The point of putting them on one chart: an ADR move is usually a mix move. If the
 * Booking.com share climbs nine points and ADR falls, the rate did not change — the
 * distribution did, and the fix is a distribution fix.
 */
function ChannelMixOverTime({ data }: { data: RatesResponse }) {
  const rows = data.mixMonthly;
  if (rows.length === 0) return null;

  const chartData = rows.map((m) => {
    const point: Record<string, string | number> = { month: monthShort(m.month), ADR: Math.round(m.adr) };
    for (const channel of data.channels) {
      point[channel] = Math.round((m.shares[channel] ?? 0) * 100);
    }
    return point;
  });

  return (
    <Card
      title="Channel mix against ADR"
      subtitle="Stacked share of nights per channel, with ADR over the top. An ADR move that lines up with a mix move is a distribution story, not a pricing one."
    >
      <div style={{ height: 280 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="month" tick={AXIS_TICK_DARK} axisLine={false} tickLine={false} />
            <YAxis
              yAxisId="share"
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
            {data.channels.map((channel, i) => (
              <Bar
                key={channel}
                yAxisId="share"
                dataKey={channel}
                stackId="mix"
                fill={SERIES_COLORS[i % SERIES_COLORS.length]}
                maxBarSize={44}
              />
            ))}
            <Line yAxisId="money" type="monotone" dataKey="ADR" stroke="#111827" strokeWidth={2} dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="border-t border-gray-100 pt-4 mt-4">
        <MixTable rows={data.channelMix} portfolioAdr={data.adr} firstColumn="Channel" />
      </div>
    </Card>
  );
}

// ── Stay length ──────────────────────────────────────────────────────────────

function StayLengthMix({ data }: { data: RatesResponse }) {
  if (data.losMix.length === 0) return null;
  const chartData = data.losMix.map((r) => ({
    label: r.label,
    Share: Math.round(r.nightShare * 100),
    ADR: Math.round(r.adr),
  }));

  return (
    <Card
      title="Stay length against ADR"
      subtitle="Length of stay moves ADR as much as any rate plan — longer stays buy a lower nightly rate, and they also lock a room out of the transient market for the whole span."
    >
      <div style={{ height: 220 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="label" tick={AXIS_TICK_DARK} axisLine={false} tickLine={false} />
            <YAxis
              yAxisId="share"
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
                name === 'Share' ? [`${value} % of nights`, 'Share'] : [czk(Number(value)), name]
              }
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar yAxisId="share" dataKey="Share" fill="#A5B4FC" radius={[5, 5, 0, 0]} maxBarSize={44} />
            <Line yAxisId="money" type="monotone" dataKey="ADR" stroke="#F59E0B" strokeWidth={2} dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

// ── Price position against the market ────────────────────────────────────────

/**
 * Where our live rate sits inside the market's asking-price distribution.
 *
 * LAST, AND HEDGED, ON PURPOSE. PriceLabs' comp set is scraped from Airbnb and VRBO.
 * Those are LISTED prices carrying roughly a 3% host fee, where our Booking.com-facing
 * rate has to absorb about 17% — so an identical net position shows up here as us
 * looking expensive. Booking.com-only listings, a real segment in Brno, are missing
 * from the distribution entirely.
 *
 * Read it as position and as a change detector, never as a target. The percentile a
 * rate sits at is not a number to optimise.
 */
function PricePosition({ market }: { market: MarketResponse | null }) {
  const units = market?.prices.filter((p) => p.points.some((pt) => pt.p50 !== null)) ?? [];
  const [unitId, setUnitId] = useState<string | null>(null);

  if (!market || units.length === 0) {
    return (
      <Card
        title="Price position against the market"
        subtitle="Appears once a PriceLabs market snapshot has been captured."
      >
        <Empty message="No market snapshot yet. The daily refresh writes one, or an admin can trigger it from the header." />
      </Card>
    );
  }

  const active = units.find((u) => u.unitId === unitId) ?? units[0];
  const HORIZON = 90;
  const points = active.points.slice(0, HORIZON);

  /**
   * The shaded band is drawn as two STACKED areas: an invisible base at p25 and a
   * visible span of (p90 − p25) on top. Layering one opaque area over another to
   * punch out the middle looks identical on a white card and breaks the moment the
   * card sits on any other background — and it puts a white swatch in the legend.
   */
  const chartData = points.map((p) => ({
    date: p.stayDate.slice(5),
    bandBase: p.p25 === null ? null : Math.round(p.p25),
    bandSpan: p.p25 === null || p.p90 === null ? null : Math.round(p.p90 - p.p25),
    'Market p50': p.p50 === null ? null : Math.round(p.p50),
    'Median booked': p.medianBooked === null ? null : Math.round(p.medianBooked),
    'Our live rate': p.live === null ? null : Math.round(p.live),
    Recommended: p.recommended === null ? null : Math.round(p.recommended),
  }));

  // Where our live rate sits, over the nights where both numbers exist.
  const banded = points.filter((p) => p.live !== null && p.p50 !== null && p.p90 !== null);
  const above90 = banded.filter((p) => p.live! > p.p90!).length;
  const mid = banded.filter((p) => p.live! >= p.p50! && p.live! <= p.p90!).length;
  const below50 = banded.filter((p) => p.live! < p.p50!).length;

  return (
    <Card
      title="Price position against the market"
      subtitle={
        <>
          Our live Beds24 rate inside the comp set&apos;s asking-price distribution for the next{' '}
          {HORIZON} nights. Nights already sold have no live rate, so the line has gaps — those
          are bookings, not missing data.
        </>
      }
      actions={
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          {units.map((u) => (
            <button
              key={u.unitId}
              onClick={() => setUnitId(u.unitId)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                active.unitId === u.unitId
                  ? 'bg-white shadow-sm text-indigo-700'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {u.shortLabel}
            </button>
          ))}
        </div>
      }
    >
      <div className="mb-5">
        <Callout tone="slate" title="What this can and cannot tell you">
          The comp set is Airbnb and VRBO listings. Those are listed prices carrying about a 3%
          host fee, while our Booking.com-facing rate absorbs roughly 17% — so the same net
          position makes us look dearer here than we are, and Booking.com-only competitors are
          absent altogether. Useful as position and as a change detector; not a target. The
          occupancy comparison above is the trustworthy half of this dataset.
        </Callout>
      </div>

      {banded.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <Tile
            label="Above market p90"
            tone={above90 / banded.length > 0.5 ? 'rose' : 'slate'}
            value={pct(above90 / banded.length, 0)}
            hint={`${num(above90)} of ${num(banded.length)} open nights`}
          />
          <Tile
            label="Between p50 and p90"
            tone="emerald"
            value={pct(mid / banded.length, 0)}
            hint="the usual place to sit"
          />
          <Tile
            label="Below market median"
            tone={below50 / banded.length > 0.3 ? 'amber' : 'slate'}
            value={pct(below50 / banded.length, 0)}
            hint={`${num(below50)} nights priced under p50`}
          />
        </div>
      )}

      <div style={{ height: 300 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ ...AXIS_TICK, fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              interval={Math.max(1, Math.floor(chartData.length / 14))}
            />
            <YAxis tickFormatter={czkAxis} tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} />
            <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value, name) => [czk(Number(value)), name]} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Area
              type="monotone"
              dataKey="bandBase"
              stackId="band"
              stroke="none"
              fill="none"
              legendType="none"
              tooltipType="none"
              connectNulls
            />
            <Area
              type="monotone"
              dataKey="bandSpan"
              stackId="band"
              name="Market p25–p90"
              stroke="none"
              fill="#E0E7FF"
              fillOpacity={0.85}
              legendType="rect"
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="Market p50"
              stroke="#94A3B8"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="Median booked"
              stroke="#10B981"
              strokeWidth={1.5}
              dot={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="Recommended"
              stroke="#F59E0B"
              strokeWidth={1.5}
              strokeDasharray="2 2"
              dot={false}
              connectNulls
            />
            <Line type="monotone" dataKey="Our live rate" stroke="#4F46E5" strokeWidth={2.5} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">
        Shaded band spans the market 25th to 90th percentile.{' '}
        <span className="text-emerald-600">Median booked</span> is what comps that actually sold
        the night charged — a better reference than asking prices.{' '}
        <span className="text-amber-600">Recommended</span> is PriceLabs&apos; own suggestion for
        us. Benchmark drawn from {active.bedrooms}-bedroom comps
        {market.byUnit.find((u) => u.unitId === active.unitId)?.compSetListings
          ? `, ${num(market.byUnit.find((u) => u.unitId === active.unitId)!.compSetListings!)} listings`
          : ''}
        .
      </p>
    </Card>
  );
}

'use client';
/**
 * Occupancy — how full each room class ran, against the market, and whether that
 * occupancy turned into gross profit.
 *
 * EVERY VIEW IS SPLIT BY ROOM CLASS. The 1KK studios and the 2KK apartments sell
 * at different rates in different seasons; a blended figure hides both.
 *
 * ORDER IS THE ARGUMENT:
 *   1. the class scorecard — occupancy in room-nights, market, RevPAR, GP;
 *   2. occupancy against the market, by month and on the books ahead;
 *   3. occupancy against gross profit — a 90% month bought with cheap rates can
 *      earn less than an 80% one, so GP per available night sits next to
 *      occupancy, and same-month room pairs show which way it actually went;
 *   4. length of stay — weekly stays are discounted but fill every night and
 *      cost one turnover; they are compared with sibling rooms over the same
 *      nights;
 *   5. the room × month grid to drill into any of the above;
 *   6. where each class ran out of rooms.
 */
import { useState, type ReactNode } from 'react';
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import type {
  ClassMonthPoint,
  ClassScorecard,
  ClassSoldOut,
  LongStayDuel,
  MarketResponse,
  OccSlice,
  OccupancyClassId,
  OccupancyClassInfo,
  OccupancyResponse,
} from '@/utils/analyticsTypes';
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
  monthLabel,
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

/** Class hues follow the room families: cool studios, warm apartments. */
const CLASS_COLORS: Record<OccupancyClassId, string> = { '1kk': '#0EA5E9', '2kk': '#F59E0B' };
const MARKET_COLOR = '#94A3B8';
const PROFIT_COLOR = '#10B981';
const OCC_COLOR = '#6366F1';
/** Comp sets smaller than this are flagged as thin. */
const THIN_COMP_SET = 25;

// ── Formatting helpers ───────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-04" → "4 Oct". */
function shortDate(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1] ?? ''}`;
}

/** Signed money: "+87 Kč", "−574 Kč". */
function signedCzk(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) return czk(0);
  return `${rounded > 0 ? '+' : '−'}${czk(Math.abs(rounded))}`;
}

/** Signed percentage points: "+8 pp". */
function signedPp(value: number): string {
  const pp = Math.round(value * 100);
  return `${pp > 0 ? '+' : pp < 0 ? '−' : ''}${Math.abs(pp)} pp`;
}

/** Axis ticks for per-night money: full numbers below 10 000 (kit's czkAxis
 *  rounds 1 650 and 2 200 both to "2 k"). */
const perNightAxis = (value: number): string =>
  Math.abs(value) >= 10_000 ? czkAxis(value) : Math.round(value).toLocaleString('cs-CZ');

const deltaTone = (value: number) =>
  Math.abs(value) < 0.5 ? 'text-gray-500' : value > 0 ? 'text-emerald-600' : 'text-rose-600';

function ClassTag({ info, compact = false }: { info: OccupancyClassInfo; compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 flex-wrap">
      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: CLASS_COLORS[info.id] }} />
      <span className="font-semibold text-gray-800">{info.label}</span>
      {!compact && <span className="text-[11px] text-gray-400">{info.rooms.join(' · ')}</span>}
    </span>
  );
}

function SubHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
      {children && <p className="text-xs text-gray-500 mt-1 max-w-3xl leading-relaxed">{children}</p>}
    </div>
  );
}

function classInfo(data: OccupancyResponse, id: OccupancyClassId): OccupancyClassInfo {
  return data.classes.find((c) => c.id === id) ?? { id, label: id.toUpperCase(), description: '', rooms: [] };
}

/** One sentence on what the gross-profit figures cover, reused under each view. */
function profitScope(data: OccupancyResponse): string {
  const { costsFrom } = data.profitCoverage;
  const from = costsFrom && costsFrom > data.query.from ? ` from ${shortDate(costsFrom)} ${costsFrom.slice(0, 4)}` : '';
  return `Gross profit = net sales (after OTA commission and payment fees) minus cleaning, laundry, consumables, wear & tear and misc; fixed subscriptions are left out. It covers nights already slept${from}, when cost logging was running.`;
}

// ── Section ──────────────────────────────────────────────────────────────────

export default function OccupancySection({
  data,
}: {
  data: OccupancyResponse;
  /** Accepted for the shared section signature; this tab reads its own market data. */
  market?: MarketResponse | null;
}) {
  if (data.classes.length === 0) {
    return (
      <Card title="Occupancy">
        <Empty message="No rooms in the current filter." />
      </Card>
    );
  }
  return (
    <>
      {data.notes.length > 0 && (
        <div className="space-y-2">
          {data.notes.map((note) => (
            <Callout key={note} tone="amber">
              {note}
            </Callout>
          ))}
        </div>
      )}
      <Scorecard data={data} />
      <MarketView data={data} />
      <ProfitView data={data} />
      <StayLengthView data={data} />
      <RoomMonthGrid data={data} />
      <SoldOutView data={data} />
      <Callout tone={data.confidence.partialYear ? 'amber' : 'sky'} title="How far to trust this">
        {data.confidence.message}
      </Callout>
    </>
  );
}

// ── 1. Scorecard ─────────────────────────────────────────────────────────────

function Scorecard({ data }: { data: OccupancyResponse }) {
  const classRows = data.scorecard.filter((r) => r.classId !== 'all');
  return (
    <Card
      title="Room classes at a glance"
      subtitle={
        <>
          Studios (1KK) and two-bedroom apartments (2KK) sell at different rates in different
          seasons, so every figure on this tab is split by class. Occupancy is counted in
          room-nights — rooms on sale × nights — so five studios over three months are about 460
          room-nights.
        </>
      }
    >
      <div className={`grid gap-6 ${classRows.length > 1 ? 'lg:grid-cols-2' : ''}`}>
        {classRows.map((row) => (
          <ClassPanel key={row.classId} row={row} info={classInfo(data, row.classId as OccupancyClassId)} />
        ))}
      </div>

      <div className="border-t border-gray-100 pt-4 mt-6">
        <Table
          columns={[
            'Class',
            'Room-nights sold',
            'Occupancy',
            'Market',
            'MPI',
            'ADR',
            'RevPAR',
            'Net RevPAR',
            'GP / avail. night',
            'Gross profit',
            'Subscriptions',
            'GP after subs',
          ]}
        >
          {data.scorecard.map((row) => {
            const s = row.slice;
            const isAll = row.classId === 'all';
            return (
              <tr key={row.classId} className={isAll ? 'bg-gray-50/60' : 'hover:bg-gray-50'}>
                <Td align="left" bold={isAll}>
                  {isAll ? 'All rooms' : <ClassTag info={classInfo(data, row.classId as OccupancyClassId)} compact />}
                </Td>
                <Td>
                  {num(s.soldNights)} <span className="text-gray-400">/ {num(s.availableNights)}</span>
                </Td>
                <Td bold>{pct(s.occupancy, 1)}</Td>
                <Td muted>{row.market.occupancy === null ? '—' : pct(row.market.occupancy, 0)}</Td>
                <Td>{row.market.mpi === null ? '—' : num(row.market.mpi, 2)}</Td>
                <Td>{czk(s.adr)}</Td>
                <Td>{czk(s.revpar)}</Td>
                <Td>{czk(s.netRevpar)}</Td>
                <Td bold className="!text-emerald-700">
                  {s.profit ? czk(s.profit.perAvailableNight) : '—'}
                </Td>
                <Td>{s.profit ? czk(s.profit.grossProfit) : '—'}</Td>
                <Td muted>{row.subscriptions === null ? '—' : czk(row.subscriptions)}</Td>
                <Td>{row.grossProfitAfterSubscriptions === null ? '—' : czk(row.grossProfitAfterSubscriptions)}</Td>
              </tr>
            );
          })}
        </Table>
      </div>

      <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">
        <strong className="font-medium text-gray-500">RevPAR</strong> = room revenue ÷ room-nights on
        sale = occupancy × ADR. <strong className="font-medium text-gray-500">Net RevPAR</strong> takes
        off OTA commission and payment fees.{' '}
        <strong className="font-medium text-gray-500">GP / avail. night</strong> = gross profit ÷
        room-nights on sale — the figure that settles whether a fuller period was actually a better
        one, because it pays for the extra turnovers and discounts that bought the occupancy.{' '}
        {profitScope(data)} Subscriptions are shown separately, pro-rated by day.{' '}
        <strong className="font-medium text-gray-500">MPI</strong> = our occupancy ÷ the comp set&rsquo;s
        (1.00 = market).
      </p>
    </Card>
  );
}

function ClassPanel({ row, info }: { row: ClassScorecard; info: OccupancyClassInfo }) {
  const s = row.slice;
  const m = row.market;
  return (
    <div>
      <div className="mb-3">
        <ClassTag info={info} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Tile
          label="Occupancy"
          tone="indigo"
          value={pct(s.occupancy, 0)}
          hint={`${num(s.soldNights)} of ${num(s.availableNights)} room-nights`}
        />
        <Tile
          label="Against the market"
          tone="sky"
          value={m.mpi === null ? '—' : `MPI ${num(m.mpi, 2)}`}
          hint={
            m.occupancy === null
              ? 'no market data for this window'
              : `market ${pct(m.occupancy, 0)} · we are ${signedPp(s.occupancy - m.occupancy)}`
          }
        />
        <Tile
          label="RevPAR"
          tone="violet"
          value={czk(s.revpar)}
          hint={`ADR ${czk(s.adr)} × ${pct(s.occupancy, 0)} occupancy`}
        />
        <Tile
          label="GP / available night"
          tone="emerald"
          value={s.profit ? czk(s.profit.perAvailableNight) : '—'}
          hint={s.profit ? `${czk(s.profit.grossProfit)} gross profit` : 'no costed nights in this window'}
        />
      </div>
    </div>
  );
}

// ── 2. Market ────────────────────────────────────────────────────────────────

function MarketView({ data }: { data: OccupancyResponse }) {
  const hasMarket = data.monthly.some((m) => m.points.some((p) => p.market.occupancy !== null));
  return (
    <Card
      title="Occupancy against the market"
      subtitle={
        <>
          Our occupancy per class against the Brno comp set for the same class — studios against
          one-bedroom listings, the apartments against two-bedroom ones. Market ADR is context only:
          those are Airbnb-listed prices, which carry a different fee load than our
          Booking.com-facing rates.
          {data.market.capturedAt && (
            <> Market snapshot {new Date(data.market.capturedAt).toLocaleDateString('cs-CZ')}.</>
          )}
        </>
      }
    >
      {!hasMarket && (
        <div className="mb-5">
          <Callout tone="slate" title={data.market.configured ? 'No market data for this window' : 'No market key configured'}>
            {data.market.configured
              ? 'The PriceLabs snapshot holds no comp-set occupancy for these months.'
              : 'Set PRICELABS_API_KEY and the comparison appears here. Our own figures are unaffected.'}
          </Callout>
        </div>
      )}

      <div className={`grid gap-8 ${data.monthly.length > 1 ? 'lg:grid-cols-2' : ''}`}>
        {data.monthly.map((m) => (
          <ClassMarketMonthly key={m.classId} info={classInfo(data, m.classId)} points={m.points} />
        ))}
      </div>

      <ForwardTable data={data} />

      <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">
        {data.market.source}. Market occupancy is weighted by our own room-nights on sale in each
        listing, so three Urban studios weigh three times one apartment. The comp set is scraped
        from Airbnb and VRBO, not Booking.com — occupancy holds up regardless (a channel manager
        blocks every calendar whichever channel books), prices do not.
      </p>
    </Card>
  );
}

function ClassMarketMonthly({ info, points }: { info: OccupancyClassInfo; points: ClassMonthPoint[] }) {
  if (points.length === 0) {
    return (
      <div>
        <ClassTag info={info} />
        <Empty />
      </div>
    );
  }
  const chartData = points.map((p) => ({
    month: monthShort(p.month),
    fullMonth: p.month,
    Ours: Math.round(p.slice.occupancy * 100),
    Market: p.market.occupancy === null ? null : Math.round(p.market.occupancy * 100),
    partial: p.partial,
  }));
  return (
    <div>
      <div className="mb-2">
        <ClassTag info={info} />
      </div>
      <div style={{ height: 220 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="month" tick={AXIS_TICK_DARK} axisLine={false} tickLine={false} />
            <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={AXIS_TICK} axisLine={false} tickLine={false} width={44} />
            <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value, name) => [`${value} %`, name]} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="Ours" fill={CLASS_COLORS[info.id]} radius={[5, 5, 0, 0]} maxBarSize={36}>
              {chartData.map((d) => (
                <Cell key={d.fullMonth} fill={CLASS_COLORS[info.id]} fillOpacity={d.partial ? 0.45 : 1} />
              ))}
            </Bar>
            <Line type="monotone" dataKey="Market" stroke={MARKET_COLOR} strokeWidth={2} strokeDasharray="5 3" dot={{ r: 2 }} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3">
        <Table columns={['Month', 'Ours', 'Market', 'MPI', 'Our ADR', 'Market ADR']}>
          {points.map((p) => (
            <tr key={p.month} className="hover:bg-gray-50">
              <Td align="left">
                {monthLabel(p.month)}
                {p.partial && <Provisional />}
              </Td>
              <Td bold>{pct(p.slice.occupancy, 0)}</Td>
              <Td muted>{p.market.occupancy === null ? '—' : pct(p.market.occupancy, 0)}</Td>
              <Td className={mpiTone(p.market.mpi)}>{p.market.mpi === null ? '—' : num(p.market.mpi, 2)}</Td>
              <Td>{p.slice.soldNights > 0 ? czk(p.slice.adr) : '—'}</Td>
              <Td muted>{p.market.adr === null ? '—' : czk(p.market.adr)}</Td>
            </tr>
          ))}
        </Table>
      </div>
    </div>
  );
}

function mpiTone(mpi: number | null): string {
  if (mpi === null) return '!text-gray-300';
  if (mpi >= 1.2) return '!text-emerald-600 font-semibold';
  if (mpi < 0.9) return '!text-rose-600';
  return '';
}

function ForwardTable({ data }: { data: OccupancyResponse }) {
  const horizons = data.forward[0]?.horizons ?? [];
  if (horizons.length === 0) return null;
  return (
    <div className="border-t border-gray-100 pt-6 mt-6">
      <SubHeading title="On the books from today, against the market">
        Nights already sold over each horizon (all channels, whatever the filter) against the
        comp set&rsquo;s. Leading near in and trailing far out means we win late demand and cede
        early demand — fine as a choice, worth knowing if it is an accident.
      </SubHeading>
      <Table columns={['Class', 'Comps', ...horizons.map((h) => `${h.horizonDays} days`)]}>
        {data.forward.map((f) => (
          <tr key={f.classId} className="hover:bg-gray-50">
            <Td align="left">
              <ClassTag info={classInfo(data, f.classId)} compact />
            </Td>
            <Td muted>
              {f.compSetListings === null ? '—' : num(f.compSetListings)}
              {f.compSetListings !== null && f.compSetListings < THIN_COMP_SET && (
                <span className="text-amber-500" title="Thin comp set — treat this row's benchmark with caution">
                  {' '}
                  ⚠
                </span>
              )}
            </Td>
            {f.horizons.map((h) => (
              <Td key={h.horizonDays}>
                <span className="font-semibold text-gray-900">{pct(h.ourOccupancy, 0)}</span>
                <span className="text-gray-400"> / {h.marketOccupancy === null ? '—' : pct(h.marketOccupancy, 0)}</span>
                <span className={`block text-[11px] ${mpiTone(h.mpi)}`}>{h.mpi === null ? '' : `MPI ${num(h.mpi, 2)}`}</span>
              </Td>
            ))}
          </tr>
        ))}
      </Table>
      <p className="text-[11px] text-gray-400 mt-2">Each cell: ours / market. Comps = listings in the benchmark; under {THIN_COMP_SET} is flagged.</p>
    </div>
  );
}

// ── 3. Occupancy vs gross profit ─────────────────────────────────────────────

function ProfitView({ data }: { data: OccupancyResponse }) {
  if (!data.profitCoverage.costsAvailable) {
    return (
      <Card title="Occupancy vs gross profit">
        <Callout tone="slate">
          Stay costs are not available in this environment, so gross profit cannot be shown.
          Occupancy, ADR and RevPAR above are unaffected.
        </Callout>
      </Card>
    );
  }
  return (
    <Card
      title="Occupancy vs gross profit"
      subtitle={
        <>
          Occupancy is only half of RevPAR (occupancy × ADR), and RevPAR is before commission and
          cleaning. A month filled with discounted stays can be fuller and still earn less, so
          each month shows gross profit per available night next to its occupancy. {profitScope(data)}
        </>
      }
    >
      <div className={`grid gap-8 ${data.monthly.length > 1 ? 'lg:grid-cols-2' : ''}`}>
        {data.monthly.map((m) => (
          <ClassProfitMonthly key={m.classId} info={classInfo(data, m.classId)} points={m.points} />
        ))}
      </div>

      <div className="border-t border-gray-100 pt-6 mt-6">
        <SubHeading title="Same class, same month — does the fuller room earn more?">
          Each dot is one room in one month: occupancy across, gross profit per available night up.
          Rooms of a class in the same month faced the same season and the same market, so when one
          is fuller but lower, the occupancy was bought with price or stay mix. The verdict counts
          every same-month pair at least {Math.round((data.sameMonthPairs[0]?.minOccupancyGap ?? 0.05) * 100)} pp
          apart in occupancy (rooms with 14+ costed nights on sale).
        </SubHeading>
        <div className={`grid gap-8 ${data.classes.length > 1 ? 'lg:grid-cols-2' : ''}`}>
          {data.classes.map((c) => (
            <ClassScatter key={c.id} data={data} info={c} />
          ))}
        </div>
      </div>
    </Card>
  );
}

function ClassProfitMonthly({ info, points }: { info: OccupancyClassInfo; points: ClassMonthPoint[] }) {
  const costed = points.filter((p) => p.slice.profit && p.slice.profit.availableNights > 0);
  if (costed.length === 0) {
    return (
      <div>
        <ClassTag info={info} />
        <Empty message="No costed nights for this class in the window." />
      </div>
    );
  }

  // Fullest month vs most profitable month — the direct answer to "is fuller better".
  const solid = costed.filter((p) => (p.slice.profit?.availableNights ?? 0) >= 20);
  const fullest = [...solid].sort((a, b) => b.slice.occupancy - a.slice.occupancy)[0];
  const richest = [...solid].sort(
    (a, b) => (b.slice.profit?.perAvailableNight ?? 0) - (a.slice.profit?.perAvailableNight ?? 0),
  )[0];
  const bestMonth = richest?.month;

  const chartData = points.map((p) => ({
    month: monthShort(p.month),
    fullMonth: p.month,
    'GP / avail. night': p.slice.profit ? Math.round(p.slice.profit.perAvailableNight) : null,
    Occupancy: Math.round(p.slice.occupancy * 100),
    partial: p.partial,
  }));

  return (
    <div>
      <div className="mb-2">
        <ClassTag info={info} />
      </div>
      {fullest && richest && fullest.month !== richest.month && (
        <p className="text-xs text-gray-600 mb-3 leading-relaxed">
          The fullest month, {monthLabel(fullest.month)} at {pct(fullest.slice.occupancy, 0)}, earned{' '}
          <strong>{czk(fullest.slice.profit!.perAvailableNight)}</strong> per available night; the most
          profitable, {monthLabel(richest.month)} at {pct(richest.slice.occupancy, 0)}, earned{' '}
          <strong className="text-emerald-700">{czk(richest.slice.profit!.perAvailableNight)}</strong> — on an ADR of{' '}
          {czk(richest.slice.adr)} against {czk(fullest.slice.adr)}.
        </p>
      )}
      <div style={{ height: 230 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="month" tick={AXIS_TICK_DARK} axisLine={false} tickLine={false} />
            <YAxis yAxisId="money" tickFormatter={perNightAxis} tick={AXIS_TICK} axisLine={false} tickLine={false} width={44} />
            <YAxis
              yAxisId="occ"
              orientation="right"
              domain={[0, 100]}
              tickFormatter={(v) => `${v}%`}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={40}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value, name) => (name === 'Occupancy' ? [`${value} %`, name] : [czk(Number(value)), name])}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar yAxisId="money" dataKey="GP / avail. night" fill={PROFIT_COLOR} radius={[5, 5, 0, 0]} maxBarSize={36}>
              {chartData.map((d) => (
                <Cell key={d.fullMonth} fill={PROFIT_COLOR} fillOpacity={d.partial ? 0.45 : 1} />
              ))}
            </Bar>
            <Line yAxisId="occ" type="monotone" dataKey="Occupancy" stroke={OCC_COLOR} strokeWidth={2} dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3">
        <Table columns={['Month', 'Occupancy', 'ADR', 'RevPAR', 'GP / avail. night', 'Avg stay']}>
          {points.map((p) => {
            const best = p.month === bestMonth;
            return (
              <tr key={p.month} className="hover:bg-gray-50">
                <Td align="left">
                  {monthLabel(p.month)}
                  {p.partial && <Provisional />}
                </Td>
                <Td>{pct(p.slice.occupancy, 0)}</Td>
                <Td>{p.slice.soldNights > 0 ? czk(p.slice.adr) : '—'}</Td>
                <Td>{czk(p.slice.revpar)}</Td>
                <Td bold={best} className={best ? '!text-emerald-700' : ''}>
                  {p.slice.profit ? czk(p.slice.profit.perAvailableNight) : '—'}
                </Td>
                <Td muted>{p.slice.stays > 0 ? `${num(p.slice.avgLos, 1)} n` : '—'}</Td>
              </tr>
            );
          })}
        </Table>
      </div>
    </div>
  );
}

interface ScatterPoint {
  x: number;
  y: number;
  room: string;
  month: string;
  adr: number;
  nights: number;
  avgLos: number;
}

function ClassScatter({ data, info }: { data: OccupancyResponse; info: OccupancyClassInfo }) {
  const cells = data.roomMonths.filter(
    (r) => r.classId === info.id && r.slice.profit && r.slice.profit.availableNights >= 7,
  );
  const summary = data.sameMonthPairs.find((p) => p.classId === info.id);
  if (cells.length === 0) {
    return (
      <div>
        <ClassTag info={info} />
        <Empty message="No costed room-months in this window." />
      </div>
    );
  }
  const byRoom = info.rooms.map((room) => ({
    room,
    points: cells
      .filter((c) => c.room === room)
      .map<ScatterPoint>((c) => ({
        x: Math.round(c.slice.profit!.occupancy * 1000) / 10,
        y: Math.round(c.slice.profit!.perAvailableNight),
        room,
        month: c.month,
        adr: c.slice.profit!.adr,
        nights: c.slice.profit!.availableNights,
        avgLos: c.slice.avgLos,
      })),
  }));
  const xs = cells.map((c) => c.slice.profit!.occupancy * 100);
  const xMin = Math.max(0, Math.floor((Math.min(...xs) - 5) / 10) * 10);

  return (
    <div>
      <div className="mb-2">
        <ClassTag info={info} />
      </div>
      <div style={{ height: 250 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
            <CartesianGrid stroke={GRID_STROKE} />
            <XAxis
              type="number"
              dataKey="x"
              name="Occupancy"
              domain={[xMin, 100]}
              tickFormatter={(v) => `${v}%`}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              type="number"
              dataKey="y"
              name="GP / avail. night"
              tickFormatter={perNightAxis}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={44}
            />
            <ZAxis range={[70, 70]} />
            <Tooltip
              cursor={{ strokeDasharray: '3 3' }}
              content={({ active, payload }) => {
                const p = active ? (payload?.[0]?.payload as ScatterPoint | undefined) : undefined;
                if (!p) return null;
                return (
                  <div className="bg-white rounded-lg border border-gray-200 shadow-sm px-3 py-2 text-xs">
                    <p className="font-semibold text-gray-800">
                      {p.room} · {monthLabel(p.month)}
                    </p>
                    <p className="text-gray-600">
                      {num(p.x, 0)} % occupancy · ADR {czk(p.adr)}
                    </p>
                    <p className="text-emerald-700 font-medium">{czk(p.y)} GP per available night</p>
                    <p className="text-gray-400">
                      avg stay {num(p.avgLos, 1)} n · {p.nights} nights on sale
                    </p>
                  </div>
                );
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {byRoom
              .filter((r) => r.points.length > 0)
              .map((r) => (
                <Scatter key={r.room} name={r.room} data={r.points} fill={ROOM_COLORS[r.room] ?? '#94A3B8'} />
              ))}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      {summary && <PairVerdict summary={summary} />}
    </div>
  );
}

function PairVerdict({ summary }: { summary: OccupancyResponse['sameMonthPairs'][number] }) {
  if (summary.pairs === 0) {
    return (
      <p className="text-xs text-gray-500 mt-2">
        No same-month room pairs far enough apart in occupancy to compare yet.
      </p>
    );
  }
  const mostly = summary.fullerEarnedMore / summary.pairs;
  return (
    <div className="mt-3">
      <Callout tone={mostly >= 0.7 ? 'sky' : mostly <= 0.4 ? 'rose' : 'amber'}>
        In <strong>{summary.fullerEarnedMore} of {summary.pairs}</strong> same-month pairs the fuller room
        also earned more gross profit per available night. On average the fuller room ran{' '}
        {signedPp(summary.avgOccupancyGap)} occupancy at an ADR {summary.avgAdrGap >= 0 ? '+' : '−'}
        {num(Math.abs(summary.avgAdrGap) * 100, 0)} % and made {signedCzk(summary.avgProfitGap)} per
        available night.
        {summary.counterExamples.length > 0 && (
          <span className="block mt-2">
            Where the emptier room won:
            {summary.counterExamples.map((c) => (
              <span key={`${c.month}-${c.fuller.room}-${c.emptier.room}`} className="block">
                {monthShort(c.month)} {c.month.slice(0, 4)} — {c.fuller.room} {pct(c.fuller.occupancy, 0)} at{' '}
                {czk(c.fuller.adr)} → {czk(c.fuller.perAvailableNight)}, vs {c.emptier.room}{' '}
                {pct(c.emptier.occupancy, 0)} at {czk(c.emptier.adr)} → {czk(c.emptier.perAvailableNight)}
              </span>
            ))}
          </span>
        )}
      </Callout>
    </div>
  );
}

// ── 4. Length of stay ────────────────────────────────────────────────────────

function StayLengthView({ data }: { data: OccupancyResponse }) {
  if (!data.profitCoverage.costsAvailable) return null;
  const longMin = data.longStayMinNights;
  return (
    <Card
      title="Length of stay vs gross profit"
      subtitle={
        <>
          Weekly stays ({longMin}+ nights) sell at a discount, but they fill every night and pay for
          one cleaning, laundry and consumables set. Two views: what a sold night earns by stay
          length, and — the real test — what the room earned against its sibling rooms of the same
          class over exactly the same dates, empty nights and extra turnovers included.{' '}
          {profitScope(data)}
        </>
      }
    >
      <div className={`grid gap-8 ${data.losEconomics.length > 1 ? 'lg:grid-cols-2' : ''}`}>
        {data.losEconomics.map((l) => {
          const best = [...l.buckets].sort((a, b) => b.profitPerNight - a.profitPerNight)[0];
          return (
            <div key={l.classId}>
              <div className="mb-2">
                <ClassTag info={classInfo(data, l.classId)} />
              </div>
              {l.buckets.length === 0 ? (
                <Empty message="No costed nights for this class in the window." />
              ) : (
                <Table columns={['Stay length', 'Stays', 'Nights', 'ADR', 'Net ADR', 'Turnover / night', 'GP / sold night']}>
                  {l.buckets.map((b) => (
                    <tr key={b.label} className="hover:bg-gray-50">
                      <Td align="left">{b.label}</Td>
                      <Td muted>{num(b.stays)}</Td>
                      <Td muted>{num(b.nights)}</Td>
                      <Td>{czk(b.adr)}</Td>
                      <Td>{czk(b.netAdr)}</Td>
                      <Td muted>−{czk(b.turnoverCostPerNight)}</Td>
                      <Td bold={b === best} className={b === best ? '!text-emerald-700' : ''}>
                        {czk(b.profitPerNight)}
                      </Td>
                    </tr>
                  ))}
                </Table>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">
        GP / sold night = net ADR minus the stay&rsquo;s own turnover, spread over its nights. It says what a
        night earns once sold — not whether it would have sold: a discounted week can win here and
        still lose to two short stays that kept the room just as full. That is what the comparison
        below measures.
      </p>

      <div className="border-t border-gray-100 pt-6 mt-6">
        <SubHeading title={`Long stays against sibling rooms, over the same nights`}>
          Each {longMin}+ night stay against the other rooms of its class on exactly the nights it
          covered: its gross profit per night against theirs per available night — so their empty
          nights and extra cleanings count. Sibling rooms that held a long stay of their own on those
          dates are left out, so this is long stay against short stays.
        </SubHeading>
        <DuelSummary data={data} />
        <DuelTable data={data} />
      </div>
    </Card>
  );
}

function DuelSummary({ data }: { data: OccupancyResponse }) {
  const rows = data.longStaySummary.filter((s) => s.duels > 0);
  if (rows.length === 0) return null;
  return (
    <div className={`grid gap-3 mb-5 ${rows.length > 1 ? 'sm:grid-cols-2' : ''}`}>
      {rows.map((s) => (
        <div key={s.classId} className="rounded-xl bg-gray-50 p-4">
          <ClassTag info={classInfo(data, s.classId)} compact />
          <p className="text-sm text-gray-700 mt-2 leading-relaxed">
            Long stays out-earned their siblings in{' '}
            <strong>
              {s.won} of {s.duels}
            </strong>{' '}
            comparisons. Across {num(s.nights)} nights they made{' '}
            <strong className={deltaTone(s.avgDeltaPerNight)}>{signedCzk(s.avgDeltaPerNight)}</strong> per night
            against the sibling rooms — <strong className={deltaTone(s.totalDelta)}>{signedCzk(s.totalDelta)}</strong>{' '}
            in total.
          </p>
        </div>
      ))}
    </div>
  );
}

function DuelTable({ data }: { data: OccupancyResponse }) {
  const duels = data.longStayDuels;
  if (duels.length === 0) {
    return (
      <Empty
        message={`No ${data.longStayMinNights}+ night stays with a short-stay sibling to compare against in this window.`}
      />
    );
  }
  return (
    <Table columns={['Long stay', 'Nights compared', 'Its GP / night', 'Siblings', 'Their GP / avail. night', 'Difference']}>
      {duels.map((d) => (
        <DuelRow key={d.reservationNumber} duel={d} />
      ))}
    </Table>
  );
}

function DuelRow({ duel: d }: { duel: LongStayDuel }) {
  return (
    <tr className="hover:bg-gray-50 align-top">
      <Td align="left">
        <span className="font-medium text-gray-800">{d.rooms.join(' → ')}</span>
        <span className="block text-[11px] text-gray-400">
          {d.reservationNumber} · {d.channel} · {d.stayNights} nights, {shortDate(d.checkIn)}–{shortDate(d.checkOut)}
        </span>
      </Td>
      <Td>
        {d.nights}
        <span className="block text-[11px] text-gray-400">
          {shortDate(d.from)}–{shortDate(d.to)}
        </span>
      </Td>
      <Td>
        <span className="font-semibold text-gray-900">{czk(d.profitPerNight)}</span>
        <span className="block text-[11px] text-gray-400">ADR {czk(d.adr)} · 100 % full</span>
      </Td>
      <Td>
        {d.siblings.rooms.join(', ')}
        <span className="block text-[11px] text-gray-400">
          {pct(d.siblings.occupancy, 0)} full · ADR {d.siblings.adr > 0 ? czk(d.siblings.adr) : '—'} · {d.siblings.stays} stays
        </span>
      </Td>
      <Td>{czk(d.siblings.profitPerAvailableNight)}</Td>
      <Td>
        <span className={`font-semibold ${deltaTone(d.deltaPerNight)}`}>{signedCzk(d.deltaPerNight)}</span>
        <span className={`block text-[11px] ${deltaTone(d.deltaTotal)}`}>{signedCzk(d.deltaTotal)} total</span>
      </Td>
    </tr>
  );
}

// ── 5. Room × month grid ─────────────────────────────────────────────────────

type GridMetric = 'occupancy' | 'adr' | 'revpar' | 'profit' | 'avgLos' | 'longStayShare';

const compactKc = (v: number) => Math.round(v).toLocaleString('cs-CZ');

const GRID_METRICS: Record<
  GridMetric,
  { label: string; get: (s: OccSlice) => number | null; format: (v: number) => string }
> = {
  occupancy: { label: 'Occupancy', get: (s) => (s.availableNights > 0 ? s.occupancy : null), format: (v) => pct(v, 0) },
  adr: { label: 'ADR', get: (s) => (s.soldNights > 0 ? s.adr : null), format: compactKc },
  revpar: { label: 'RevPAR', get: (s) => (s.availableNights > 0 ? s.revpar : null), format: compactKc },
  profit: {
    label: 'GP / avail. night',
    get: (s) => (s.profit && s.profit.availableNights > 0 ? s.profit.perAvailableNight : null),
    format: compactKc,
  },
  avgLos: { label: 'Avg stay', get: (s) => (s.stays > 0 ? s.avgLos : null), format: (v) => num(v, 1) },
  longStayShare: { label: 'Weekly-stay share', get: (s) => (s.soldNights > 0 ? s.longStayShare : null), format: (v) => pct(v, 0) },
};

function RoomMonthGrid({ data }: { data: OccupancyResponse }) {
  const [metric, setMetric] = useState<GridMetric>('profit');
  const def = GRID_METRICS[metric];
  const months = [...new Set(data.monthly.flatMap((m) => m.points.map((p) => p.month)))].sort();
  if (months.length === 0) {
    return (
      <Card title="Room × month">
        <Empty />
      </Card>
    );
  }

  return (
    <Card
      title="Room × month"
      subtitle={
        <>
          Every room in every month, grouped by class, to drill into any figure above — put two
          studios side by side in the same month and compare what a long stay in one did against
          short stays in the other. Shading runs within each class, since the classes sell at
          different levels. Money in Kč; avg stay in nights.
        </>
      }
      actions={
        <div className="flex flex-wrap gap-1 bg-gray-100 rounded-lg p-1">
          {(Object.keys(GRID_METRICS) as GridMetric[]).map((m) => (
            <button
              key={m}
              onClick={() => setMetric(m)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                metric === m ? 'bg-white shadow-sm text-indigo-700' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {GRID_METRICS[m].label}
            </button>
          ))}
        </div>
      }
    >
      <div className="overflow-x-auto -mx-2 px-2">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="py-2 text-left text-[11px] font-medium text-gray-500 uppercase tracking-wide">Room</th>
              {months.map((m) => (
                <th key={m} className="py-2 px-1 text-center text-[11px] font-medium text-gray-500 uppercase tracking-wide">
                  {monthShort(m)}
                </th>
              ))}
              <th className="py-2 pl-3 text-right text-[11px] font-medium text-gray-500 uppercase tracking-wide">Period</th>
            </tr>
          </thead>
          <tbody>
            {data.classes.map((c) => {
              const classPoints = data.monthly.find((m) => m.classId === c.id)?.points ?? [];
              const classTotal = data.scorecard.find((s) => s.classId === c.id)?.slice;
              const roomCells = data.roomMonths.filter((r) => r.classId === c.id);
              const values = [
                ...classPoints.map((p) => def.get(p.slice)),
                ...roomCells.map((r) => def.get(r.slice)),
              ].filter((v): v is number => v !== null);
              const min = values.length > 0 ? Math.min(...values) : 0;
              const max = values.length > 0 ? Math.max(...values) : 1;
              const shade = (v: number | null) => {
                if (v === null) return null;
                return heatStyle(max > min ? (v - min) / (max - min) : 0.5);
              };
              return [
                <tr key={`${c.id}-head`} className="border-t border-gray-100">
                  <td className="pt-3 pb-1.5 pr-3 whitespace-nowrap">
                    <ClassTag info={c} compact />
                  </td>
                  {months.map((m) => {
                    const p = classPoints.find((x) => x.month === m);
                    return (
                      <GridCell
                        key={m}
                        value={p ? def.get(p.slice) : null}
                        format={def.format}
                        style={shade(p ? def.get(p.slice) : null)}
                        title={p ? cellTitle(c.label, m, p.slice) : undefined}
                        strong
                      />
                    );
                  })}
                  <td className="pt-3 pb-1.5 pl-3 text-right whitespace-nowrap font-semibold text-gray-900">
                    {classTotal && def.get(classTotal) !== null ? def.format(def.get(classTotal)!) : '—'}
                  </td>
                </tr>,
                ...c.rooms.map((room) => {
                  const total = data.roomTotals.find((t) => t.room === room)?.slice;
                  return (
                    <tr key={`${c.id}-${room}`}>
                      <td className="py-1 pr-3 pl-5 whitespace-nowrap">
                        <span className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: ROOM_COLORS[room] ?? '#94A3B8' }} />
                          <span className="text-gray-700">{room}</span>
                        </span>
                      </td>
                      {months.map((m) => {
                        const cell = roomCells.find((r) => r.room === room && r.month === m);
                        const v = cell ? def.get(cell.slice) : null;
                        return (
                          <GridCell
                            key={m}
                            value={v}
                            format={def.format}
                            style={shade(v)}
                            title={cell ? cellTitle(room, m, cell.slice) : undefined}
                          />
                        );
                      })}
                      <td className="py-1 pl-3 text-right whitespace-nowrap text-gray-700">
                        {total && def.get(total) !== null ? def.format(def.get(total)!) : '—'}
                      </td>
                    </tr>
                  );
                }),
              ];
            })}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end mt-3">
        <HeatLegend min={0} max={1} format={(v) => (v === 0 ? 'low' : 'high')} />
      </div>
    </Card>
  );
}

function cellTitle(name: string, month: string, s: OccSlice): string {
  const parts = [
    `${name} · ${monthLabel(month)}`,
    `${pct(s.occupancy, 0)} (${s.soldNights}/${s.availableNights} nights)`,
    s.soldNights > 0 ? `ADR ${czk(s.adr)}` : null,
    `RevPAR ${czk(s.revpar)}`,
    s.profit ? `GP ${czk(s.profit.perAvailableNight)} / avail. night` : null,
    s.stays > 0 ? `${s.stays} stays, avg ${num(s.avgLos, 1)} n` : null,
    s.soldNights > 0 ? `${pct(s.longStayShare, 0)} weekly-stay nights` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function GridCell({
  value,
  format,
  style,
  title,
  strong = false,
}: {
  value: number | null;
  format: (v: number) => string;
  style: ReturnType<typeof heatStyle> | null;
  title?: string;
  strong?: boolean;
}) {
  if (value === null || !style) {
    return (
      <td className={`${strong ? 'pt-3 pb-1.5' : 'py-1'} px-1`}>
        <div className="h-8 rounded bg-gray-50 flex items-center justify-center text-[10px] text-gray-300">—</div>
      </td>
    );
  }
  return (
    <td className={`${strong ? 'pt-3 pb-1.5' : 'py-1'} px-1`}>
      <div
        className={`h-8 min-w-[52px] rounded flex items-center justify-center text-[11px] leading-none ${strong ? 'font-semibold' : 'font-medium'}`}
        style={style}
        title={title}
      >
        {format(value)}
      </div>
    </td>
  );
}

// ── 6. Sold-out dates ────────────────────────────────────────────────────────

function SoldOutView({ data }: { data: OccupancyResponse }) {
  return (
    <Card
      title="Where each class ran out of rooms"
      subtitle={
        <>
          A date is sold out for a class when every room of that class on sale that night was taken
          — nothing left to sell at any price, so the rate was never tested. Counted in calendar
          dates, separately per class. The weekday ADR uses stays under {data.longStayMinNights} nights
          only, so weekly rates do not drag a weekday down.
        </>
      }
    >
      <div className="space-y-8">
        {data.soldOut.map((so) => (
          <ClassSoldOutBlock key={so.classId} so={so} info={classInfo(data, so.classId)} />
        ))}
      </div>
    </Card>
  );
}

function ClassSoldOutBlock({ so, info }: { so: ClassSoldOut; info: OccupancyClassInfo }) {
  if (so.dates === 0) {
    return (
      <div>
        <ClassTag info={info} />
        <Empty />
      </div>
    );
  }
  const withDates = so.weekday.filter((w) => w.dates > 0);
  const tight = [...withDates].sort((a, b) => b.soldOutRate - a.soldOutRate || b.occupancy - a.occupancy)[0];
  const soft = [...withDates].sort((a, b) => a.soldOutRate - b.soldOutRate || a.occupancy - b.occupancy)[0];
  const inversions = withDates.filter(
    (w) =>
      w.spareDates >= 3 &&
      w.shortStayAdrSoldOut !== null &&
      w.shortStayAdrSpare !== null &&
      // A few percent either way is mix noise; only a clear gap is a signal.
      w.shortStayAdrSoldOut < w.shortStayAdrSpare * 0.95,
  );
  const roomsWord = info.id === '1kk' ? 'studios' : 'apartments';

  return (
    <div>
      <div className="mb-3">
        <ClassTag info={info} />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Tile
          label="Dates sold out"
          tone={so.soldOutRate > 0.5 ? 'rose' : 'emerald'}
          value={pct(so.soldOutRate, 0)}
          hint={`${num(so.soldOutDates)} of ${num(so.dates)} dates — all ${so.rooms} ${roomsWord} taken`}
        />
        <Tile label="Longest sold-out run" tone="amber" value={`${num(so.longestRun)} dates`} hint="consecutive, nothing left to sell" />
        <Tile
          label="Tightest weekday"
          tone="rose"
          value={tight?.label ?? '—'}
          hint={tight ? `sold out ${pct(tight.soldOutRate, 0)} of ${tight.label}s` : undefined}
        />
        <Tile
          label="Softest weekday"
          tone="sky"
          value={soft?.label ?? '—'}
          hint={soft ? `sold out ${pct(soft.soldOutRate, 0)} · ${pct(soft.occupancy, 0)} full` : undefined}
        />
      </div>

      {inversions.length > 0 && (
        <div className="mb-4">
          <Callout tone="amber" title={`Price is not rationing demand on ${inversions.map((w) => w.label).join(', ')}`}>
            On those weekdays the dates that sold out earned a LOWER short-stay ADR than the dates with a
            room left — demand, not price, decided which nights filled. Those are the nights to price up.
          </Callout>
        </div>
      )}

      <SoldOutStrip days={so.days} />

      <div className="mt-4">
        <Table columns={['Day', 'Occupancy', 'Sold out', 'ADR', 'ADR when sold out', 'ADR with a room left']}>
          {so.weekday.map((w) => (
            <tr key={w.isoDow} className="hover:bg-gray-50">
              <Td align="left">{w.label}</Td>
              <Td>{w.availableNights > 0 ? pct(w.occupancy, 0) : '—'}</Td>
              <Td>
                {w.dates > 0 ? pct(w.soldOutRate, 0) : '—'}
                <span className="text-[11px] text-gray-400"> · {w.soldOutDates}/{w.dates}</span>
              </Td>
              <Td>{w.shortStayAdr > 0 ? czk(w.shortStayAdr) : '—'}</Td>
              <Td>{w.shortStayAdrSoldOut === null ? '—' : czk(w.shortStayAdrSoldOut)}</Td>
              <Td muted={w.spareDates < 3}>
                {w.shortStayAdrSpare === null ? '—' : czk(w.shortStayAdrSpare)}
                {w.spareDates > 0 && w.spareDates < 3 && (
                  <span className="text-[11px] text-gray-400"> · {w.spareDates} date{w.spareDates === 1 ? '' : 's'}</span>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </div>
    </div>
  );
}

/**
 * One cell per date, shaded by how full the class was, ringed when sold out.
 * Sequence is the point: a fortnight of consecutive sold-out dates is a different
 * story from the same count scattered across the period. Future dates are faded
 * — they are still on sale.
 */
function SoldOutStrip({ days }: { days: ClassSoldOut['days'] }) {
  if (days.length === 0) return null;
  return (
    <div>
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Every date in the period</p>
        <div className="flex items-center gap-3 text-[11px] text-gray-500">
          <HeatLegend min={0} max={1} format={(v) => pct(v, 0)} />
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm bg-indigo-700 ring-2 ring-rose-400 inline-block" />
            sold out
          </span>
        </div>
      </div>
      <div className="flex flex-wrap gap-[3px]">
        {days.map((d) => {
          const occupancy = d.capacity > 0 ? Math.min(1, d.sold / d.capacity) : 0;
          return (
            <span
              key={d.date}
              title={`${d.date} · ${d.sold}/${d.capacity} rooms sold${d.soldOut ? ' · SOLD OUT' : ''}${d.future ? ' · still on sale' : ''}`}
              className={`w-[9px] h-[18px] rounded-sm ${d.soldOut ? 'ring-1 ring-rose-400' : ''}`}
              style={{ backgroundColor: heatStyle(occupancy).backgroundColor, opacity: d.future ? 0.45 : 1 }}
            />
          );
        })}
      </div>
    </div>
  );
}

'use client';
/**
 * Rates — do the rate plans, deals and channels raise GROSS PROFIT?
 *
 * ORDER IS AN ARGUMENT. The tab answers four questions in the order a pricing
 * decision gets made: which rate plans to offer, whether the time-limited deals
 * earn their discount, what the cancellations those plans invite really cost once
 * the nights are resold, and whether the direct channel keeps the commission it
 * saves. Then the far-out premium test, stay length, and price position against
 * the market — last, because it is the least trustworthy number here.
 *
 * EVERYTHING IS PER CLASS. 1KK studios and 2KK apartments are different products,
 * so the tab opens on a side-by-side of the two and every card below shows one
 * class at a time (the blend is available, but not the default).
 *
 * The comparisons to believe are the SAME-NIGHT ones: the same unit on the same
 * date sold two ways, which takes the season out. Averages are context. The one
 * exception is the rate-plan verdict: the plans sell at different distances from
 * arrival, so it sets each stay against the same stay sold on Non-refundable.
 */
import { useMemo, useState } from 'react';
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
import type {
  ChannelRow,
  DirectPricingCheck,
  MarketResponse,
  PlanCounterfactualRow,
  PromoRow,
  RateClassId,
  RatePlanRow,
  RatesClassView,
  RatesResponse,
  ResaleRow,
  SameDateComparison,
} from '@/utils/analyticsTypes';
import { MIN_COUNTERFACTUAL_BOOKINGS, summarisePlanCounterfactual } from '@/utils/ratesAnalysis';
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

// ── Formatting ───────────────────────────────────────────────────────────────

/** +14 % / −9 % — a relative change, signed. */
function signed(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const magnitude = num(Math.abs(value) * 100, digits);
  // Decide the sign on the ROUNDED figure, so −0.3 % never prints as "−0 %".
  const zero = Number(magnitude.replace(/\s/g, '').replace(',', '.')) === 0;
  const sign = zero ? '' : value > 0 ? '+' : '−';
  return `${sign}${magnitude} %`;
}

/** How a same-night comparison was matched, for prose. */
function matchedOn(cmp: SameDateComparison | null | undefined): string {
  return cmp?.grain === 'week' ? 'the same unit in the same week' : 'the same unit and night';
}

function toneOf(value: number | null | undefined, flat = 0.02): string {
  if (value === null || value === undefined) return '!text-gray-300';
  if (value > flat) return '!text-emerald-600';
  if (value < -flat) return '!text-rose-600';
  return '';
}

const DIRECT = ['Direct-Web', 'Direct-Phone', 'Direct'];

// ── Section ──────────────────────────────────────────────────────────────────

export default function RatesSection({
  data,
  market,
}: {
  data: RatesResponse;
  market: MarketResponse | null;
}) {
  const [classId, setClassId] = useState<RateClassId>('1kk');
  const view = data.classes.find((c) => c.classId === classId) ?? data.classes[0];

  if (!view) return <Card title="Rates"><Empty /></Card>;

  return (
    <>
      <ClassComparison data={data} />
      <ClassSwitch data={data} active={view.classId} onChange={setClassId} />
      {view.totals.nights === 0 ? (
        <Card title={view.label}>
          <Empty message="No nights for this class in the current filters." />
        </Card>
      ) : (
        <>
          <RatePlans view={view} data={data} minMatched={data.minMatchedDates} />
          <Promotions view={view} />
          <Resale view={view} />
          <Channels view={view} />
          <FarOutTest view={view} farOut={data.configuredFarOutPremium} />
          <StayLengthMix view={view} />
        </>
      )}
      <PricePosition market={market} unitIds={view.unitIds} />
      <Footnote data={data} />
    </>
  );
}

// ── 1KK vs 2KK ───────────────────────────────────────────────────────────────

function ClassComparison({ data }: { data: RatesResponse }) {
  const cols = data.classes;
  const rows: { label: string; hint: string; value: (c: RatesClassView) => string }[] = [
    { label: 'Nights sold', hint: 'in the window', value: (c) => num(c.totals.nights) },
    { label: 'ADR', hint: 'gross per night', value: (c) => czk(c.totals.adr) },
    {
      label: 'Gross profit / night',
      hint: 'after commission, fees and turnover',
      value: (c) => czk(c.totals.gpPerNight),
    },
    { label: 'Non-refundable', hint: 'share of nights', value: (c) => pct(c.nonRefundableShare, 0) },
    { label: 'On a promotion', hint: 'share of nights', value: (c) => pct(c.promoShare, 0) },
    { label: 'On a time-limited deal', hint: 'Limited Time + seasonal', value: (c) => pct(c.timeLimitedShare, 1) },
    { label: 'Sold direct', hint: 'web + phone, share of nights', value: (c) => pct(c.directShare, 1) },
    { label: 'Guest cancellations', hint: 'share of bookings', value: (c) => pct(c.totals.cancellationRate, 0) },
    {
      label: 'Cancelled nights resold',
      hint: 'past nights only',
      value: (c) =>
        c.resaleTotal.cancelledNights > 0
          ? `${pct(c.resaleTotal.resaleRate, 0)} of ${num(c.resaleTotal.cancelledNights)}`
          : '—',
    },
  ];

  return (
    <Card
      title="1KK and 2KK side by side"
      subtitle="The studios and the two-bedroom apartments are different products with different prices, seasons and guests, so every answer on this tab is given per class. Gross profit here is gross − OTA commission − payment fees − the turnover cost of each stay (cleaning, laundry, consumables)."
    >
      <Table columns={['', ...cols.map((c) => c.label)]}>
        {rows.map((r) => (
          <tr key={r.label} className="hover:bg-gray-50">
            <Td align="left">
              <span className="font-medium text-gray-800">{r.label}</span>
              <span className="ml-2 text-[11px] text-gray-400">{r.hint}</span>
            </Td>
            {cols.map((c) => (
              <Td key={c.classId} bold={c.classId !== 'all'} muted={c.classId === 'all'}>
                {r.value(c)}
              </Td>
            ))}
          </tr>
        ))}
      </Table>
    </Card>
  );
}

function ClassSwitch({
  data,
  active,
  onChange,
}: {
  data: RatesResponse;
  active: RateClassId;
  onChange: (id: RateClassId) => void;
}) {
  const current = data.classes.find((c) => c.classId === active);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-xs font-medium text-gray-500">Detail below for</span>
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1" role="tablist">
        {data.classes.map((c) => (
          <button
            key={c.classId}
            role="tab"
            aria-selected={c.classId === active}
            onClick={() => onChange(c.classId)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              c.classId === active ? 'bg-white shadow-sm text-indigo-700' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>
      {current && <span className="text-xs text-gray-400">{current.description}</span>}
    </div>
  );
}

// ── Same-night comparison cell ───────────────────────────────────────────────

function SameNight({
  cmp,
  field = 'adrDelta',
  minMatched,
}: {
  cmp: SameDateComparison | null;
  field?: 'adrDelta' | 'netAdrDelta' | 'gpDelta';
  minMatched?: number;
}) {
  if (!cmp) return <span className="text-gray-300">—</span>;
  if (!cmp.comparable) {
    return (
      <span
        className="text-gray-300"
        title={`Only ${cmp.matchedDates} matched ${cmp.grain === 'week' ? 'unit-weeks' : 'unit-nights'} from ${cmp.matchedBookings} bookings${minMatched ? ` (needs ${minMatched} from 5)` : ''}`}
      >
        n/a
      </span>
    );
  }
  const value = cmp[field];
  return (
    <span
      className={toneOf(value).replace('!', '')}
      title={`Median over ${cmp.matchedDates} matched ${cmp.grain === 'week' ? 'unit-weeks' : 'unit-nights'} (${cmp.matchedBookings} bookings) vs ${cmp.against}`}
    >
      {signed(value)}
      {cmp.grain === 'week' && <span className="ml-0.5 text-[10px] text-gray-400">wk</span>}
    </span>
  );
}

// ── Q1: rate plans ───────────────────────────────────────────────────────────

/** "2026-06-20" → "20 Jun 2026". */
function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
}

/**
 * Is each refundable plan's premium over Non-refundable worth its cancellations?
 *
 * The verdict sets every finished Booking.com Standard / Flexible stay against
 * the same stay sold on Non-refundable at the same moment (see
 * `summarisePlanCounterfactual`), because the same-night gap mostly measures
 * WHEN each plan sells — Standard far out on Early Booker, Non-refundable last
 * minute — not the plan. It is summarised here, not on the server, so the
 * booked-from date can move without a refetch; it defaults to the day today's
 * plans and perks launched. The plan-by-channel table below stays as context.
 */
function RatePlans({ view, data, minMatched }: { view: RatesClassView; data: RatesResponse; minMatched: number }) {
  const { ladder, defaultBookedFrom, outcomes } = data.planCounterfactual;
  const [bookedFrom, setBookedFrom] = useState(defaultBookedFrom);
  const verdicts = useMemo(
    () => summarisePlanCounterfactual(outcomes, { classId: view.classId, bookedFrom: bookedFrom || null, ladder }),
    [outcomes, view.classId, bookedFrom, ladder],
  );
  const rows = view.plans.filter((r) => r.nights > 0);
  if (rows.length === 0 && verdicts.length === 0) return null;
  const refundable = verdicts.filter((r) => r.plan !== 'Non-refundable');

  return (
    <Card
      title={`1 · Do the rate plans make sense? — ${view.label}`}
      subtitle="Is each refundable plan's premium over Non-refundable worth the cancellations it invites? Every finished Booking.com Standard and Flexible stay is set against the same stay sold on Non-refundable at the same moment — same unit, nights, booking date and promotions — and credited with the gross profit of whoever resold its cancelled nights."
    >
      <BookedFrom value={bookedFrom} launch={defaultBookedFrom} onChange={setBookedFrom} />
      {refundable.length > 0 ? (
        <div className="mb-5 space-y-3">
          {refundable.map((r) => (
            <PlanVerdict key={r.plan} row={r} />
          ))}
        </div>
      ) : (
        <p className="mb-5 text-xs text-gray-400">
          No finished Booking.com Standard or Flexible stays booked
          {bookedFrom ? ` from ${dayLabel(bookedFrom)}` : ''} in this window.
        </p>
      )}

      {verdicts.length > 0 && (
        <>
          <p className="text-xs font-semibold text-gray-700 mb-2">
            Like for like — Booking.com stays{bookedFrom ? ` booked from ${dayLabel(bookedFrom)}` : ''}, checked out
          </p>
          <Table
            columns={[
              'Plan',
              'Bookings',
              'Cancelled',
              'Days out',
              'Resold',
              'Resale price',
              'GP made',
              'Same on Non-ref',
              'vs Non-ref',
              'Break-even',
              'Configured',
            ]}
          >
            {verdicts.map((r) => (
              <CounterfactualRow key={r.plan} r={r} />
            ))}
          </Table>
          <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">
            Cancelled = share of booked nights; days out = median days before arrival the cancellations came; resold =
            cancelled nights a later booking took (capacity-aware, same unit), at the resale price ÷ the price the
            cancelled booking had agreed. GP made = gross profit of the nights that stayed (price − commission − fees −
            turnover) + gross profit of the bookings that resold its cancelled nights. Same on Non-ref = each stay’s
            per-night price × the Beds24 ladder (Non-ref {num(ladder['Non-refundable'], 2)} · Standard{' '}
            {num(ladder.Standard, 2)} · Flexible {num(ladder.Flexible, 2)} of the base, from{' '}
            <code>RATE_PLAN_LADDER</code> — it goes stale silently when the Daily Price Rules change), less its take
            rate (Booking.com’s average for a cancelled stay, priced from the value it had agreed) and its turnover.
            Break-even = the premium over Non-ref at which the stayed nights would earn exactly that, resale held fixed;
            configured = what the ladder charges. <strong className="font-medium text-gray-500">Perks are not costed</strong>: Flexible includes early
            check-in and late checkout, Standard early check-in, so the true break-even is a little higher. Only stays
            wholly inside the window count; fewer than {MIN_COUNTERFACTUAL_BOOKINGS} bookings is a hint, not a verdict.
          </p>
        </>
      )}

      {rows.length > 0 && (
        <>
          <p className="text-xs font-semibold text-gray-700 mb-2 mt-6">Every plan and channel, nights in the window</p>
          <Table
            columns={[
              'Plan',
              'Channel',
              'Nights',
              'Share',
              'ADR',
              'Same-night gap*',
              'GP / night',
              'Cancels',
              'Cancelled nights resold',
              'GP / booked night',
              'LOS',
              'Lead',
            ]}
          >
            {rows.map((r) => (
              <PlanRow key={`${r.channel}|${r.plan}`} r={r} minMatched={minMatched} />
            ))}
          </Table>
          <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">
            * Same-night gap = the plan’s price against Booking.com Non-ref on the same unit and night. It is context,
            not the plan’s premium: Standard and Flexible are mostly booked weeks ahead on Early Booker deals and
            Non-ref mostly in the last week, so the gap mixes in when each sold. Hover a value for how many matched
            nights it rests on; “n/a” means fewer than {minMatched}, or fewer than five separate bookings behind them.
            “wk” = matched on the same unit and week, because K.201 and O.308 are single rooms and two bookings never
            share a night there. GP / booked night = (gross profit of the nights that stayed + gross profit of the
            replacement bookings that resold its cancelled nights) ÷ (stayed + cancelled nights). Cancels are guest
            cancellations as a share of bookings; abandoned checkouts are excluded.
          </p>
        </>
      )}
      {view.genius && <GeniusNote genius={view.genius} />}
    </Card>
  );
}

/** Which bookings the verdict reads: from a date (default: the plans' launch), or all of them. */
function BookedFrom({
  value,
  launch,
  onChange,
}: {
  value: string;
  launch: string;
  onChange: (value: string) => void;
}) {
  const chip = (active: boolean) =>
    `px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${
      active ? 'bg-white shadow-sm text-indigo-700' : 'text-gray-500 hover:text-gray-700'
    }`;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-gray-500">Bookings made from</span>
      <div className="flex items-center gap-2">
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          <button type="button" className={chip(value === launch)} onClick={() => onChange(launch)}>
            Plans launch
          </button>
          <button type="button" className={chip(value === '')} onClick={() => onChange('')}>
            All
          </button>
        </div>
        <input
          type="date"
          aria-label="Booked from"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="px-2 py-1.5 rounded-md border border-gray-200 text-xs text-gray-700"
        />
      </div>
      <span className="text-[11px] text-gray-400">
        {value === launch
          ? 'when today’s plans and perks launched'
          : value
            ? `launch was ${dayLabel(launch)}`
            : 'every booking in the window'}
      </span>
    </div>
  );
}

function PlanVerdict({ row }: { row: PlanCounterfactualRow }) {
  const thin = row.bookings < MIN_COUNTERFACTUAL_BOOKINGS;
  const u = row.uplift;
  const be = row.breakEvenPremium;
  const sample = thin ? `${num(row.bookings)} bookings — read as a hint` : `${num(row.bookings)} bookings`;
  const earns =
    u === null
      ? null
      : Math.abs(u) < 0.0005
        ? 'earns the same as the same stays on Non-ref'
        : `earns ${pct(Math.abs(u), 1)} ${u > 0 ? 'more' : 'less'} than the same stays on Non-ref`;
  const title =
    be === null
      ? `${row.plan}: every stay cancelled, so there is no break-even to read (${sample})`
      : `${row.plan}: needs ${pct(be, 1)} over Non-ref to break even, configured ${pct(row.configuredPremium, 1)}` +
        (earns ? ` — ${earns}` : '') +
        ` (${sample})`;
  const margin = be === null ? null : row.configuredPremium - be;

  return (
    <Callout tone={thin ? 'slate' : u !== null && u < -0.01 ? 'amber' : 'sky'} title={title}>
      Sold on Non-refundable at the same moment, these stays would have made {czk(row.counterfactualGp)} of gross
      profit; on {row.plan} they made {czk(row.realisedGp)}. {pct(row.nightCancelRate, 0)} of their{' '}
      {num(row.nights)} nights cancelled
      {row.medianCancelDaysBefore !== null && <>, a median {num(row.medianCancelDaysBefore, 0)} days before arrival</>}
      {row.resaleRate !== null && (
        <>
          , and {pct(row.resaleRate, 0)} of those nights were resold
          {row.resalePriceRatio !== null && <> at {pct(row.resalePriceRatio, 0)} of the original price</>}
        </>
      )}
      .{' '}
      {margin !== null &&
        (margin >= 0 ? (
          <>
            The configured premium clears break-even by {num(margin * 100, 1)} points, so the plan pays for its
            cancellations.
          </>
        ) : (
          <>
            The configured premium falls {num(-margin * 100, 1)} points short of break-even: its cancellations cost more
            than the premium brings in.
          </>
        ))}
      {row.unpriced > 0 && (
        <> {num(row.unpriced)} cancelled stays carry no readable price and are left out of the comparison.</>
      )}
    </Callout>
  );
}

function CounterfactualRow({ r }: { r: PlanCounterfactualRow }) {
  const base = r.plan === 'Non-refundable';
  return (
    <tr className="hover:bg-gray-50">
      <Td align="left">
        <span className="font-medium text-gray-800">{r.plan}</span>
      </Td>
      <Td className={r.bookings < MIN_COUNTERFACTUAL_BOOKINGS ? '!text-gray-400' : ''}>{num(r.bookings)}</Td>
      <Td className={r.nightCancelRate > 0.3 ? '!text-rose-600 font-semibold' : ''}>
        {pct(r.nightCancelRate, 0)}
      </Td>
      <Td muted>{r.medianCancelDaysBefore !== null ? `${num(r.medianCancelDaysBefore, 0)} d` : '—'}</Td>
      <Td muted>{r.cancelledNights > 0 ? `${num(r.resoldNights)} / ${num(r.cancelledNights)}` : '—'}</Td>
      <Td muted>{r.resalePriceRatio !== null ? pct(r.resalePriceRatio, 0) : '—'}</Td>
      <Td>{czk(r.realisedGp)}</Td>
      <Td muted>{base ? '—' : czk(r.counterfactualGp)}</Td>
      <Td bold className={toneOf(r.uplift, 0.01)}>
        {base ? '—' : signed(r.uplift, 1)}
      </Td>
      <Td bold>{r.breakEvenPremium !== null ? pct(r.breakEvenPremium, 1) : '—'}</Td>
      <Td muted>{base ? 'base' : pct(r.configuredPremium, 1)}</Td>
    </tr>
  );
}

function PlanRow({ r, minMatched }: { r: RatePlanRow; minMatched: number }) {
  const main = r.channel === 'Booking.com' && ['Non-refundable', 'Standard', 'Flexible'].includes(r.plan);
  return (
    <tr className={`hover:bg-gray-50 ${main ? '' : 'text-gray-500'}`}>
      <Td align="left">
        <span className={main ? 'font-medium text-gray-800' : 'text-gray-600'}>{r.plan}</span>
      </Td>
      <Td align="left" muted>
        {r.channel}
      </Td>
      <Td>{num(r.nights)}</Td>
      <Td muted>{pct(r.nightShare, 1)}</Td>
      <Td>{czk(r.adr)}</Td>
      <Td>
        <SameNight cmp={r.vsNonRefundable} minMatched={minMatched} />
      </Td>
      <Td bold>{czk(r.gpPerNight)}</Td>
      <Td className={r.cancellationRate > 0.3 ? '!text-rose-600 font-semibold' : ''}>
        {r.cancellableBookings > 0 ? pct(r.cancellationRate, 0) : '—'}
      </Td>
      <Td muted>{r.cancelledNights > 0 ? `${num(r.resoldNights)} / ${num(r.cancelledNights)}` : '—'}</Td>
      <Td bold>{czk(r.gpPerBookedNight)}</Td>
      <Td muted>{num(r.avgLengthOfStay, 1)}</Td>
      <Td muted>{num(r.avgLeadDays, 0)} d</Td>
    </tr>
  );
}

function GeniusNote({ genius }: { genius: NonNullable<RatesClassView['genius']> }) {
  return (
    <div className="mt-5 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
      <p className="text-xs font-semibold text-gray-700 mb-1">
        Booking.com Genius covers {pct(genius.geniusNightShare, 0)} of Booking.com nights
      </p>
      <p className="text-[11px] text-gray-600 leading-relaxed">
        {genius.comparable ? (
          <>
            Genius nights averaged {czk(genius.geniusAdr)} against {czk(genius.nonGeniusAdr)} for
            non-Genius ({signed(genius.adrDelta)}). Read that as a mix difference, not a discount
            measurement: the two groups differ in plan, lead time and dates as well as in Genius.
            {genius.geniusNightShare >= 0.8 && (
              <>
                {' '}At {pct(genius.geniusNightShare, 0)} penetration Genius is effectively the standard rate on
                this channel.
              </>
            )}
          </>
        ) : (
          <>
            The ADR comparison is withheld: one side has fewer than {genius.minComparisonBookings}{' '}
            bookings, and a percentage off a handful of rows reads as a finding when it is noise.
          </>
        )}
      </p>
    </div>
  );
}

// ── Q2: promotions and time-limited deals ────────────────────────────────────

function Promotions({ view }: { view: RatesClassView }) {
  const rows = view.promos;
  if (rows.length === 0) return null;
  const timeLimited = rows.filter((r) => r.timeLimited);
  const baseline = view.avgDateStrength;
  const leak = rows
    .filter((r) => !r.timeLimited && r.promo !== 'No promotion' && r.vsSameDate?.comparable && r.nights >= 20)
    .sort((a, b) => (a.vsSameDate?.gpDelta ?? 0) - (b.vsSameDate?.gpDelta ?? 0))[0];

  return (
    <Card
      title={`2 · Are the time-limited deals working? — ${view.label}`}
      subtitle="Every promotion a night arrived on, against the nights that sold WITHOUT it for the same unit on the same date. “Rest of class full” is how full the other rooms of the class ended up on the nights each promotion sold: a deal that lands on nights the class was filling anyway gives its discount away."
    >
      <div className="mb-5 space-y-3">
        <TimeLimitedVerdict rows={timeLimited} view={view} />
        {leak && leak.vsSameDate && (leak.vsSameDate.gpDelta ?? 0) < -0.05 && (
          <Callout tone="amber" title={`${leak.promo} is the costliest standing promotion`}>
            On {matchedOn(leak.vsSameDate)} it sells {signed(leak.vsSameDate.adrDelta)} against other bookings
            and earns <strong>{signed(leak.vsSameDate.gpDelta)}</strong> gross profit, on nights the rest of
            the class ended {leak.dateStrength === null ? '—' : pct(leak.dateStrength, 0)} full
            {baseline !== null && <> (class average {pct(baseline, 0)})</>}. It covers{' '}
            {pct(leak.nightShare, 0)} of nights.
          </Callout>
        )}
      </div>

      <Table
        columns={[
          'Promotion',
          'Nights',
          'Share',
          'ADR',
          'Same night vs others',
          'GP / night',
          'GP same night',
          'Rest of class full',
          'Lead',
          'Cancels',
        ]}
      >
        {rows.map((r) => (
          <PromoRows key={r.promo} r={r} baseline={baseline} />
        ))}
      </Table>
      <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">
        Time-limited = Booking.com Limited Time Deals plus the operator-named seasonal campaigns
        (“August Deal”, “Sezónní nabídka”); each campaign is listed under its family with the dates it was
        booked. Standing promotions (Early Booker, Last Minute, Mobile) are always on. Same-night columns
        are medians over matched unit-nights; “wk” = matched within the same week for the single-room 2KK
        units.
      </p>
    </Card>
  );
}

function TimeLimitedVerdict({ rows, view }: { rows: PromoRow[]; view: RatesClassView }) {
  const nights = rows.reduce((a, r) => a + r.nights, 0);
  if (nights === 0) {
    return (
      <Callout tone="slate" title="No time-limited deal sold a night in this window">
        Limited Time Deals and seasonal campaigns appear here as soon as one is booked.
      </Callout>
    );
  }
  const gp = rows.reduce((a, r) => a + r.grossProfit, 0);
  const gpPerNight = gp / nights;
  const strengthNights = rows.filter((r) => r.dateStrength !== null);
  const strength =
    strengthNights.length > 0
      ? strengthNights.reduce((a, r) => a + (r.dateStrength ?? 0) * r.nights, 0) /
        strengthNights.reduce((a, r) => a + r.nights, 0)
      : null;
  const baseline = view.avgDateStrength;
  const comparable = rows.filter((r) => r.vsSameDate?.comparable);
  const grainCmp = comparable.find((r) => r.vsSameDate?.grain === 'week')?.vsSameDate ?? comparable[0]?.vsSameDate;
  const adrGap =
    comparable.length > 0
      ? comparable.reduce((a, r) => a + (r.vsSameDate?.adrDelta ?? 0) * r.nights, 0) /
        comparable.reduce((a, r) => a + r.nights, 0)
      : null;
  const softer = strength !== null && baseline !== null && strength < baseline - 0.05;

  return (
    <Callout
      tone={softer ? 'sky' : 'amber'}
      title={`Time-limited deals: ${num(nights)} nights (${pct(view.timeLimitedShare, 1)}), ${czk(gpPerNight)} gross profit per night against ${czk(view.totals.gpPerNight)} for the class`}
    >
      {adrGap !== null ? (
        <>
          On {matchedOn(grainCmp)} they sold <strong>{signed(adrGap)}</strong> against bookings without the
          deal.{' '}
        </>
      ) : (
        <>Too few shared nights to measure the discount directly. </>
      )}
      {strength !== null && baseline !== null && (
        softer ? (
          <>
            They land on softer nights — the rest of the class ended {pct(strength, 0)} full on them,
            against {pct(baseline, 0)} on an average night — which is the job a deal should do. Worth
            keeping, aimed at dates that look weak.
          </>
        ) : (
          <>
            But they are not landing on soft nights: the rest of the class ended {pct(strength, 0)} full on
            the nights they sold, against {pct(baseline, 0)} on an average night. A deal on a night the class
            fills anyway is a discount without extra demand behind it — run them only on dates that are
            still open close in.
          </>
        )
      )}
    </Callout>
  );
}

function PromoRows({ r, baseline }: { r: PromoRow; baseline: number | null }) {
  return (
    <>
      <tr className={`hover:bg-gray-50 ${r.timeLimited ? 'bg-amber-50/40' : ''}`}>
        <Td align="left">
          <span className="font-medium text-gray-800">{r.promo}</span>
          {r.timeLimited && (
            <span className="ml-2 text-[10px] text-amber-600 uppercase tracking-wide">time-limited</span>
          )}
        </Td>
        <Td>{num(r.nights)}</Td>
        <Td muted>{pct(r.nightShare, 1)}</Td>
        <Td>{czk(r.adr)}</Td>
        <Td>
          <SameNight cmp={r.vsSameDate} />
        </Td>
        <Td bold>{czk(r.gpPerNight)}</Td>
        <Td>
          <SameNight cmp={r.vsSameDate} field="gpDelta" />
        </Td>
        <Td
          className={
            r.dateStrength !== null && baseline !== null && r.dateStrength >= baseline && r.promo !== 'No promotion'
              ? '!text-amber-600'
              : ''
          }
        >
          {r.dateStrength === null ? '—' : pct(r.dateStrength, 0)}
        </Td>
        <Td muted>{num(r.avgLeadDays, 0)} d</Td>
        <Td className={r.cancellationRate > 0.3 ? '!text-rose-600' : ''}>{pct(r.cancellationRate, 0)}</Td>
      </tr>
      {r.timeLimited &&
        r.campaigns.map((c) => (
          <tr key={`${r.promo}|${c.name}`} className="text-[12px]">
            <Td align="left" muted>
              <span className="pl-4">↳ {c.name}</span>
              {c.firstBooked && (
                <span className="ml-2 text-[10px] text-gray-400">
                  booked {c.firstBooked === c.lastBooked ? c.firstBooked : `${c.firstBooked} → ${c.lastBooked}`}
                </span>
              )}
            </Td>
            <Td muted>{num(c.nights)}</Td>
            <Td muted>{num(c.bookings)} bk</Td>
            <Td muted>{czk(c.adr)}</Td>
            <Td muted>—</Td>
            <Td muted>{czk(c.gpPerNight)}</Td>
            <Td muted>—</Td>
            <Td muted>—</Td>
            <Td muted>—</Td>
            <Td muted>{pct(c.cancellationRate, 0)}</Td>
          </tr>
        ))}
    </>
  );
}

// ── Q3: cancellations and resale ─────────────────────────────────────────────

function Resale({ view }: { view: RatesClassView }) {
  const total = view.resaleTotal;
  if (total.cancelledNights + total.openNights === 0) {
    return (
      <Card title={`3 · Cancellations — do we resell, and at what price? — ${view.label}`}>
        <Empty message="No guest cancellations touch this window." />
      </Card>
    );
  }
  const planRate = new Map(view.plans.map((p) => [`${p.channel}|${p.plan}`, p]));
  const lost = total.originalGp !== null ? total.originalGp - total.recoveredGp : null;
  const worst = view.resaleByPlan
    .filter((r) => r.cancelledNights >= 10 && r.originalGp !== null)
    .sort((a, b) => (b.originalGp! - b.recoveredGp) - (a.originalGp! - a.recoveredGp))[0];

  return (
    <Card
      title={`3 · Cancellations — do we resell, and at what price? — ${view.label}`}
      subtitle="Every guest-cancelled night in the window, and whether the same sellable unit (Urban studios, Deluxe studios, K.201, O.308) sold that night again afterwards. Resale is judged per unit, not per room — Beds24 reshuffles interchangeable studios — and only counts when the unit actually ran out of rooms, so a later booking that had a free room anyway does not count as a resale. Prices compare the cancelled booking's agreed rate with what the replacement paid."
    >
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-5">
        <Tile label="Cancelled nights" tone="slate" value={num(total.cancelledNights)} hint={`${num(total.cancelledBookings)} bookings · ${num(total.openNights)} still ahead`} />
        <Tile
          label="Resold"
          tone={total.resaleRate >= 0.75 ? 'emerald' : 'amber'}
          value={pct(total.resaleRate, 0)}
          hint={`${num(total.resoldNights)} nights`}
        />
        <Tile
          label="Resale price"
          tone={(total.priceRatio ?? 1) >= 0.95 ? 'emerald' : 'amber'}
          value={total.priceRatio === null ? '—' : pct(total.priceRatio, 0)}
          hint="of the cancelled rate"
        />
        <Tile
          label="Gross profit recovered"
          tone="indigo"
          value={total.originalGp ? pct(total.recoveredGp / total.originalGp, 0) : '—'}
          hint={lost !== null ? `${czk(lost)} not recovered` : undefined}
        />
        <Tile
          label="Resold after"
          tone="slate"
          value={total.avgDaysToResell === null ? '—' : `${num(total.avgDaysToResell, 0)} d`}
          hint={total.avgDaysBeforeArrival === null ? undefined : `cancelled ${num(total.avgDaysBeforeArrival, 0)} d before arrival`}
        />
      </div>

      {worst && (
        <div className="mb-5">
          <Callout tone="amber" title={`${worst.channel} ${worst.label} costs the most to cancellations`}>
            {num(worst.cancelledNights)} cancelled nights; {pct(worst.resaleRate, 0)} were resold, at{' '}
            {worst.priceRatio === null ? '—' : pct(worst.priceRatio, 0)} of the original rate. Net, it lost{' '}
            <strong>{czk(worst.originalGp! - worst.recoveredGp)}</strong> of gross profit
            {worst.originalGp ? <> ({pct(1 - worst.recoveredGp / worst.originalGp, 0)} of what those nights would have made)</> : null}.
            {planRate.get(`${worst.channel}|${worst.label}`) && (
              <> The plan cancels {pct(planRate.get(`${worst.channel}|${worst.label}`)!.cancellationRate, 0)} of bookings.</>
            )}
          </Callout>
        </div>
      )}

      <p className="text-xs font-semibold text-gray-700 mb-2">By rate plan</p>
      <ResaleTable rows={view.resaleByPlan} showChannel />
      <p className="text-xs font-semibold text-gray-700 mb-2 mt-6">Within each unit (same category)</p>
      <ResaleTable rows={view.resaleByUnit} showChannel={false} />
      <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">
        Gross profit of a cancelled night = its agreed rate × (1 − the channel&apos;s average commission and
        fees) − the unit&apos;s average turnover cost spread over the stay. The agreed rate is read back from
        Beds24&apos;s per-night lines (Booking.com) or base price (Airbnb); direct cancellations carry none,
        so they count towards resale but not price. Non-refundable cancellations may still have been
        charged — the archive does not say, so they are treated like any other.
      </p>
    </Card>
  );
}

function ResaleTable({ rows, showChannel }: { rows: ResaleRow[]; showChannel: boolean }) {
  if (rows.length === 0) return <Empty />;
  return (
    <Table
      columns={[
        showChannel ? 'Plan' : 'Unit',
        ...(showChannel ? ['Channel'] : []),
        'Cancelled',
        'Nights',
        'Resold',
        'Agreed rate',
        'Resold at',
        'Price kept',
        'GP recovered',
        'Cancelled before arrival',
        'Resold after',
        'Still ahead',
      ]}
    >
      {rows.map((r) => (
        <tr key={`${r.channel ?? ''}|${r.label}`} className="hover:bg-gray-50">
          <Td align="left">
            <span className="font-medium text-gray-800">{r.label}</span>
          </Td>
          {showChannel && (
            <Td align="left" muted>
              {r.channel}
            </Td>
          )}
          <Td muted>{num(r.cancelledBookings)} bk</Td>
          <Td>{num(r.cancelledNights)}</Td>
          <Td className={r.cancelledNights > 0 && r.resaleRate < 0.6 ? '!text-rose-600' : ''}>
            {r.cancelledNights > 0 ? pct(r.resaleRate, 0) : '—'}
          </Td>
          <Td muted>{r.originalAdr === null ? '—' : czk(r.originalAdr)}</Td>
          <Td muted>{r.resaleAdr === null ? '—' : czk(r.resaleAdr)}</Td>
          <Td className={r.priceRatio !== null && r.priceRatio < 0.9 ? '!text-amber-600' : ''}>
            {r.priceRatio === null ? '—' : pct(r.priceRatio, 0)}
          </Td>
          <Td bold>{r.originalGp ? pct(r.recoveredGp / r.originalGp, 0) : '—'}</Td>
          <Td muted>
            {r.avgDaysBeforeArrival === null
              ? '—'
              : r.avgDaysBeforeArrival < 0
                ? 'after check-in'
                : `${num(r.avgDaysBeforeArrival, 0)} d`}
          </Td>
          <Td muted>{r.avgDaysToResell === null ? '—' : `${num(r.avgDaysToResell, 0)} d`}</Td>
          <Td muted>{r.openNights > 0 ? num(r.openNights) : '—'}</Td>
        </tr>
      ))}
    </Table>
  );
}

// ── Q4: channels and direct pricing ──────────────────────────────────────────

function Channels({ view }: { view: RatesClassView }) {
  const rows = view.channels;
  if (rows.length === 0) return null;
  return (
    <Card
      title={`4 · Channel mix — is direct earning more, or priced too cheap? — ${view.label}`}
      subtitle="What each channel leaves after commission, payment fees and turnover. A direct night can sell below Booking.com and still net the same — the break-even discount — so the test is the same unit on the same night: what direct guests paid against Booking.com guests, and what each night netted."
    >
      {view.directPricing.length > 0 && (
        <div className="grid gap-3 mb-5 lg:grid-cols-2">
          {view.directPricing.map((d) => (
            <DirectVerdict key={d.channel} d={d} />
          ))}
        </div>
      )}

      <Table
        columns={[
          'Channel',
          'Nights',
          'Share',
          'ADR',
          'Commission + fees',
          'Net ADR',
          'Turnover / night',
          'GP / night',
          'Same night vs B.com: price',
          'net',
          'LOS',
          'Lead',
          'Cancels',
        ]}
      >
        {rows.map((r) => (
          <ChannelTableRow key={r.channel} r={r} />
        ))}
      </Table>
      <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">
        Turnover / night is one stay&apos;s cleaning, laundry and consumables spread over its nights — the
        reason a longer average stay lifts GP / night on its own. The same-night columns isolate price:
        the median gap over unit-nights both channels sold.
      </p>

      <ChannelMixChart view={view} />
    </Card>
  );
}

function DirectVerdict({ d }: { d: DirectPricingCheck }) {
  // What a direct night nets over Booking.com when sold at the SAME gross price.
  const parityUplift = d.bookingComTakeRate < 1 ? (1 - d.takeRate) / (1 - d.bookingComTakeRate) - 1 : 0;
  const kept = d.sameDateNetDelta !== null && parityUplift > 0 ? d.sameDateNetDelta / parityUplift : null;

  if (d.verdict === 'insufficient-data') {
    return (
      <Callout tone="slate" title={`${d.channel}: not enough shared nights with Booking.com yet`}>
        {num(d.matchedDates)} matched {d.grain === 'week' ? 'unit-weeks' : 'unit-nights'}. Break-even: {d.channel} can sell up to{' '}
        <strong>{pct(d.breakEvenDiscount, 0)}</strong> below Booking.com and net the same
        ({pct(d.bookingComTakeRate, 1)} vs {pct(d.takeRate, 1)} commission and fees).
      </Callout>
    );
  }

  const title =
    d.verdict === 'too-cheap'
      ? `${d.channel} is too cheap — it nets ${signed(d.sameDateNetDelta)} vs Booking.com on the same night`
      : d.verdict === 'near-break-even'
        ? `${d.channel} nets about what Booking.com does — the commission saving goes to the guest`
        : `${d.channel} nets ${signed(d.sameDateNetDelta)} more than Booking.com on the same night`;

  return (
    <Callout tone={d.verdict === 'keeping-margin' ? 'sky' : 'amber'} title={title}>
      Direct guests paid <strong>{signed(d.sameDateGrossDelta)}</strong> against Booking.com guests on{' '}
      {d.grain === 'week' ? 'the same unit in the same week' : 'the same unit and night'} ({num(d.matchedDates)} matched). The break-even is {signed(-d.breakEvenDiscount)}:
      at the same price a direct night would net {signed(parityUplift)} more.{' '}
      {kept !== null && (
        <>
          So we keep about <strong>{pct(Math.max(0, Math.min(1, kept)), 0)}</strong> of the commission saving
          and hand the rest to the guest as a lower price
          {d.sameDateGpDelta !== null && <> (gross profit per night {signed(d.sameDateGpDelta)}, stay length included)</>}.
        </>
      )}
      {d.verdict !== 'keeping-margin' && <> Raising the direct rate towards Booking.com&apos;s is margin with no commission attached.</>}
    </Callout>
  );
}

function ChannelTableRow({ r }: { r: ChannelRow }) {
  const direct = DIRECT.includes(r.channel);
  return (
    <tr className={`hover:bg-gray-50 ${direct ? 'bg-indigo-50/30' : ''}`}>
      <Td align="left">
        <span className="font-medium text-gray-800">{r.channel}</span>
      </Td>
      <Td>{num(r.nights)}</Td>
      <Td muted>{pct(r.nightShare, 1)}</Td>
      <Td>{czk(r.adr)}</Td>
      <Td muted>{pct(r.takeRate, 1)}</Td>
      <Td>{czk(r.netAdr)}</Td>
      <Td muted>{czk(r.turnoverPerNight)}</Td>
      <Td bold>{czk(r.gpPerNight)}</Td>
      <Td>
        <SameNight cmp={r.vsBookingCom} />
      </Td>
      <Td>
        <SameNight cmp={r.vsBookingCom} field="netAdrDelta" />
      </Td>
      <Td muted>{num(r.avgLengthOfStay, 1)}</Td>
      <Td muted>{num(r.avgLeadDays, 0)} d</Td>
      <Td className={r.cancellationRate > 0.3 ? '!text-rose-600' : ''}>
        {r.cancellableBookings > 0 ? pct(r.cancellationRate, 0) : '—'}
      </Td>
    </tr>
  );
}

/**
 * Channel mix month by month, with ADR and gross profit per night over it. An
 * ADR move that lines up with a mix move is a distribution story, not a pricing one.
 */
function ChannelMixChart({ view }: { view: RatesClassView }) {
  if (view.mixMonthly.length < 2) return null;
  const chartData = view.mixMonthly.map((m) => {
    const point: Record<string, string | number> = {
      month: monthShort(m.month),
      ADR: Math.round(m.adr),
      'GP / night': Math.round(m.gpPerNight),
    };
    for (const channel of view.channelList) point[channel] = Math.round((m.shares[channel] ?? 0) * 100);
    return point;
  });

  return (
    <div className="border-t border-gray-100 pt-5 mt-5">
      <p className="text-xs font-semibold text-gray-700 mb-3">Mix by month, with ADR and gross profit per night</p>
      <div style={{ height: 280 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="month" tick={AXIS_TICK_DARK} axisLine={false} tickLine={false} />
            <YAxis
              yAxisId="share"
              domain={[0, 100]}
              allowDataOverflow
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
                name === 'ADR' || name === 'GP / night' ? [czk(Number(value)), name] : [`${value} %`, name]
              }
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {view.channelList.map((channel, i) => (
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
            <Line
              yAxisId="money"
              type="monotone"
              dataKey="GP / night"
              stroke="#10B981"
              strokeWidth={2}
              strokeDasharray="5 3"
              dot={{ r: 3 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ── The far-out premium test ─────────────────────────────────────────────────

/**
 * Achieved ADR by lead time, against the premium the pricing engine is configured
 * to charge for booking early. The risk-adjusted column decides the argument:
 * long-lead bookings cancel at a multiple of last-minute ones.
 */
function FarOutTest({
  view,
  farOut,
}: {
  view: RatesClassView;
  farOut: RatesResponse['configuredFarOutPremium'];
}) {
  const rows = view.leadAdr.filter((r) => r.nights > 0);
  if (rows.length === 0) return null;
  const { premium, nearDays, farDays } = farOut;
  const achieved = view.achievedFarOutPremium;
  const reference = rows.find((r) => nearDays >= r.minDays && (r.maxDays === null || nearDays <= r.maxDays));
  const farRow = rows.find((r) => farDays >= r.minDays && (r.maxDays === null || farDays <= r.maxDays));

  const chartData = rows.map((r) => ({
    bucket: r.label,
    ADR: Math.round(r.adr),
    'Risk-adjusted ADR': Math.round(r.riskAdjustedAdr),
    Cancellation: Math.round(r.cancellationRate * 100),
  }));

  return (
    <Card
      title={`Is the far-out premium being paid? — ${view.label}`}
      subtitle={
        <>
          The pricing engine is set so a stay booked around {farDays} days out costs about{' '}
          {num(premium * 100, 0)}% more than one booked {nearDays} days out. Achieved ADR by how far ahead each
          night was sold, with the cancellation rate of that lead bucket beside it.
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
                The premium is being avoided rather than paid: Booking.com&apos;s Early Booker Deal discounts
                exactly the far-out bookings the engine charges more for, and the far-out bucket cancels at{' '}
                {farRow ? pct(farRow.cancellationRate, 0) : 'a much higher rate'}.
              </>
            ) : (
              <>
                The premium is landing. Reference bucket {reference?.label ?? `${nearDays}d`} at{' '}
                {reference ? czk(reference.adr) : '—'}.
              </>
            )}
          </Callout>
        </div>
      )}

      <div style={{ height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="bucket" tick={{ ...AXIS_TICK_DARK, fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis yAxisId="money" tickFormatter={czkAxis} tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} />
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
            <Bar yAxisId="money" dataKey="Risk-adjusted ADR" fill="#6366F1" radius={[5, 5, 0, 0]} maxBarSize={34} />
            <Line yAxisId="pct" type="monotone" dataKey="Cancellation" stroke="#F43F5E" strokeWidth={2} dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="border-t border-gray-100 pt-4 mt-4">
        <Table columns={['Booked', 'Nights', 'Share', 'ADR', 'vs reference', 'GP / night', 'Cancels', 'Risk-adjusted ADR']}>
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
              <Td className={toneOf(r.vsReference)}>{signed(r.vsReference)}</Td>
              <Td>{czk(r.gpPerNight)}</Td>
              <Td className={r.cancellationRate > 0.3 ? '!text-rose-600 font-semibold' : ''}>
                {pct(r.cancellationRate, 0)}
              </Td>
              <Td bold>{czk(r.riskAdjustedAdr)}</Td>
            </tr>
          ))}
        </Table>
      </div>
      <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">
        Stay basis: a night is counted in the bucket matching how far ahead it was booked. Risk-adjusted ADR
        = ADR × (1 − cancellation rate) for that bucket.
      </p>
    </Card>
  );
}

// ── Stay length ──────────────────────────────────────────────────────────────

function StayLengthMix({ view }: { view: RatesClassView }) {
  if (view.losMix.length === 0) return null;
  const chartData = view.losMix.map((r) => ({
    label: r.label,
    Share: Math.round(r.nightShare * 100),
    ADR: Math.round(r.adr),
    'GP / night': Math.round(r.gpPerNight),
  }));

  return (
    <Card
      title={`Stay length against ADR and gross profit — ${view.label}`}
      subtitle="Longer stays buy a lower nightly rate but spread one cleaning over more nights, so gross profit per night can rise while ADR falls — the trade the weekly and one-night plans are pricing."
    >
      <div style={{ height: 230 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="label" tick={AXIS_TICK_DARK} axisLine={false} tickLine={false} />
            <YAxis yAxisId="share" tickFormatter={(v) => `${v}%`} tick={AXIS_TICK} axisLine={false} tickLine={false} width={44} />
            <YAxis yAxisId="money" orientation="right" tickFormatter={czkAxis} tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value, name) =>
                name === 'Share' ? [`${value} % of nights`, 'Share'] : [czk(Number(value)), name]
              }
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar yAxisId="share" dataKey="Share" fill="#A5B4FC" radius={[5, 5, 0, 0]} maxBarSize={44} />
            <Line yAxisId="money" type="monotone" dataKey="ADR" stroke="#F59E0B" strokeWidth={2} dot={{ r: 3 }} />
            <Line yAxisId="money" type="monotone" dataKey="GP / night" stroke="#10B981" strokeWidth={2} dot={{ r: 3 }} />
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
 * looking expensive. Read it as position and as a change detector, never as a target.
 */
function PricePosition({ market, unitIds }: { market: MarketResponse | null; unitIds: string[] }) {
  const all = market?.prices.filter((p) => p.points.some((pt) => pt.p50 !== null)) ?? [];
  const units = all.filter((u) => unitIds.includes(u.unitId)).length > 0 ? all.filter((u) => unitIds.includes(u.unitId)) : all;
  const [unitId, setUnitId] = useState<string | null>(null);

  if (!market || units.length === 0) {
    return (
      <Card title="Price position against the market" subtitle="Appears once a PriceLabs market snapshot has been captured.">
        <Empty message="No market snapshot yet. The daily refresh writes one, or an admin can trigger it from the header." />
      </Card>
    );
  }

  const active = units.find((u) => u.unitId === unitId) ?? units[0];
  const HORIZON = 90;
  const points = active.points.slice(0, HORIZON);

  const chartData = points.map((p) => ({
    date: p.stayDate.slice(5),
    bandBase: p.p25 === null ? null : Math.round(p.p25),
    bandSpan: p.p25 === null || p.p90 === null ? null : Math.round(p.p90 - p.p25),
    'Market p50': p.p50 === null ? null : Math.round(p.p50),
    'Median booked': p.medianBooked === null ? null : Math.round(p.medianBooked),
    'Our live rate': p.live === null ? null : Math.round(p.live),
    Recommended: p.recommended === null ? null : Math.round(p.recommended),
  }));

  const banded = points.filter((p) => p.live !== null && p.p50 !== null && p.p90 !== null);
  const above90 = banded.filter((p) => p.live! > p.p90!).length;
  const mid = banded.filter((p) => p.live! >= p.p50! && p.live! <= p.p90!).length;
  const below50 = banded.filter((p) => p.live! < p.p50!).length;

  return (
    <Card
      title="Price position against the market"
      subtitle={
        <>
          Our live Beds24 rate inside the comp set&apos;s asking-price distribution for the next {HORIZON} nights.
          Nights already sold have no live rate, so the line has gaps — those are bookings, not missing data.
        </>
      }
      actions={
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          {units.map((u) => (
            <button
              key={u.unitId}
              onClick={() => setUnitId(u.unitId)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                active.unitId === u.unitId ? 'bg-white shadow-sm text-indigo-700' : 'text-gray-500 hover:text-gray-700'
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
          The comp set is Airbnb and VRBO listings. Those are listed prices carrying about a 3% host fee,
          while our Booking.com-facing rate absorbs roughly 17% — so the same net position makes us look
          dearer here than we are, and Booking.com-only competitors are absent altogether. Useful as position
          and as a change detector; not a target.
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
          <Tile label="Between p50 and p90" tone="emerald" value={pct(mid / banded.length, 0)} hint="the usual place to sit" />
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
            <Area type="monotone" dataKey="bandBase" stackId="band" stroke="none" fill="none" legendType="none" tooltipType="none" connectNulls />
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
            <Line type="monotone" dataKey="Market p50" stroke="#94A3B8" strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls />
            <Line type="monotone" dataKey="Median booked" stroke="#10B981" strokeWidth={1.5} dot={false} connectNulls />
            <Line type="monotone" dataKey="Recommended" stroke="#F59E0B" strokeWidth={1.5} strokeDasharray="2 2" dot={false} connectNulls />
            <Line type="monotone" dataKey="Our live rate" stroke="#4F46E5" strokeWidth={2.5} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">
        Shaded band spans the market 25th to 90th percentile. <span className="text-emerald-600">Median booked</span>{' '}
        is what comps that actually sold the night charged. <span className="text-amber-600">Recommended</span>{' '}
        is PriceLabs&apos; own suggestion for us. Benchmark drawn from {active.bedrooms}-bedroom comps
        {market.byUnit.find((u) => u.unitId === active.unitId)?.compSetListings
          ? `, ${num(market.byUnit.find((u) => u.unitId === active.unitId)!.compSetListings!)} listings`
          : ''}
        .
      </p>
    </Card>
  );
}

// ── Footnote ─────────────────────────────────────────────────────────────────

function Footnote({ data }: { data: RatesResponse }) {
  const c = data.costCoverage;
  return (
    <div className="text-[11px] text-gray-400 leading-relaxed px-1">
      {c.available ? (
        <>
          Turnover cost: {num(c.actual)} stays use the cleaning, laundry and consumables logged at their
          checkout; {num(c.estimated)}{' '}
          (not checked out yet, pre-Beds24, or unlogged) use their unit&apos;s
          average —{' '}
          {c.perCheckoutByUnit.map((u, i) => (
            <span key={u.unitId}>
              {i > 0 && ', '}
              {u.label} {czk(u.perCheckout)}
            </span>
          ))}{' '}
          per checkout. Subscriptions and wear &amp; tear are the same whichever rate sold the night, so they
          are left out of these comparisons — the Costs tab carries them.
        </>
      ) : (
        <>Turnover costs are unavailable here, so gross profit equals net sales on this tab.</>
      )}
      {data.notes.map((note) => (
        <p key={note} className="mt-1">
          {note}
        </p>
      ))}
    </div>
  );
}

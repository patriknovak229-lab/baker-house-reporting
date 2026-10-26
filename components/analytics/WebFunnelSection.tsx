'use client';
/**
 * Web funnel — what bakerhouseapartments.cz visitors did, step by step, next to the
 * direct bookings that actually landed. Admin only.
 *
 * Three sources, kept visibly apart because they mean different things:
 *  1. The site's OWN counts (anonymous, cookie-free beacons) — every visitor, so the
 *     funnel volumes and the demand view come from here. No visitor ID exists, so a
 *     rate is per search / step event, never per person.
 *  2. Real Direct-Web bookings from the bookings archive — the ground truth for the
 *     last step, dated by when they were booked.
 *  3. GA4 — traffic sources only, and only for visitors who accepted cookies. Shown
 *     as a sample, never mixed into the funnel arithmetic.
 */
import { useMemo, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { WebFunnelDay, WebFunnelResponse, WebTrafficRow } from '@/utils/analyticsTypes';
import { SELLABLE_UNITS } from '@/data/analyticsConfig';
import {
  addFunnel,
  bucketOf,
  funnelFromMetrics,
  rate,
  roomCounters,
  type FunnelCounts,
  type Granularity,
} from '@/utils/webFunnel';
import {
  AXIS_TICK,
  AXIS_TICK_DARK,
  Callout,
  Card,
  czk,
  Empty,
  GRID_STROKE,
  monthLabel,
  num,
  pct,
  Provisional,
  SERIES_COLORS,
  Table,
  Td,
  Tile,
  TOOLTIP_STYLE,
} from './kit';

const PROD_PREFIX = 'bh:funnel';

/** Beds24 room id → sellable unit label (the PriceLabs listing id ends in it). */
const ROOM_LABEL: Record<string, string> = Object.fromEntries(
  SELLABLE_UNITS.flatMap((u) => {
    const id = u.priceLabsListingId?.split('___')[1];
    return id ? [[id, u.label]] : [];
  }),
);

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-12-30" → "Wed 30 Dec 2026". */
function dayLabel(iso: string, withYear = true): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const base = `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return withYear ? `${base} ${d.getUTCFullYear()}` : base;
}

function bucketLabel(bucket: string, g: Granularity): string {
  if (g === 'month') return monthLabel(bucket);
  if (g === 'week') return `Week of ${dayLabel(bucket, false)}`;
  return dayLabel(bucket, false);
}

const ratePct = (r: number | null, digits = 0) => (r == null ? '—' : pct(r, digits));

interface Row extends FunnelCounts {
  bucket: string;
  bookings: number;
  bookingsRevenue: number;
  cancelled: number;
}

function rowOf(d: WebFunnelDay, g: Granularity): Row {
  return {
    ...funnelFromMetrics(d.metrics),
    bucket: bucketOf(d.day, g),
    bookings: d.bookings,
    bookingsRevenue: d.bookingsRevenue,
    cancelled: d.cancelled,
  };
}

function sumRows(a: Row, b: Row): Row {
  return {
    ...addFunnel(a, b),
    bucket: a.bucket,
    bookings: a.bookings + b.bookings,
    bookingsRevenue: a.bookingsRevenue + b.bookingsRevenue,
    cancelled: a.cancelled + b.cancelled,
  };
}

export default function WebFunnelSection({
  data,
  onReload,
  copyNote = null,
}: {
  data: WebFunnelResponse;
  /** Refetch this section after a manual copy; `note` is the copy's result line. */
  onReload: (note: string) => void;
  /** Result of the last "Copy now", kept by the page — the reload remounts this section. */
  copyNote?: string | null;
}) {
  const [granularity, setGranularity] = useState<Granularity>('day');

  const allMetrics = useMemo(() => {
    const out: Record<string, number> = {};
    for (const d of data.days) for (const [k, v] of Object.entries(d.metrics)) out[k] = (out[k] ?? 0) + v;
    return out;
  }, [data.days]);

  const total = useMemo(() => funnelFromMetrics(allMetrics), [allMetrics]);
  const bookings = data.days.reduce((s, d) => s + d.bookings, 0);
  const bookingsRevenue = data.days.reduce((s, d) => s + d.bookingsRevenue, 0);
  const cancelled = data.days.reduce((s, d) => s + d.cancelled, 0);

  const rows = useMemo(() => {
    const map = new Map<string, Row>();
    for (const d of data.days) {
      const r = rowOf(d, granularity);
      const prev = map.get(r.bucket);
      map.set(r.bucket, prev ? sumRows(prev, r) : r);
    }
    return [...map.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
  }, [data.days, granularity]);

  const currentBucket = bucketOf(data.todayIso, granularity);
  const hasCounts = data.countingSince != null;

  return (
    <>
      <SourceBanner data={data} onReload={onReload} copyNote={copyNote} />

      {!hasCounts ? (
        <Card title="No first-party counts yet">
          <Empty
            message={
              data.copySource.configured
                ? 'Nothing has been copied from the rental site yet. The beacon goes live with the rental-site deploy; the nightly copy (01:15 UTC) or “Copy now” then fills this tab.'
                : 'The copy job cannot reach the rental site’s Redis yet — see the note above.'
            }
          />
          {bookings > 0 && (
            <p className="text-xs text-gray-500 mt-3">
              Meanwhile, {num(bookings)} Direct-Web booking{bookings === 1 ? '' : 's'} ({czk(bookingsRevenue)}) were
              made in this period.
            </p>
          )}
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
            <Tile label="Searches" value={num(total.searches)} tone="indigo" hint="results shown or none" />
            <Tile
              label="Offers shown"
              value={num(total.offersShown)}
              tone="sky"
              hint={`${ratePct(rate(total.offersShown, total.searches))} of searches`}
            />
            <Tile
              label="Contact form"
              value={num(total.contactForm)}
              tone="violet"
              hint={`${ratePct(rate(total.contactForm, total.searches), 1)} of searches`}
            />
            <Tile
              label="Sent to Stripe"
              value={num(total.toStripe)}
              tone="amber"
              hint={total.toStripeValue > 0 ? czk(total.toStripeValue) : undefined}
            />
            <Tile
              label="Confirmed page"
              value={num(total.confirmed)}
              tone="slate"
              hint={total.confirmedValue > 0 ? czk(total.confirmedValue) : 'booking-success, de-duped'}
            />
            <Tile
              label="Web bookings"
              value={num(bookings)}
              tone="emerald"
              hint={`${czk(bookingsRevenue)} · ${ratePct(rate(bookings, total.searches), 1)} of searches`}
            />
          </div>

          <FunnelSteps total={total} bookings={bookings} />

          <Card
            title="Conversion over time"
            subtitle="Every step by the day it happened on the site. Web bookings are Direct-Web reservations from the bookings archive, by booking date — so a slow Stripe payment can land a day after its search."
            actions={
              <div className="flex rounded-md border border-gray-200 overflow-hidden text-xs">
                {(['day', 'week', 'month'] as Granularity[]).map((g) => (
                  <button
                    key={g}
                    onClick={() => setGranularity(g)}
                    className={`px-3 py-1.5 capitalize ${
                      granularity === g ? 'bg-indigo-50 text-indigo-700 font-medium' : 'bg-white text-gray-500 hover:bg-gray-50'
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            }
          >
            <div className="h-64 mb-6">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={rows.map((r) => ({
                    label: bucketLabel(r.bucket, granularity),
                    searches: r.searches,
                    contactForm: r.contactForm,
                    bookings: r.bookings,
                    conv: r.searches > 0 ? (r.bookings / r.searches) * 100 : null,
                  }))}
                  margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                >
                  <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                  <XAxis dataKey="label" tick={AXIS_TICK_DARK} axisLine={false} tickLine={false} minTickGap={16} />
                  <YAxis yAxisId="n" tick={AXIS_TICK} axisLine={false} tickLine={false} width={36} allowDecimals={false} />
                  <YAxis
                    yAxisId="r"
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
                      name === 'Search → booking'
                        ? [`${num(Number(value), 1)} %`, name]
                        : [num(Number(value)), name]
                    }
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar yAxisId="n" dataKey="searches" name="Searches" fill="#C7D2FE" radius={[3, 3, 0, 0]} />
                  <Bar yAxisId="n" dataKey="contactForm" name="Contact form" fill={SERIES_COLORS[4]} radius={[3, 3, 0, 0]} />
                  <Bar yAxisId="n" dataKey="bookings" name="Web bookings" fill={SERIES_COLORS[1]} radius={[3, 3, 0, 0]} />
                  <Line
                    yAxisId="r"
                    dataKey="conv"
                    name="Search → booking"
                    stroke={SERIES_COLORS[2]}
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <Table
              columns={[
                'Period',
                'Searches',
                'No avail.',
                'Selected',
                'Contact',
                'Stripe',
                'Confirmed',
                'Bookings',
                'Revenue',
                'Search→contact',
                'Contact→Stripe',
                'Search→booking',
              ]}
            >
              {[...rows].reverse().map((r) => (
                <tr key={r.bucket}>
                  <Td align="left">
                    {bucketLabel(r.bucket, granularity)}
                    {r.bucket === currentBucket && <Provisional />}
                  </Td>
                  <Td>{num(r.searches)}</Td>
                  <Td muted={r.noAvailability === 0}>{num(r.noAvailability)}</Td>
                  <Td>{num(r.selected)}</Td>
                  <Td>{num(r.contactForm)}</Td>
                  <Td>{num(r.toStripe)}</Td>
                  <Td>{num(r.confirmed)}</Td>
                  <Td bold>{num(r.bookings)}</Td>
                  <Td>{r.bookingsRevenue > 0 ? czk(r.bookingsRevenue) : '—'}</Td>
                  <Td>{ratePct(rate(r.contactForm, r.searches), 1)}</Td>
                  <Td>{ratePct(rate(r.toStripe, r.contactForm))}</Td>
                  <Td bold>{ratePct(rate(r.bookings, r.searches), 1)}</Td>
                </tr>
              ))}
            </Table>
            {cancelled > 0 && (
              <p className="text-[11px] text-gray-400 mt-3">
                {num(cancelled)} Direct-Web booking{cancelled === 1 ? '' : 's'} made in this period {cancelled === 1 ? 'was' : 'were'}{' '}
                later cancelled and {cancelled === 1 ? 'is' : 'are'} not counted above.
              </p>
            )}
          </Card>

          <DemandCard data={data} />

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <RoomsCard metrics={allMetrics} />
            <LanguageCard metrics={allMetrics} />
          </div>

          <DataQuality metrics={allMetrics} />
        </>
      )}

      <TrafficCard data={data} />
    </>
  );
}

// ── Source banner + manual copy ──────────────────────────────────────────────

function SourceBanner({
  data,
  onReload,
  copyNote,
}: {
  data: WebFunnelResponse;
  onReload: (note: string) => void;
  copyNote: string | null;
}) {
  const [busy, setBusy] = useState(false);

  async function copyNow() {
    setBusy(true);
    const notes: string[] = [];
    for (const [label, path] of [
      ['Funnel', '/api/cron/web-funnel-sync'],
      ['GA4', '/api/cron/ga-traffic-sync'],
    ] as const) {
      try {
        const res = await fetch(path, { method: 'POST' });
        const body = await res.json().catch(() => ({}));
        if (res.ok) {
          notes.push(
            label === 'Funnel'
              ? `Funnel: ${num(body.metricRows ?? 0)} counters, ${num(body.searchRows ?? 0)} searches copied`
              : `GA4: ${num(body.rows ?? 0)} rows`,
          );
        } else {
          notes.push(`${label}: ${body?.error ?? `HTTP ${res.status}`}`);
        }
      } catch (err) {
        notes.push(`${label}: ${err instanceof Error ? err.message : 'failed'}`);
      }
    }
    setBusy(false);
    onReload(`${notes.join(' · ')} (${new Date().toLocaleTimeString('cs-CZ')})`);
  }

  return (
    <div className="space-y-3">
      <Callout tone="sky" title="Counted by the website itself — anonymous, cookie-free, every visitor">
        Each funnel step on bakerhouseapartments.cz sends a beacon with no cookie, ID, IP or user agent, so these
        counts include visitors who reject cookies or block Google. With no visitor ID, every rate here is per
        search or step, not per person: a guest who searches three date ranges is three searches.{' '}
        {data.countingSince
          ? `Counting since ${dayLabel(data.countingSince)}; last copied ${
              data.lastCopiedAt ? new Date(data.lastCopiedAt).toLocaleString('cs-CZ') : 'never'
            }.`
          : null}{' '}
        Room and channel filters do not apply to this tab.
        <div className="mt-2 flex items-center gap-3 print:hidden">
          <button
            onClick={() => void copyNow()}
            disabled={busy}
            className="inline-flex items-center px-2.5 py-1 rounded-md border border-sky-300 bg-white text-[11px] font-medium text-sky-800 hover:bg-sky-100 disabled:opacity-50"
          >
            {busy ? 'Copying…' : 'Copy now'}
          </button>
          <span className="text-[11px] opacity-80">
            {copyNote ?? 'Runs nightly anyway (01:15 UTC funnel, 01:30 UTC GA4); this also pulls today so far.'}
          </span>
        </div>
      </Callout>
      {!data.copySource.configured && (
        <Callout tone="amber" title="The nightly copy cannot read the rental site yet">
          Set <code>RENTAL_SITE_REDIS_REST_URL</code> and <code>RENTAL_SITE_REDIS_REST_TOKEN</code> (the rental
          site’s Upstash REST URL and its <strong>read-only</strong> token) in Vercel — docs/analytics.md §10.
        </Callout>
      )}
      {data.copySource.configured && data.copySource.prefix !== PROD_PREFIX && (
        <Callout tone="amber" title={`Reading test data (${data.copySource.prefix})`}>
          FUNNEL_KEY_PREFIX points the copy at a non-production inbox — figures below are not real visitors.
        </Callout>
      )}
    </div>
  );
}

// ── Funnel steps ─────────────────────────────────────────────────────────────

function FunnelSteps({ total, bookings }: { total: FunnelCounts; bookings: number }) {
  const steps = [
    { label: 'Searched', value: total.searches, note: 'dates + guests submitted, results came back' },
    { label: 'Saw offers', value: total.offersShown, note: 'at least one bookable apartment' },
    { label: 'Chose an offer', value: total.selected, note: 'card clicked or pre-selected one kept' },
    { label: 'Opened contact form', value: total.contactForm, note: '“Continue to booking”' },
    { label: 'Sent to Stripe', value: total.toStripe, note: 'form valid, redirected to payment' },
    { label: 'Saw confirmation', value: total.confirmed, note: 'booking-success, confirmed view' },
    { label: 'Booked (archive)', value: bookings, note: 'Direct-Web reservations, not cancelled' },
  ];
  const top = Math.max(1, steps[0].value);
  return (
    <Card
      title="The funnel"
      subtitle="Each bar against all searches; the right-hand rate is the step on its own. “Chose an offer” counts every card picked, so a guest comparing two apartments adds two."
    >
      <div className="space-y-2.5">
        {steps.map((s, i) => {
          const prev = i > 0 ? steps[i - 1].value : null;
          return (
            <div key={s.label} className="grid grid-cols-[11rem_1fr_6rem_6rem] items-center gap-3 text-sm">
              <div>
                <p className="font-medium text-gray-700 leading-tight">{s.label}</p>
                <p className="text-[11px] text-gray-400 leading-tight">{s.note}</p>
              </div>
              <div className="h-6 rounded bg-gray-50 overflow-hidden">
                <div
                  className={`h-full rounded ${i === steps.length - 1 ? 'bg-emerald-400' : 'bg-indigo-300'}`}
                  style={{ width: `${Math.max(0.5, (s.value / top) * 100)}%` }}
                />
              </div>
              <p className="text-right font-semibold text-gray-900 tabular-nums">{num(s.value)}</p>
              <p className="text-right text-xs text-gray-500 tabular-nums">
                {prev == null ? '' : `${ratePct(rate(s.value, prev))} of prev.`}
              </p>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── Demand: what people asked for ────────────────────────────────────────────

function DemandCard({ data }: { data: WebFunnelResponse }) {
  const [upcomingOnly, setUpcomingOnly] = useState(true);
  const rows = data.demand.filter((r) => !upcomingOnly || r.arrival >= data.todayIso);
  const unmet = [...rows]
    .filter((r) => r.noAvailability > 0)
    .sort((a, b) => b.noAvailability - a.noAvailability || a.arrival.localeCompare(b.arrival))
    .slice(0, 20);
  const totalNone = data.demand.reduce((s, r) => s + r.noAvailability, 0);

  return (
    <Card
      title="Dates guests wanted"
      subtitle="Searches grouped by the arrival date asked for. “Nothing available” means the search returned no bookable apartment — sold out, a minimum stay, or a party too big for what was left. This is demand the booking engine turned away."
      actions={
        <label className="flex items-center gap-1.5 text-xs text-gray-500">
          <input type="checkbox" checked={upcomingOnly} onChange={(e) => setUpcomingOnly(e.target.checked)} />
          Upcoming arrivals only
        </label>
      }
    >
      {rows.length === 0 ? (
        <Empty message={upcomingOnly ? 'No searches for upcoming arrivals in this period.' : 'No searches in this period.'} />
      ) : (
        <>
          <div className="h-56 mb-6">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={rows.map((r) => ({
                  label: dayLabel(r.arrival, false),
                  found: r.searches - r.noAvailability,
                  none: r.noAvailability,
                }))}
                margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
              >
                <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                <XAxis dataKey="label" tick={AXIS_TICK_DARK} axisLine={false} tickLine={false} minTickGap={12} />
                <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={32} allowDecimals={false} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="found" stackId="s" name="Offers shown" fill="#C7D2FE" />
                <Bar dataKey="none" stackId="s" name="Nothing available" fill="#F43F5E" radius={[3, 3, 0, 0]} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <div>
              <p className="text-xs font-medium text-gray-600 mb-2">
                Arrival dates turned away most often{totalNone === 0 ? ' — none yet' : ''}
              </p>
              {unmet.length > 0 && (
                <Table columns={['Arrival', 'Searches', 'Nothing available', 'Share', 'Avg nights', 'Avg party', 'Largest']}>
                  {unmet.map((r) => (
                    <tr key={r.arrival}>
                      <Td align="left">{dayLabel(r.arrival)}</Td>
                      <Td>{num(r.searches)}</Td>
                      <Td bold>{num(r.noAvailability)}</Td>
                      <Td>{ratePct(rate(r.noAvailability, r.searches))}</Td>
                      <Td>{num(r.avgNights, 1)}</Td>
                      <Td>{num(r.avgGuests, 1)}</Td>
                      <Td>{num(r.maxGuests)}</Td>
                    </tr>
                  ))}
                </Table>
              )}
            </div>
            <div>
              <p className="text-xs font-medium text-gray-600 mb-2">By party size (all searches in the period)</p>
              <Table columns={['Guests', 'Searches', 'Nothing available']}>
                {data.partySize.map((r) => (
                  <tr key={r.guests}>
                    <Td align="left">{num(r.guests)}</Td>
                    <Td>{num(r.searches)}</Td>
                    <Td>
                      {num(r.noAvailability)}{' '}
                      <span className="text-gray-400">({ratePct(rate(r.noAvailability, r.searches))})</span>
                    </Td>
                  </tr>
                ))}
              </Table>
              <p className="text-[11px] text-gray-400 mt-2">
                No single booking on the site fits more than 4 guests (3–4 can also get two studios), so a larger
                party always sees “nothing available”.
              </p>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

// ── Rooms and language ───────────────────────────────────────────────────────

function RoomsCard({ metrics }: { metrics: Record<string, number> }) {
  const byRoom = roomCounters(metrics);
  const ids = Object.keys(byRoom).sort((a, b) => (byRoom[b].view_item_list ?? 0) - (byRoom[a].view_item_list ?? 0));
  return (
    <Card
      title="By apartment"
      subtitle="“Offered” = searches where the apartment had a bookable offer. 2× studio combos count under their studio."
    >
      {ids.length === 0 ? (
        <Empty />
      ) : (
        <Table columns={['Apartment', 'Offered', 'Chosen', 'Contact', 'Stripe', 'Confirmed']}>
          {ids.map((id) => {
            const r = byRoom[id];
            return (
              <tr key={id}>
                <Td align="left">{ROOM_LABEL[id] ?? `Room ${id}`}</Td>
                <Td>{num(r.view_item_list ?? 0)}</Td>
                <Td>
                  {num(r.select_item ?? 0)}{' '}
                  <span className="text-gray-400">({ratePct(rate(r.select_item ?? 0, r.view_item_list ?? 0))})</span>
                </Td>
                <Td>{num(r.begin_checkout ?? 0)}</Td>
                <Td>{num(r.add_payment_info ?? 0)}</Td>
                <Td>{num(r.purchase ?? 0)}</Td>
              </tr>
            );
          })}
        </Table>
      )}
    </Card>
  );
}

function LanguageCard({ metrics }: { metrics: Record<string, number> }) {
  const langs = [
    { key: 'cs', label: 'Czech pages', f: funnelFromMetrics(metrics, '|lang=cs') },
    { key: 'en', label: 'English pages', f: funnelFromMetrics(metrics, '|lang=en') },
  ];
  return (
    <Card title="By page language" subtitle="Which booking page the step happened on (/rezervace vs /en/booking).">
      <Table columns={['Pages', 'Searches', 'No avail.', 'Contact', 'Stripe', 'Confirmed', 'Search→Stripe']}>
        {langs.map(({ key, label, f }) => (
          <tr key={key}>
            <Td align="left">{label}</Td>
            <Td>{num(f.searches)}</Td>
            <Td>{ratePct(rate(f.noAvailability, f.searches))}</Td>
            <Td>{num(f.contactForm)}</Td>
            <Td>{num(f.toStripe)}</Td>
            <Td>{num(f.confirmed)}</Td>
            <Td bold>{ratePct(rate(f.toStripe, f.searches), 1)}</Td>
          </tr>
        ))}
      </Table>
      <p className="text-[11px] text-gray-400 mt-3">
        Corporate enquiries sent: {num(metrics.generate_lead ?? 0)}.
      </p>
    </Card>
  );
}

function DataQuality({ metrics }: { metrics: Record<string, number> }) {
  const dropped = Object.entries(metrics)
    .filter(([k]) => k.startsWith('_dropped|'))
    .map(([k, v]) => `${k.slice('_dropped|'.length)} ${num(v)}`);
  const labels: Record<string, string> = {
    bot: 'crawler user agents',
    invalid: 'malformed or cross-site',
    rate: 'over 600/min',
    cap: 'over 20 000/day',
    dupe: 'confirmation-page reloads',
  };
  return (
    <p className="text-[11px] text-gray-400 leading-relaxed">
      Beacons accepted: {num(metrics._accepted ?? 0)}.{' '}
      {dropped.length > 0
        ? `Refused: ${dropped.join(' · ')} (${Object.entries(labels)
            .map(([k, v]) => `${k} = ${v}`)
            .join(', ')}).`
        : 'None refused.'}
    </p>
  );
}

// ── GA4 traffic sources ──────────────────────────────────────────────────────

function TrafficCard({ data }: { data: WebFunnelResponse }) {
  const { ga } = data;
  const sessions = ga.channels.reduce((s, r) => s + r.sessions, 0);
  return (
    <Card
      title="Traffic sources — GA4 sample"
      subtitle="Google Analytics only sees visitors who accepted cookies and don't block Google, so these are a SAMPLE: use them for the channel mix, never for volumes. Purchases are GA's own count, sent only since 26 Oct 2026."
    >
      {!ga.configured && ga.channels.length === 0 ? (
        <Callout tone="amber" title="GA4 is not connected yet">
          Create a Google Cloud service account, add it as <strong>Viewer</strong> on GA property 529936917, and put
          its JSON key in Vercel as <code>GA4_SERVICE_ACCOUNT_JSON</code> — click-by-click steps in docs/analytics.md
          §10. Until then the nightly GA sync answers 503 and this table stays empty.
        </Callout>
      ) : ga.channels.length === 0 ? (
        <Empty message="No GA4 traffic stored for this period yet." />
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <TrafficTable title="Default channel group" rows={ga.channels} sessions={sessions} />
          <TrafficTable title="Source / medium (top 20)" rows={ga.sourceMedium} sessions={sessions} />
          <p className="text-[11px] text-gray-400 xl:col-span-2">
            {ga.purchaseCheck
              ? `From ${dayLabel(ga.purchaseCheck.since, false)} (when the site started sending purchases to GA) to ${dayLabel(
                  ga.purchaseCheck.until,
                  false,
                )}, GA recorded ${num(ga.purchaseCheck.gaPurchases)} purchase${
                  ga.purchaseCheck.gaPurchases === 1 ? '' : 's'
                } against ${num(ga.purchaseCheck.webBookings)} real web booking${
                  ga.purchaseCheck.webBookings === 1 ? '' : 's'
                }${
                  ga.purchaseCheck.webBookings > 0
                    ? ` — GA sees about ${ratePct(rate(ga.purchaseCheck.gaPurchases, ga.purchaseCheck.webBookings))} of them`
                    : ''
                }. `
              : 'GA purchases are only sent from 26 Oct 2026, so this period has nothing to compare. '}
            Users are summed per day, so a returning visitor counts once per day.
            {ga.lastFetchedAt ? ` Last pulled ${new Date(ga.lastFetchedAt).toLocaleString('cs-CZ')}.` : ''}
          </p>
        </div>
      )}
    </Card>
  );
}

function TrafficTable({ title, rows, sessions }: { title: string; rows: WebTrafficRow[]; sessions: number }) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-600 mb-2">{title}</p>
      <Table columns={['', 'Sessions', 'Share', 'Users (daily)', 'Purchases', 'Revenue']}>
        {rows.map((r) => (
          <tr key={r.key}>
            <Td align="left">{r.key}</Td>
            <Td>{num(r.sessions)}</Td>
            <Td muted>{ratePct(rate(r.sessions, sessions))}</Td>
            <Td>{num(r.users)}</Td>
            <Td>{num(r.purchases)}</Td>
            <Td>{r.revenue > 0 ? czk(r.revenue) : '—'}</Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

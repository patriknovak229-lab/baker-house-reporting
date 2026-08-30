'use client';
/**
 * Parity check — what a customer actually sees on each channel, from the
 * local Mac runner's scrapes (Booking/Airbnb) + Beds24 offers (Web).
 *
 * The centrepiece is the 60-day board: one row per check-in date, one column
 * per unit. Occupancy (sellable or not) comes from the daily full-window
 * Beds24 sweep, so it is complete every day; channel prices come from the
 * scrape rotation (daily inside ~3 weeks, every ~3 days beyond), so a cell's
 * price can be a day or two older than its availability — each cell's tooltip
 * carries its capture times.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { COMPETITORS } from '@/data/parityConfig';
import type {
  BoardObservation,
  BoardRow,
  ParityOffer,
  ParityResponse,
  ParitySlotView,
} from '@/utils/parityTypes';

// ── Formatting ────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];

/** "2026-09-06" → "Sept 6". */
function fmtDay(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
}

/** "2026-09-06", "2026-09-08" → "Sept 6 – Sept 8". */
function fmtRange(fromIso: string, toIso: string): string {
  return `${fmtDay(fromIso)} – ${fmtDay(toIso)}`;
}

/** Weekday shorthand for board rows: "Sat". */
function weekday(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
}

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 }).format(n);
}

function fmtNightly(total: number | null | undefined, nights: number): string {
  if (total == null) return '—';
  return fmt(Math.round(total / nights)) + '/night';
}

function discountPct(offer: ParityOffer): number | null {
  if (offer.price == null || offer.originalPrice == null || offer.originalPrice <= offer.price) return null;
  return Math.round(((offer.originalPrice - offer.price) / offer.originalPrice) * 100);
}

function formatTs(ts: string): string {
  return new Date(ts).toLocaleString('en-GB', {
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });
}

function ageHours(ts: string): number {
  return (Date.now() - new Date(ts).getTime()) / 3_600_000;
}

// ── Discount badge canon — same real-world discount, same badge, any channel ──

const DISCOUNT_CATEGORY = {
  weekly:   { label: 'Weekly discount',    class: 'bg-blue-100 text-blue-800 ring-1 ring-blue-200',           deviceLogin: false },
  monthly:  { label: 'Monthly discount',   class: 'bg-cyan-100 text-cyan-800 ring-1 ring-cyan-200',           deviceLogin: false },
  early:    { label: 'Early booking',      class: 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200',  deviceLogin: false },
  lastMin:  { label: 'Last-minute',        class: 'bg-orange-100 text-orange-800 ring-1 ring-orange-200',     deviceLogin: false },
  mobile:   { label: 'Mobile-only',        class: 'bg-purple-100 text-purple-800 ring-1 ring-purple-200',     deviceLogin: true  },
  longStay: { label: 'Long-stay discount', class: 'bg-sky-100 text-sky-800 ring-1 ring-sky-200',              deviceLogin: false },
  newList:  { label: 'New-listing promo',  class: 'bg-pink-100 text-pink-800 ring-1 ring-pink-200',           deviceLogin: false },
  host:     { label: 'Host discount',      class: 'bg-teal-100 text-teal-800 ring-1 ring-teal-200',           deviceLogin: false },
  genius:   { label: 'Genius',             class: 'bg-indigo-100 text-indigo-800 ring-1 ring-indigo-200',     deviceLogin: true  },
  getaway:  { label: 'Getaway/campaign',   class: 'bg-lime-100 text-lime-800 ring-1 ring-lime-200',           deviceLogin: false },
  generic:  { label: 'Discount',           class: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',           deviceLogin: false },
} as const;

type DiscountCategoryKey = keyof typeof DISCOUNT_CATEGORY;

function categorizeDiscount(name: string): DiscountCategoryKey {
  const lc = name.toLowerCase();
  if (/\bweekly\b|t[ýy]denn[ií]|t[ýy]dn/.test(lc))                    return 'weekly';
  if (/\bmonthly\b|m[ěe]s[ií]?[čc]n[ií]/.test(lc))                    return 'monthly';
  if (/early\s*(booker?|booking)|brzk[ou][ou]?\s*rezervaci/.test(lc)) return 'early';
  if (/last[- ]?minute|posledn[ií]\s*chv[ií]li/.test(lc))             return 'lastMin';
  if (/mobile[- ]?only|mobiln[ií]/.test(lc))                          return 'mobile';
  if (/long[- ]?stay/.test(lc))                                       return 'longStay';
  if (/new[- ]?listing|nov[áa]\s*nab[ií]dka/.test(lc))                return 'newList';
  if (/host\s*discount|owner\s*(?:discount|decreased)|hostitel/.test(lc)) return 'host';
  if (/genius/.test(lc))                                              return 'genius';
  if (/getaway|smart\s*deal|limited[- ]?time/.test(lc))               return 'getaway';
  return 'generic';
}

// ── B vs A gap — same traffic-light rule the alerts use ───────────────────────

function computeAbGap(airbnb: number | null, booking: number | null): number | null {
  if (airbnb == null || booking == null || airbnb === 0) return null;
  return Math.round(((booking - airbnb) / airbnb) * 100);
}

function abGapClass(gap: number | null): string {
  if (gap == null) return 'text-gray-400';
  if (gap <= 0) return 'text-red-700 font-bold';
  if (gap > 30) return 'text-red-700 font-bold';
  if (gap > 15) return 'text-amber-600 font-medium';
  return 'text-emerald-600 font-medium';
}

function formatAbGap(gap: number | null): string {
  if (gap == null) return '';
  return `${gap > 0 ? '+' : ''}${gap}%`;
}

// ── Board cells ───────────────────────────────────────────────────────────────

function offerTooltip(name: string, o: BoardObservation, nights: number): string {
  const lines = [
    `${name}: ${fmt(o.price)} (${fmtNightly(o.price, nights)})`,
    o.originalPrice != null ? `was ${fmt(o.originalPrice)} (−${discountPct(o)}%)` : null,
    ...(o.discountBreakdown ?? []).map((d) => `  ${d.name}${d.pp != null ? ` −${d.pp}pp` : ''}`),
    ...(o.labels.length > 0 ? [o.labels.join(' · ')] : []),
    `observed ${formatTs(o.capturedAt)}`,
  ];
  return lines.filter(Boolean).join('\n');
}

function ChannelLine({
  tag,
  obs,
  nights,
  highlight,
}: {
  tag: string;
  obs: BoardObservation | null;
  nights: number;
  highlight?: string;
}) {
  if (!obs) return null;
  if (obs.price === null) {
    return (
      <div className="text-[11px] text-gray-300 tabular-nums leading-4" title={`${tag}: not bookable (${formatTs(obs.capturedAt)})`}>
        {tag} —
      </div>
    );
  }
  const pct = discountPct(obs);
  const stale = ageHours(obs.capturedAt) > 36;
  return (
    <div
      className={`text-[11px] tabular-nums leading-4 whitespace-nowrap ${highlight ?? 'text-gray-700'}`}
      title={offerTooltip(tag, obs, nights)}
    >
      <span className="text-gray-400">{tag}</span> {Math.round(obs.price).toLocaleString('cs-CZ')}
      {pct !== null && <span className="text-emerald-600"> −{pct}%</span>}
      {stale && <span className="text-amber-500" title="observation older than 36 h"> ◦</span>}
    </div>
  );
}

function BoardCellView({ cell, nights }: { cell: BoardRow['units'][number]; nights: number }) {
  if (cell.sellable === null) {
    return <td className="px-3 py-1.5 text-center text-gray-200 border-l border-gray-100">·</td>;
  }
  if (cell.sellable === false) {
    return (
      <td className="px-3 py-1.5 border-l border-gray-100 bg-gray-50/80">
        <span className="text-[11px] text-gray-400" title={cell.web ? `No online offer (booked, blocked or min-stay) — checked ${formatTs(cell.web.capturedAt)}` : undefined}>
          booked
        </span>
      </td>
    );
  }
  const gap = computeAbGap(cell.airbnb?.price ?? null, cell.booking?.price ?? null);
  const undercut = gap !== null && (gap <= 0 || gap > 30);
  return (
    <td className={`px-3 py-1.5 border-l border-gray-100 align-top ${undercut ? 'bg-red-50/70' : ''}`}>
      <ChannelLine tag="W" obs={cell.web} nights={nights} />
      <ChannelLine tag="A" obs={cell.airbnb} nights={nights} />
      <ChannelLine tag="B" obs={cell.booking} nights={nights} highlight={undercut ? 'text-red-700 font-semibold' : undefined} />
      {gap !== null && (
        <div className={`text-[10px] leading-4 ${abGapClass(gap)}`} title="Booking over Airbnb">
          B/A {formatAbGap(gap)}
        </div>
      )}
    </td>
  );
}

function Board({ rows, title, subtitle }: { rows: BoardRow[]; title: string; subtitle: string }) {
  const [expanded, setExpanded] = useState(false);
  const unitHeads = rows[0]?.units ?? [];
  const visible = expanded ? rows : rows.slice(0, 21);
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
        <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 flex items-center justify-center h-24 text-gray-400 text-sm">
          No observations yet — the next grid run fills this in.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase w-40">Check-in</th>
                {unitHeads.map((u) => (
                  <th key={u.unitId} className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase border-l border-gray-100">
                    {u.unitLabel}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visible.map((row) => {
                const isWeekendStart = ['Fri', 'Sat'].includes(weekday(row.checkIn));
                return (
                  <tr key={row.checkIn} className={isWeekendStart ? 'bg-indigo-50/40' : ''}>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <span className="text-gray-800 font-medium">{fmtRange(row.checkIn, row.checkOut)}</span>
                      <span className="text-[10px] text-gray-400 ml-1.5">{weekday(row.checkIn)}</span>
                    </td>
                    {row.units.map((cell) => (
                      <BoardCellView key={cell.unitId} cell={cell} nights={row.nights} />
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > visible.length && (
            <button
              onClick={() => setExpanded(true)}
              className="w-full py-2 text-xs text-indigo-600 hover:bg-indigo-50 border-t border-gray-100"
            >
              Show all {rows.length} dates
            </button>
          )}
          {expanded && rows.length > 21 && (
            <button
              onClick={() => setExpanded(false)}
              className="w-full py-2 text-xs text-gray-500 hover:bg-gray-50 border-t border-gray-100"
            >
              Collapse
            </button>
          )}
        </div>
      )}
    </section>
  );
}

// ── Custom check result card (unchanged data shape, new date format) ──────────

function OfferCell({ offer, nights }: { offer: ParityOffer | null; nights: number }) {
  if (!offer || offer.price == null) {
    const label =
      offer?.availability === 'error' ? 'scrape error' :
      offer?.availability === 'not_available' ? 'Not available' : '—';
    return (
      <td className="px-4 py-2.5 text-right align-top">
        <div className={`text-xs italic ${offer?.availability === 'error' ? 'text-red-400' : 'text-gray-400'}`}>{label}</div>
      </td>
    );
  }
  const pct = discountPct(offer);
  return (
    <td className="px-4 py-2.5 text-right tabular-nums text-gray-800 align-top">
      <div className="font-semibold">{fmt(offer.price)}</div>
      <div className="text-xs text-gray-500">{fmtNightly(offer.price, nights)}</div>
      {offer.originalPrice != null && pct != null && (
        <div className="text-xs text-gray-500 mt-0.5">
          <span className="line-through">{fmt(offer.originalPrice)}</span>
          <span className="ml-1 text-emerald-700 font-semibold">−{pct}%</span>
          {offer.unparsedDiscount && <span className="ml-1 text-amber-600 text-[10px]">(unbreakable)</span>}
        </div>
      )}
      {(offer.discountBreakdown?.length || offer.labels.length > 0) && (
        <div className="mt-1.5 flex flex-wrap gap-1 justify-end max-w-[240px] ml-auto">
          {(offer.discountBreakdown ?? []).map((d, i) => {
            const cat = DISCOUNT_CATEGORY[categorizeDiscount(d.name)];
            return (
              <span key={`b${i}`} className={`inline-block text-[11px] leading-tight px-1.5 py-0.5 rounded font-medium ${cat.class}`}
                title={cat.deviceLogin ? 'Login/device-locked discount — not what an anonymous desktop user sees' : undefined}>
                {cat.deviceLogin && <span aria-hidden className="mr-0.5">🔒</span>}
                {cat.label}{d.pp != null && <span className="font-bold"> −{d.pp}pp</span>}
              </span>
            );
          })}
          {(() => {
            const seen = new Set((offer.discountBreakdown ?? []).map((d) => categorizeDiscount(d.name)));
            return offer.labels
              .filter((l) => {
                const cat = categorizeDiscount(l);
                if (seen.has(cat) && cat !== 'generic') return false;
                seen.add(cat);
                return true;
              })
              .slice(0, 3)
              .map((l, i) => {
                const cat = DISCOUNT_CATEGORY[categorizeDiscount(l)];
                const isGeneric = categorizeDiscount(l) === 'generic';
                return (
                  <span key={`l${i}`} className={`inline-block text-[10px] leading-tight px-1.5 py-0.5 rounded font-medium ${cat.class}`}
                    title={cat.deviceLogin ? 'Login/device-locked discount' : undefined}>
                    {cat.deviceLogin && <span aria-hidden className="mr-0.5">🔒</span>}
                    {isGeneric ? l : cat.label}
                  </span>
                );
              });
          })()}
        </div>
      )}
    </td>
  );
}

function SlotCard({ slot }: { slot: ParitySlotView }) {
  return (
    <div className="rounded-lg border border-gray-200 overflow-hidden">
      <div className="bg-gray-50 px-4 py-2 border-b border-gray-200 flex items-baseline justify-between flex-wrap gap-2">
        <div className="font-semibold text-gray-800">{fmtRange(slot.checkIn, slot.checkOut)}</div>
        <div className="text-xs text-gray-500">
          {slot.nights} night{slot.nights === 1 ? '' : 's'} · booked {slot.leadDays} day{slot.leadDays === 1 ? '' : 's'} ahead
        </div>
      </div>
      <table className="min-w-full text-sm">
        <thead className="bg-white border-b border-gray-100">
          <tr>
            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase w-44">Unit</th>
            <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Web</th>
            <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Airbnb</th>
            <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Booking.com</th>
            <th className="px-4 py-2 text-center text-xs font-medium text-gray-500 uppercase w-24">B vs A</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {slot.units.map((cell) => {
            const gap = computeAbGap(cell.airbnb?.price ?? null, cell.booking?.price ?? null);
            return (
              <tr key={cell.unitId}>
                <td className="px-4 py-2.5 align-top">
                  <span className="text-sm font-medium text-gray-800">{cell.unitLabel}</span>
                </td>
                <OfferCell offer={cell.web} nights={slot.nights} />
                <OfferCell offer={cell.airbnb} nights={slot.nights} />
                <OfferCell offer={cell.booking} nights={slot.nights} />
                <td className={`px-4 py-2.5 text-center align-top ${abGapClass(gap)}`}>{formatAbGap(gap) || '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Competitors ───────────────────────────────────────────────────────────────

function CompetitorSection({ observations }: { observations: ParityResponse['competitors'] }) {
  if (COMPETITORS.length === 0) return null;
  return (
    <section className="border-t border-gray-200 pt-8">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Competitors</h2>
      <p className="text-xs text-gray-500 mb-4">
        Configured competitor listings, priced alongside each grid run (per-night rates for the sampled stays).
      </p>
      {observations.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 flex items-center justify-center h-20 text-gray-400 text-sm">
          No competitor observations yet — they arrive with the next grid run.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Competitor</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Stay</th>
                <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 uppercase">Channel</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Total</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Per night</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {observations.map((o, i) => (
                <tr key={i}>
                  <td className="px-3 py-2 text-gray-800">{o.label} <span className="text-xs text-gray-400">({o.bedrooms}BR)</span></td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                    {fmtRange(o.checkIn, addDaysIso(o.checkIn, o.nights))} · {o.nights}n
                  </td>
                  <td className="px-3 py-2 text-center text-xs text-gray-500">{o.channel}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(o.price)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-500">{fmtNightly(o.price, o.nights)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Main view ─────────────────────────────────────────────────────────────────

export default function ParityView() {
  const [data, setData] = useState<ParityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [checkIn, setCheckIn] = useState('');
  const [nights, setNights] = useState('2');
  const [queueing, setQueueing] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/pricing/parity');
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      setData(await res.json());
      setError(null);
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const hasPending = useMemo(() => data?.requests.some((r) => r.status === 'pending') ?? false, [data]);
  useEffect(() => {
    if (hasPending && !pollTimer.current) {
      pollTimer.current = setInterval(() => load(true), 20_000);
    }
    if (!hasPending && pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    return () => {
      if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
    };
  }, [hasPending, load]);

  async function queueCheck() {
    if (!checkIn) return;
    setQueueing(true);
    setQueueError(null);
    try {
      const res = await fetch('/api/pricing/parity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkIn, nights: Number(nights) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Failed (${res.status})`);
      }
      await load(true);
    } catch (e) {
      setQueueError(e instanceof Error ? e.message : 'Failed to queue');
    } finally {
      setQueueing(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400 text-sm gap-2">
        <span className="w-5 h-5 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
        Loading parity data…
      </div>
    );
  }
  if (error) {
    return <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>;
  }

  const gridAgeHours = data?.latestGridAt ? ageHours(data.latestGridAt) : null;

  return (
    <div className="space-y-10">
      {gridAgeHours !== null && gridAgeHours > 26 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Last grid run is {Math.round(gridAgeHours)} h old — the Mac parity runner has not reported today.
          Check the launchd job (docs/pricing-runner.md).
        </div>
      )}

      <Board
        rows={data?.board2n ?? []}
        title="Next 60 days — 2-night stays"
        subtitle="One row per check-in. Occupancy (booked/sellable) is re-checked against Beds24 every day for every date; W = our site, A = Airbnb, B = Booking.com customer prices from the scrape rotation (daily for ~3 weeks out, every ~3 days beyond — ◦ marks an observation older than 36 h). Red rows: Booking undercuts Airbnb or exceeds +30%. Weekend check-ins tinted."
      />

      <Board
        rows={data?.board7n ?? []}
        title="7-night stays"
        subtitle="Weekly-rate coverage: every check-in date is re-scraped on a 7-day rotation, so the board fills over the week. Same reading as above."
      />

      <CompetitorSection observations={data?.competitors ?? []} />

      <section className="border-t border-gray-200 pt-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Custom date check</h2>
        <p className="text-xs text-gray-500 mb-4">
          Queued for the Mac runner — results appear here within ~5 minutes while the Mac is awake.
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Check-in</label>
            <input
              type="date"
              value={checkIn}
              onChange={(e) => setCheckIn(e.target.value)}
              className="block border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Stay length</label>
            <select
              value={nights}
              onChange={(e) => setNights(e.target.value)}
              className="block border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {['1', '2', '3', '7', '14', '28'].map((n) => (
                <option key={n} value={n}>{n} night{n === '1' ? '' : 's'}</option>
              ))}
            </select>
          </div>
          <button
            onClick={queueCheck}
            disabled={!checkIn || queueing}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-800 text-white text-sm font-medium hover:bg-gray-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {queueing ? 'Queueing…' : 'Queue check'}
          </button>
          {queueError && <span className="text-sm text-red-600">{queueError}</span>}
        </div>

        {data && data.requests.length > 0 && (
          <div className="mt-6 space-y-4">
            {data.requests.map((r) => (
              <div key={r.id}>
                <div className="flex items-center gap-2 text-sm mb-2">
                  <span className="text-gray-700 font-medium">{fmtDay(r.checkIn)} · {r.nights}n</span>
                  {r.status === 'pending' && (
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs font-medium">
                      <span className="w-2.5 h-2.5 border border-amber-600 border-t-transparent rounded-full animate-spin" />
                      queued for the runner
                    </span>
                  )}
                  {r.status === 'done' && (
                    <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-xs font-medium">done</span>
                  )}
                  {r.status === 'error' && (
                    <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-xs font-medium" title={r.error ?? undefined}>
                      {r.error ?? 'error'}
                    </span>
                  )}
                  <span className="text-xs text-gray-400 ml-auto">requested {formatTs(r.requestedAt)}</span>
                </div>
                {r.result && r.result.map((slot) => (
                  <SlotCard key={`${r.id}-${slot.checkIn}-${slot.nights}`} slot={slot} />
                ))}
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="text-xs text-gray-400">
        Prices are what an anonymous, logged-out desktop visitor pays — Genius and mobile-app rates are excluded by
        design (🔒 marks them where a channel leaks the label) · Airbnb covers only units with their own listing ·
        B vs A bands: ≤0 and &gt;30% alert · 0–15% healthy.
      </p>
    </div>
  );
}

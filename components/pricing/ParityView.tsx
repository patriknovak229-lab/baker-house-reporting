'use client';
/**
 * Parity check — what a customer actually sees on each channel, from the
 * local Mac runner's scrapes (Booking/Airbnb) + Beds24 offers (Web).
 *
 * Reads /api/pricing/parity (Postgres). The runner reports on its own
 * schedule; this view is honest about staleness rather than pretending to be
 * live. Custom checks are queued here and picked up by the runner's next poll
 * (≤ ~5 minutes), so the form shows a "queued" state instead of a spinner
 * that implies seconds.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ParityCell, ParityOffer, ParityResponse, ParitySlotView } from '@/utils/parityTypes';

// ── Formatting ────────────────────────────────────────────────────────────────

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
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
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
  if (gap <= 0) return 'text-red-700 font-bold animate-pulse';
  if (gap > 30) return 'text-red-700 font-bold animate-pulse';
  if (gap > 15) return 'text-amber-600 font-medium';
  return 'text-emerald-600 font-medium';
}

function formatAbGap(gap: number | null): string {
  if (gap == null) return '—';
  return `${gap > 0 ? '+' : ''}${gap}%`;
}

// ── Cells ─────────────────────────────────────────────────────────────────────

function OfferCell({ offer, nights, expected }: { offer: ParityOffer | null; nights: number; expected?: number | null }) {
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
  const drift =
    expected != null && offer.price != null
      ? Math.round((Math.abs(offer.price - expected) / expected) * 1000) / 10
      : null;

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
      {drift != null && drift > 2 && (
        <div className="text-[10px] text-rose-600 mt-0.5" title={`Configured channel economics expect ${fmt(expected)}`}>
          expected {fmt(expected)} ({drift}% drift)
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

// ── Slot table ────────────────────────────────────────────────────────────────

function unitRowClass(unitId: string): string {
  if (unitId === 'deluxe-1kk') return 'border-l-4 border-sky-500';
  if (unitId === 'k201') return 'border-l-4 border-fuchsia-500';
  if (unitId === 'o308') return 'border-l-4 border-violet-500';
  if (unitId === 'urban-1kk') return 'border-l-4 border-teal-500';
  return 'border-l-4 border-gray-300';
}

function SlotCard({ slot }: { slot: ParitySlotView }) {
  // Units with no channel data at all (nothing configured) still render, so
  // the coverage gap stays visible instead of silently narrowing the table.
  const rows: ParityCell[] = slot.units;
  return (
    <div className="rounded-lg border border-gray-200 overflow-hidden">
      <div className="bg-gray-50 px-4 py-2 border-b border-gray-200 flex items-baseline justify-between flex-wrap gap-2">
        <div className="font-semibold text-gray-800">
          {slot.checkIn} → {slot.checkOut}
        </div>
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
          {rows.map((cell) => {
            const gap = computeAbGap(cell.airbnb?.price ?? null, cell.booking?.price ?? null);
            return (
              <tr key={cell.unitId} className={unitRowClass(cell.unitId)}>
                <td className="px-4 py-2.5 align-top">
                  <span className="text-sm font-medium text-gray-800">{cell.unitLabel}</span>
                </td>
                <OfferCell offer={cell.web} nights={slot.nights} />
                <OfferCell offer={cell.airbnb} nights={slot.nights} />
                <OfferCell offer={cell.booking} nights={slot.nights} expected={cell.expectedBooking} />
                <td className={`px-4 py-2.5 text-center align-top ${abGapClass(gap)}`}>{formatAbGap(gap)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
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

  // Poll while any request is pending — the runner answers within ~5 minutes.
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

  const grid = data?.latestGrid ?? null;
  const gridAgeHours = grid ? (Date.now() - new Date(grid.capturedAt).getTime()) / 3_600_000 : null;

  return (
    <div className="space-y-10">
      {gridAgeHours !== null && gridAgeHours > 26 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Last grid run is {Math.round(gridAgeHours)} h old — the Mac parity runner has not reported today.
          Check the launchd job (docs/pricing-runner.md).
        </div>
      )}

      <section>
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Daily grid</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              The same relative windows sampled every morning — customer-view totals for an anonymous desktop visitor,
              scraped from the Mac runner (residential IP). Web = Beds24 offers, the price the site itself charges.
            </p>
          </div>
          {grid && <span className="text-xs text-gray-400">Captured {formatTs(grid.capturedAt)}</span>}
        </div>

        {!grid ? (
          <div className="rounded-lg border border-dashed border-gray-300 flex flex-col items-center justify-center h-40 text-gray-400 text-sm px-6 text-center">
            <p>No grid runs yet.</p>
            <p className="text-xs mt-1">Set up the local runner on the Mac — see <code>docs/pricing-runner.md</code>. It reports the first grid within one poll cycle.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {grid.slots.map((slot) => (
              <SlotCard key={`${slot.checkIn}-${slot.nights}`} slot={slot} />
            ))}
          </div>
        )}
      </section>

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
                  <span className="text-gray-700 font-medium">{r.checkIn} · {r.nights}n</span>
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
        🔒 = login/device-locked discount, shown for information but not counted as the anonymous price ·
        B vs A bands: ≤0 and &gt;30% alert · 0–15% healthy · Airbnb covers only units with their own listing.
      </p>
    </div>
  );
}

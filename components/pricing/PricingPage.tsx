'use client';
import { useState, useEffect, useCallback } from 'react';
import type { PricingResult, Offer } from '@/utils/platformScraper';

// ─────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 }).format(n);
}

function fmtNightly(total: number | null | undefined, nights: number): string {
  if (total == null) return '—';
  return fmt(Math.round(total / nights)) + '/night';
}

function discountPct(offer: Offer): number | null {
  if (offer.price == null || offer.originalPrice == null || offer.originalPrice <= offer.price) return null;
  return Math.round(((offer.originalPrice - offer.price) / offer.originalPrice) * 100);
}

function formatTs(ts: string): string {
  return new Date(ts).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ─────────────────────────────────────────────
// Legacy data normalizer
// ─────────────────────────────────────────────

function toOffer(v: unknown): Offer {
  if (v == null) return { price: null, originalPrice: null, labels: [] };
  if (typeof v === 'number') return { price: v, originalPrice: null, labels: [] };
  if (typeof v === 'object') {
    const o = v as Partial<Offer>;
    return {
      price: typeof o.price === 'number' ? o.price : null,
      originalPrice: typeof o.originalPrice === 'number' ? o.originalPrice : null,
      labels: Array.isArray(o.labels) ? o.labels : [],
      discountBreakdown: Array.isArray(o.discountBreakdown) ? o.discountBreakdown : undefined,
      unparsedDiscount: typeof o.unparsedDiscount === 'boolean' ? o.unparsedDiscount : undefined,
      availability: typeof o.availability === 'string' ? o.availability : undefined,
    };
  }
  return { price: null, originalPrice: null, labels: [] };
}

function normalizeResult(result: PricingResult): PricingResult {
  return {
    ...result,
    runs: result.runs.map((run) => ({
      ...run,
      rooms: run.rooms.map((room) => ({
        ...room,
        web: toOffer((room as unknown as Record<string, unknown>).web),
        airbnb: toOffer((room as unknown as Record<string, unknown>).airbnb),
        bookingCom: toOffer((room as unknown as Record<string, unknown>).bookingCom),
      })),
    })),
  };
}

// ─────────────────────────────────────────────
// Room / night / discount styling
// ─────────────────────────────────────────────

const ROOM_ORDER: Record<string, number> = { '1KK Deluxe': 0, '2KK Deluxe': 1 };

function roomBorderClass(roomLabel: string): string {
  if (roomLabel === '1KK Deluxe') return 'border-l-4 border-sky-500';
  if (roomLabel === '2KK Deluxe') return 'border-l-4 border-fuchsia-500';
  return 'border-l-4 border-gray-300';
}

function roomBadgeClass(roomLabel: string): string {
  if (roomLabel === '1KK Deluxe') return 'text-sky-800 bg-sky-50';
  if (roomLabel === '2KK Deluxe') return 'text-fuchsia-800 bg-fuchsia-50';
  return 'text-gray-700 bg-gray-100';
}

function nightsRowClass(nights: number): string {
  // Strong visual distinction: 2n on white, 7n on noticeable slate tint + left-edge marker
  return nights === 7
    ? 'bg-slate-100 border-t-2 border-slate-300'
    : 'bg-white';
}

// Discounts are bucketed into a small set of canonical categories so the
// same real-world discount shows with the same badge no matter which
// platform named it. Booking.com calls the 7-night discount "Weekly rate";
// Airbnb calls it "Weekly stay discount". Both should render the same way.
const DISCOUNT_CATEGORY = {
  weekly:   { label: 'Weekly discount',       class: 'bg-blue-100 text-blue-800 ring-1 ring-blue-200' },
  monthly:  { label: 'Monthly discount',      class: 'bg-cyan-100 text-cyan-800 ring-1 ring-cyan-200' },
  early:    { label: 'Early booking',         class: 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200' },
  lastMin:  { label: 'Last-minute',           class: 'bg-orange-100 text-orange-800 ring-1 ring-orange-200' },
  mobile:   { label: 'Mobile-only',           class: 'bg-purple-100 text-purple-800 ring-1 ring-purple-200' },
  longStay: { label: 'Long-stay discount',    class: 'bg-sky-100 text-sky-800 ring-1 ring-sky-200' },
  newList:  { label: 'New-listing promo',     class: 'bg-pink-100 text-pink-800 ring-1 ring-pink-200' },
  host:     { label: 'Host discount',         class: 'bg-teal-100 text-teal-800 ring-1 ring-teal-200' },
  genius:   { label: 'Genius',                class: 'bg-indigo-100 text-indigo-800 ring-1 ring-indigo-200' },
  generic:  { label: 'Discount',              class: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200' },
} as const;

type DiscountCategoryKey = keyof typeof DISCOUNT_CATEGORY;

function categorizeDiscount(name: string): DiscountCategoryKey {
  const lc = name.toLowerCase();
  if (/\bweekly\b/.test(lc))                       return 'weekly';
  if (/\bmonthly\b/.test(lc))                      return 'monthly';
  if (/early\s*(booker?|booking)/.test(lc))        return 'early';
  if (/last[- ]?minute/.test(lc))                  return 'lastMin';
  if (/mobile[- ]?only/.test(lc))                  return 'mobile';
  if (/long[- ]?stay/.test(lc))                    return 'longStay';
  if (/new[- ]?listing/.test(lc))                  return 'newList';
  if (/host\s*discount|owner\s*(?:discount|decreased)/.test(lc)) return 'host';
  if (/genius/.test(lc))                           return 'generic'; // (Genius has its own treatment elsewhere)
  return 'generic';
}

function discountBadgeClass(name: string): string {
  return DISCOUNT_CATEGORY[categorizeDiscount(name)].class;
}

function discountDisplayName(name: string): string {
  return DISCOUNT_CATEGORY[categorizeDiscount(name)].label;
}

// ─────────────────────────────────────────────
// Booking-vs-Airbnb gap: (Booking − Airbnb) / Airbnb × 100
// Magnitude-based coloring regardless of direction.
// ─────────────────────────────────────────────

function computeAbGap(airbnb: number | null, booking: number | null): number | null {
  if (airbnb == null || booking == null || airbnb === 0) return null;
  return Math.round(((booking - airbnb) / airbnb) * 100);
}

function abGapClass(gap: number | null): string {
  if (gap == null) return 'text-gray-400';
  if (gap <= 0) return 'text-red-700 font-bold animate-pulse';  // Booking ≤ Airbnb — alert
  if (gap > 30) return 'text-red-700 font-bold animate-pulse';  // Excessive markup — alert
  if (gap > 15) return 'text-amber-600 font-medium';
  return 'text-emerald-600 font-medium';                         // 0 < gap ≤ 15 — healthy
}

function formatAbGap(gap: number | null): string {
  if (gap == null) return '—';
  const sign = gap > 0 ? '+' : '';
  return `${sign}${gap}%`;
}

// ─────────────────────────────────────────────
// Cells & row fragments
// ─────────────────────────────────────────────

function OfferCell({ offer, nights }: { offer: Offer; nights: number }) {
  if (offer.price == null) {
    const label = offer.availability === 'not_available' ? 'Not available' : '—';
    return (
      <td className="px-4 py-2.5 text-right align-top">
        <div className="text-xs italic text-gray-400">{label}</div>
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
          {offer.unparsedDiscount && (
            <span className="ml-1 text-amber-600 text-[10px]">(unbreakable)</span>
          )}
        </div>
      )}
      {offer.discountBreakdown && offer.discountBreakdown.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1 justify-end max-w-[260px] ml-auto">
          {offer.discountBreakdown.map((d, i) => (
            <span
              key={i}
              className={`inline-block text-[11px] leading-tight px-1.5 py-0.5 rounded font-medium ${discountBadgeClass(d.name)}`}
            >
              {discountDisplayName(d.name)} <span className="font-bold">−{d.pp}pp</span>
            </span>
          ))}
        </div>
      )}
      {offer.labels.length > 0 && (() => {
        // Suppress labels that duplicate an already-rendered breakdown
        // category — no need to show "Weekly stay discount" as an extra pill
        // when the canonicalised "Weekly discount -10pp" pill is already there.
        const breakdownCats = new Set(
          (offer.discountBreakdown ?? []).map((d) => categorizeDiscount(d.name)),
        );
        const deduped: string[] = [];
        const seenCats = new Set<DiscountCategoryKey>(breakdownCats);
        for (const l of offer.labels) {
          const cat = categorizeDiscount(l);
          if (seenCats.has(cat)) continue;
          seenCats.add(cat);
          deduped.push(l);
        }
        if (deduped.length === 0) return null;
        return (
        <div className="mt-1 flex flex-wrap gap-1 justify-end max-w-[240px] ml-auto">
          {deduped.slice(0, 3).map((l, i) => (
            <span
              key={i}
              className={`inline-block text-[10px] leading-tight px-1.5 py-0.5 rounded font-medium ${discountBadgeClass(l)}`}
            >
              {discountDisplayName(l)}
            </span>
          ))}
        </div>
        );
      })()}
    </td>
  );
}

// ─────────────────────────────────────────────
// View: By Room (default)
// ─────────────────────────────────────────────

function ByRoomView({ result }: { result: PricingResult }) {
  const rows = result.runs.flatMap((run) => run.rooms.map((room) => ({ run, room })));
  rows.sort((a, b) => {
    const ro = (ROOM_ORDER[a.room.roomLabel] ?? 99) - (ROOM_ORDER[b.room.roomLabel] ?? 99);
    if (ro !== 0) return ro;
    if (a.run.nights !== b.run.nights) return a.run.nights - b.run.nights;
    return a.run.checkIn.localeCompare(b.run.checkIn);
  });

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 border-b border-gray-200">
          <tr>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase w-36">Room</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase w-44">Dates</th>
            <th className="px-4 py-2.5 text-center text-xs font-medium text-gray-500 uppercase w-16">Nights</th>
            <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Web</th>
            <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Airbnb</th>
            <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Booking.com</th>
            <th className="px-4 py-2.5 text-center text-xs font-medium text-gray-500 uppercase w-28">B vs A</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map(({ run, room }) => {
            const abGap = computeAbGap(room.airbnb.price, room.bookingCom.price);
            return (
              <tr
                key={`${run.checkIn}-${run.nights}-${room.roomLabel}`}
                className={`${nightsRowClass(run.nights)} ${roomBorderClass(room.roomLabel)}`}
              >
                <td className="px-4 py-2.5 align-top">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${roomBadgeClass(room.roomLabel)}`}>
                    {room.roomLabel}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-gray-600 whitespace-nowrap align-top">
                  {run.checkIn} → {run.checkOut}
                </td>
                <td className="px-4 py-2.5 text-center text-gray-600 align-top">{run.nights}</td>
                <OfferCell offer={room.web} nights={run.nights} />
                <OfferCell offer={room.airbnb} nights={run.nights} />
                <OfferCell offer={room.bookingCom} nights={run.nights} />
                <td className={`px-4 py-2.5 text-center align-top ${abGapClass(abGap)}`}>
                  {formatAbGap(abGap)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────
// View: By Date — groups rooms together per date range
// ─────────────────────────────────────────────

function ByDateView({ result }: { result: PricingResult }) {
  const groups = [...result.runs].sort((a, b) => {
    if (a.checkIn !== b.checkIn) return a.checkIn.localeCompare(b.checkIn);
    return a.nights - b.nights;
  });

  return (
    <div className="space-y-4">
      {groups.map((run) => {
        const rooms = [...run.rooms].sort(
          (a, b) => (ROOM_ORDER[a.roomLabel] ?? 99) - (ROOM_ORDER[b.roomLabel] ?? 99),
        );
        return (
          <div key={`${run.checkIn}-${run.nights}`} className="rounded-lg border border-gray-200 overflow-hidden">
            <div className="bg-gray-50 px-4 py-2 border-b border-gray-200 flex items-baseline justify-between">
              <div className="font-semibold text-gray-800">
                {run.checkIn} → {run.checkOut}
              </div>
              <div className="text-xs text-gray-500">{run.nights} nights</div>
            </div>
            <table className="min-w-full text-sm">
              <thead className="bg-white border-b border-gray-100">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase w-36">Room</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Web</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Airbnb</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Booking.com</th>
                  <th className="px-4 py-2 text-center text-xs font-medium text-gray-500 uppercase w-28">B vs A</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rooms.map((room) => {
                  const abGap = computeAbGap(room.airbnb.price, room.bookingCom.price);
                  return (
                    <tr key={room.roomLabel} className={roomBorderClass(room.roomLabel)}>
                      <td className="px-4 py-2.5 align-top">
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${roomBadgeClass(room.roomLabel)}`}>
                          {room.roomLabel}
                        </span>
                      </td>
                      <OfferCell offer={room.web} nights={run.nights} />
                      <OfferCell offer={room.airbnb} nights={run.nights} />
                      <OfferCell offer={room.bookingCom} nights={run.nights} />
                      <td className={`px-4 py-2.5 text-center align-top ${abGapClass(abGap)}`}>
                        {formatAbGap(abGap)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────
// Shell — pricing table with view toggle
// ─────────────────────────────────────────────

function PricingTable({ result }: { result: PricingResult }) {
  const [mode, setMode] = useState<'byRoom' | 'byDate'>('byRoom');

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 text-xs font-medium">
          {[
            { id: 'byRoom' as const, label: 'By room' },
            { id: 'byDate' as const, label: 'By date' },
          ].map((opt) => (
            <button
              key={opt.id}
              onClick={() => setMode(opt.id)}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                mode === opt.id ? 'bg-gray-800 text-white' : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="text-xs text-gray-500 flex flex-wrap gap-3 items-center">
          <span><span className="inline-block w-2 h-2 rounded-full bg-sky-500 mr-1" />1KK Deluxe</span>
          <span><span className="inline-block w-2 h-2 rounded-full bg-fuchsia-500 mr-1" />2KK Deluxe</span>
          <span className="ml-2 text-gray-400">|</span>
          <span>B vs A (Booking over Airbnb):</span>
          <span className="text-red-700 font-bold">≤0 alert</span>
          <span className="text-emerald-600">0…15%</span>
          <span className="text-amber-600">15–30%</span>
          <span className="text-red-700 font-bold">&gt;30% alert</span>
        </div>
      </div>

      {mode === 'byRoom' ? <ByRoomView result={result} /> : <ByDateView result={result} />}
    </div>
  );
}

// ─────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────

export default function PricingPage() {
  const [scheduled, setScheduled] = useState<(PricingResult & { status?: string }) | null>(null);
  const [custom, setCustom] = useState<PricingResult | null>(null);

  const [loadingScheduled, setLoadingScheduled] = useState(true);
  const [runningFull, setRunningFull] = useState(false);
  const [runningCustom, setRunningCustom] = useState(false);

  const [checkIn, setCheckIn] = useState('');
  const [checkOut, setCheckOut] = useState('');
  const [nights, setNights] = useState<'2' | '7'>('2');
  const [error, setError] = useState<string | null>(null);

  // Vercel sometimes returns plain-text/HTML on 5xx (e.g. function timeout =
  // "An error occurred…"). A naive `.json()` then throws SyntaxError. This
  // helper returns the error message text or a sensible fallback so the UI
  // surfaces a useful message instead of "Unexpected token 'A'".
  const readErrorMessage = async (res: Response, fallback: string): Promise<string> => {
    const text = await res.text().catch(() => '');
    if (!text) return fallback;
    try {
      const parsed = JSON.parse(text);
      return typeof parsed?.error === 'string' ? parsed.error : fallback;
    } catch {
      // Plain text / HTML response — surface a short, readable hint
      const stripped = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return stripped.length > 0 ? stripped.slice(0, 240) : fallback;
    }
  };

  const loadCached = useCallback(async () => {
    setLoadingScheduled(true);
    try {
      const res = await fetch('/api/platform-prices');
      if (res.status === 204) {
        setScheduled(null);
      } else if (res.ok) {
        const data = await res.json();
        setScheduled({ ...normalizeResult(data), status: data.status });
      }
    } finally {
      setLoadingScheduled(false);
    }
  }, []);

  useEffect(() => { loadCached(); }, [loadCached]);

  useEffect(() => {
    if (checkIn) {
      const d = new Date(checkIn);
      d.setDate(d.getDate() + Number(nights));
      setCheckOut(d.toISOString().slice(0, 10));
    }
  }, [checkIn, nights]);

  async function handleFullRun() {
    setRunningFull(true);
    setError(null);
    try {
      const res = await fetch('/api/platform-prices', { method: 'POST' });
      if (!res.ok) throw new Error(await readErrorMessage(res, `Failed (${res.status})`));
      const data = await res.json();
      setScheduled({ ...normalizeResult(data), status: 'idle' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Run failed');
    } finally {
      setRunningFull(false);
    }
  }

  async function handleCustomCheck() {
    if (!checkIn || !checkOut) return;
    setRunningCustom(true);
    setError(null);
    setCustom(null);
    try {
      const res = await fetch('/api/platform-prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkIn, checkOut, nights: Number(nights) }),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, `Failed (${res.status})`));
      setCustom(normalizeResult(await res.json()));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Check failed');
    } finally {
      setRunningCustom(false);
    }
  }

  const isRunning = scheduled?.status === 'running';

  return (
    <div className="max-w-screen-2xl mx-auto px-6 py-8 space-y-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Platform Pricing</h1>
          <p className="text-sm text-gray-500 mt-1">
            Compares guest-facing prices across Web, Airbnb, and Booking.com. Use the toggle below to view by room or date range.
          </p>
        </div>
        <button
          onClick={handleFullRun}
          disabled={runningFull || isRunning}
          className="shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {runningFull || isRunning ? (
            <>
              <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Running…
            </>
          ) : (
            'Refresh All Dates'
          )}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Scheduled Overview</h2>
          {scheduled?.timestamp && (
            <span className="text-xs text-gray-400">Last updated {formatTs(scheduled.timestamp)}</span>
          )}
        </div>

        {loadingScheduled ? (
          <div className="flex items-center justify-center h-40 text-gray-400 text-sm gap-2">
            <span className="w-5 h-5 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
            Loading…
          </div>
        ) : scheduled ? (
          <PricingTable result={scheduled} />
        ) : (
          <div className="rounded-lg border border-dashed border-gray-300 flex flex-col items-center justify-center h-40 text-gray-400 text-sm">
            <p>No data yet — click <strong>Refresh All Dates</strong> to run the first check.</p>
            <p className="text-xs mt-1">Runs automatically every morning at 09:00 CET once deployed.</p>
          </div>
        )}
      </section>

      <section className="border-t border-gray-200 pt-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Custom Date Check</h2>
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
              onChange={(e) => setNights(e.target.value as '2' | '7')}
              className="block border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="2">2 nights</option>
              <option value="7">7 nights (weekly)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Check-out</label>
            <input
              type="date"
              value={checkOut}
              onChange={(e) => setCheckOut(e.target.value)}
              className="block border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <button
            onClick={handleCustomCheck}
            disabled={!checkIn || !checkOut || runningCustom}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-800 text-white text-sm font-medium hover:bg-gray-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {runningCustom ? (
              <>
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Checking…
              </>
            ) : (
              'Check Prices'
            )}
          </button>
        </div>

        {custom && (
          <div className="mt-6">
            <PricingTable result={custom} />
          </div>
        )}
      </section>
    </div>
  );
}

'use client';
import { useState } from 'react';

type RoomOffer = { room: string; description: string; price: number | null };

function formatCZK(n: number): string {
  return n.toLocaleString('cs-CZ', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' Kč';
}

function nightCount(arrival: string, departure: string): number {
  const a = new Date(arrival);
  const b = new Date(departure);
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / 86_400_000));
}

export default function PriceCheckModal({ onClose }: { onClose: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

  const [arrival, setArrival] = useState(today);
  const [departure, setDeparture] = useState(tomorrow);
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);
  const [ignoreAvailability, setIgnoreAvailability] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offers, setOffers] = useState<RoomOffer[] | null>(null);
  // Track which mode the displayed offers were fetched in, so the amber notice
  // only shows when the visible prices were retrieved with availability ignored.
  const [offersIgnoredAvailability, setOffersIgnoredAvailability] = useState(false);

  async function handleCheck() {
    if (!arrival || !departure) { setError('Pick dates'); return; }
    if (arrival >= departure) { setError('Departure must be after arrival'); return; }
    setLoading(true);
    setError(null);
    setOffers(null);
    try {
      const params = new URLSearchParams({
        arrival,
        departure,
        adults: String(adults),
        children: String(children),
      });
      if (ignoreAvailability) params.set('ignoreAvailability', 'true');
      const res = await fetch(`/api/price-check?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Request failed');
      setOffers(data.offers ?? []);
      setOffersIgnoredAvailability(ignoreAvailability);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const nights = arrival && departure && arrival < departure ? nightCount(arrival, departure) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-emerald-50">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h2 className="text-base font-semibold text-gray-800">Price Check</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Date inputs */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Check-in</label>
              <input
                type="date"
                value={arrival}
                min={today}
                onChange={(e) => {
                  setArrival(e.target.value);
                  if (e.target.value >= departure) {
                    const next = new Date(e.target.value);
                    next.setDate(next.getDate() + 1);
                    setDeparture(next.toISOString().slice(0, 10));
                  }
                }}
                className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Check-out</label>
              <input
                type="date"
                value={departure}
                min={arrival ? new Date(new Date(arrival).getTime() + 86_400_000).toISOString().slice(0, 10) : today}
                onChange={(e) => setDeparture(e.target.value)}
                className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              />
            </div>
          </div>

          {/* Guest count */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Adults</label>
              <select
                value={adults}
                onChange={(e) => setAdults(Number(e.target.value))}
                className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              >
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Children</label>
              <select
                value={children}
                onChange={(e) => setChildren(Number(e.target.value))}
                className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              >
                {[0, 1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Ignore-availability toggle */}
          <label className="flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-gray-200 bg-gray-50 cursor-pointer select-none">
            <div className="flex flex-col">
              <span className="text-xs font-medium text-gray-700">Ignore availability</span>
              <span className="text-[10px] text-gray-400">Show prices even when rooms are booked</span>
            </div>
            <button
              type="button"
              onClick={() => setIgnoreAvailability((v) => !v)}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                ignoreAvailability ? 'bg-amber-500' : 'bg-gray-300'
              }`}
              role="switch"
              aria-checked={ignoreAvailability}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  ignoreAvailability ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </label>

          {nights > 0 && (
            <p className="text-xs text-gray-400 text-center">
              {nights} night{nights !== 1 ? 's' : ''} · {adults + children} guest{adults + children !== 1 ? 's' : ''}
            </p>
          )}

          {/* Check button */}
          <button
            onClick={handleCheck}
            disabled={loading || !arrival || !departure || arrival >= departure}
            className="w-full py-2.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                Checking…
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                Check Prices
              </>
            )}
          </button>

          {error && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</p>
          )}

          {/* Results */}
          {offers && (
            <div className="space-y-2">
              {offersIgnoredAvailability && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-amber-200 bg-amber-50 text-[11px] text-amber-800">
                  <svg className="w-3.5 h-3.5 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                  </svg>
                  <span>Prices shown regardless of availability — rooms may be booked.</span>
                </div>
              )}
              {offers.map((o) => (
                <div
                  key={o.room}
                  className={`flex items-center justify-between px-4 py-3 rounded-lg border ${
                    o.price != null
                      ? 'border-emerald-200 bg-emerald-50'
                      : 'border-gray-200 bg-gray-50'
                  }`}
                >
                  <div>
                    <p className="text-sm font-medium text-gray-800">{o.room}</p>
                    <p className="text-xs text-gray-400">{o.description}</p>
                    {o.price != null && nights > 0 && (
                      <p className="text-xs text-gray-400 mt-0.5">
                        {formatCZK(Math.round(o.price / nights))} / night
                      </p>
                    )}
                  </div>
                  {o.price != null ? (
                    <span className="text-base font-semibold text-emerald-700">{formatCZK(o.price)}</span>
                  ) : (
                    <span className="text-xs font-medium text-gray-400 bg-gray-200 px-2 py-1 rounded">
                      {offersIgnoredAvailability ? 'No rate' : 'Unavailable'}
                    </span>
                  )}
                </div>
              ))}

              {/* Multi-room total hint */}
              {offers.filter((o) => o.price != null).length > 1 && (
                <div className="flex items-center justify-between px-4 py-2.5 rounded-lg border border-dashed border-emerald-300 bg-emerald-50/50">
                  <p className="text-xs font-medium text-emerald-700">All apartments combined</p>
                  <span className="text-sm font-bold text-emerald-800">
                    {formatCZK(offers.reduce((sum, o) => sum + (o.price ?? 0), 0))}
                  </span>
                </div>
              )}

              {offers.every((o) => o.price == null) && (
                <p className="text-xs text-gray-500 text-center py-1">
                  {offersIgnoredAvailability
                    ? 'No rate data found for these dates.'
                    : 'No rooms available for these dates.'}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

'use client';
/**
 * "Can we take this?" — feasibility + price for a stay request that isn't in the
 * system yet (the long, short-notice ones that don't fit a single unit).
 *
 * Two steps, deliberately separate:
 *   1. Feasibility is computed HERE, from the reservations already on screen
 *      (utils/stayRequest.ts) — instant, no network, and it agrees with the
 *      room-assignment panel because both call the same solver.
 *   2. Prices come from the server, one Beds24 offer per segment, because only
 *      Beds24 can evaluate its own rate plans.
 *
 * Read-only throughout: this reserves nothing and moves nobody. The shuffle
 * moves it lists are what the operator WOULD have to do, not what it did.
 */
import { useState } from 'react';
import type { Reservation } from '@/types/reservation';
import { pragueToday } from '@/utils/periodUtils';
import {
  planStayRequest,
  nightsBetween,
  SELLABLE_UNITS,
  type StaySegment,
  type StayRequestPlan,
} from '@/utils/stayRequest';

type PriceSource = 'offers' | 'calendar-nominal' | 'none';

interface QuotedSegment {
  roomId: number;
  from: string;
  to: string;
  nights: number;
  price: number | null;
  source: PriceSource;
  offersCount: number;
  adr: number | null;
  error?: string;
}

interface QuoteResponse {
  segments: QuotedSegment[];
  total: number;
  totalNights: number;
  complete: boolean;
  hasNominalPrices: boolean;
}

function formatCZK(n: number): string {
  return n.toLocaleString('cs-CZ', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' Kč';
}

export default function StayRequestModal({
  reservations,
  onClose,
}: {
  reservations: Reservation[];
  onClose: () => void;
}) {
  const today = pragueToday();
  const [arrival, setArrival] = useState(today);
  const [departure, setDeparture] = useState('');
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);
  const [allowShuffle, setAllowShuffle] = useState(true);
  const [discount, setDiscount] = useState(0);
  /** Which types the operator is willing to offer — all of them until narrowed. */
  const [allowedIds, setAllowedIds] = useState<number[]>(SELLABLE_UNITS.map((s) => s.roomId));
  /** 0 = no preference (fewest room changes). */
  const [preferredId, setPreferredId] = useState(0);
  /** '' = uncapped. Only meaningful alongside a preference. */
  const [maxChanges, setMaxChanges] = useState<string>('');

  const [plan, setPlan] = useState<StayRequestPlan | null>(null);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const nights = arrival && departure && arrival < departure ? nightsBetween(arrival, departure) : 0;

  async function handleCheck() {
    if (!arrival || !departure) { setError('Pick both dates'); return; }
    if (arrival >= departure) { setError('Departure must be after arrival'); return; }
    setError(null);
    setQuote(null);
    setCopied(false);

    // Feasibility first — free, and it tells us what to ask Beds24 to price.
    const result = planStayRequest(reservations, arrival, departure, today, {
      allowShuffle,
      allowedRoomIds: allowedIds,
      preferredRoomId: preferredId || undefined,
      maxRoomChanges: maxChanges === '' ? undefined : Number(maxChanges),
    });
    setPlan(result);
    if (!result.feasible) return;

    setLoading(true);
    try {
      const res = await fetch('/api/stay-request/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adults,
          children,
          segments: result.segments.map((s) => ({ roomId: s.sellableRoomId, from: s.from, to: s.to })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Pricing failed');
      setQuote(data as QuoteResponse);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const factor = 1 - discount / 100;
  const listTotal = quote?.total ?? 0;
  const quoteTotal = listTotal * factor;
  /** Did Beds24 price anything? If not, totals must read "—", not "0 Kč". */
  const anyPriced = (quote?.segments ?? []).some((s) => s.price !== null);

  /** Plain-text summary, ready to paste into a reply to the guest. */
  function quoteText(segments: StaySegment[], q: QuoteResponse): string {
    const lines = segments.map((s, i) => {
      const priced = q.segments[i];
      const amount = priced?.price == null ? 'price on request' : formatCZK(priced.price * factor);
      return `${i + 1}. ${s.from} → ${s.to} (${s.nights} nights) · ${s.sellableLabel} · ${amount}`;
    });
    return [
      `Stay request ${arrival} → ${departure} (${nights} nights, ${adults} adults${children ? ` + ${children} children` : ''})`,
      segments.length === 1 ? 'One reservation:' : `${segments.length} reservations (room change between them):`,
      ...lines,
      discount ? `Total after ${discount}% discount: ${formatCZK(quoteTotal)}` : `Total: ${formatCZK(listTotal)}`,
    ].join('\n');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 overflow-y-auto py-8" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-3xl mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-cyan-50">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-cyan-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <h2 className="text-base font-semibold text-gray-800">Stay Request — can we take it?</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Inputs */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <label className="block">
              <span className="text-xs font-medium text-gray-500">Check-in</span>
              <input
                type="date" value={arrival} onChange={(e) => setArrival(e.target.value)}
                className="mt-1 w-full px-2 py-1.5 rounded-md border border-gray-200 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-500">Check-out</span>
              <input
                type="date" value={departure} min={arrival} onChange={(e) => setDeparture(e.target.value)}
                className="mt-1 w-full px-2 py-1.5 rounded-md border border-gray-200 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-500">Adults</span>
              <input
                type="number" min={1} value={adults} onChange={(e) => setAdults(Number(e.target.value))}
                className="mt-1 w-full px-2 py-1.5 rounded-md border border-gray-200 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-500">Children</span>
              <input
                type="number" min={0} value={children} onChange={(e) => setChildren(Number(e.target.value))}
                className="mt-1 w-full px-2 py-1.5 rounded-md border border-gray-200 text-sm"
              />
            </label>
          </div>

          {/* Which types to offer — the lever for "the guest wants something cheaper" */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pb-1 border-b border-gray-100">
            <span className="text-xs font-medium text-gray-500">Offer</span>
            {SELLABLE_UNITS.map((s) => (
              <label key={s.roomId} className="flex items-center gap-1.5 text-sm text-gray-600">
                <input
                  type="checkbox"
                  checked={allowedIds.includes(s.roomId)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...allowedIds, s.roomId]
                      : allowedIds.filter((id) => id !== s.roomId);
                    setAllowedIds(next);
                    // A preference for a type no longer on offer would be ignored anyway.
                    if (!next.includes(preferredId)) setPreferredId(0);
                  }}
                  className="rounded"
                />
                {s.label}
              </label>
            ))}
            <label className="flex items-center gap-1.5 text-sm text-gray-600 ml-auto">
              <span className="text-xs font-medium text-gray-500">Maximise nights in</span>
              <select
                value={preferredId}
                onChange={(e) => setPreferredId(Number(e.target.value))}
                className="px-2 py-1 rounded-md border border-gray-200 text-sm"
              >
                <option value={0}>— fewest room changes</option>
                {SELLABLE_UNITS.filter((s) => allowedIds.includes(s.roomId)).map((s) => (
                  <option key={s.roomId} value={s.roomId}>{s.label}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-sm text-gray-600">
              <span
                className="text-xs font-medium text-gray-500"
                title="Cap how often the guest changes room. Fewer changes means fewer nights in the preferred type — the itinerary shows the trade."
              >
                Max room changes
              </span>
              <select
                value={maxChanges}
                onChange={(e) => setMaxChanges(e.target.value)}
                className="px-2 py-1 rounded-md border border-gray-200 text-sm"
              >
                <option value="">any</option>
                <option value="0">0</option>
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input type="checkbox" checked={allowShuffle} onChange={(e) => setAllowShuffle(e.target.checked)} className="rounded" />
              Allow moving other guests within a room type
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-600">
              Discount
              <input
                type="number" min={0} max={100} value={discount} onChange={(e) => setDiscount(Number(e.target.value))}
                className="w-16 px-2 py-1 rounded-md border border-gray-200 text-sm"
              />
              %
            </label>
            <span className="text-xs text-gray-400">{nights > 0 ? `${nights} nights` : 'pick dates'}</span>
            <button
              onClick={handleCheck}
              disabled={loading || nights <= 0 || allowedIds.length === 0}
              className="ml-auto inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-cyan-600 hover:bg-cyan-700 text-white text-sm font-medium transition-colors disabled:opacity-50"
            >
              {loading ? 'Pricing…' : 'Check'}
            </button>
          </div>

          {error && (
            <div className="px-3 py-2 rounded-md bg-rose-50 border border-rose-200 text-sm text-rose-700">{error}</div>
          )}

          {/* Not possible — say exactly which night killed it and who holds the rooms */}
          {plan && !plan.feasible && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-4">
              <p className="text-sm font-semibold text-rose-800">
                Not possible — blocked on {plan.blockedAt}
              </p>
              <p className="text-xs text-rose-700 mt-0.5">
                {allowedIds.length === SELLABLE_UNITS.length ? 'No room type' : 'None of the selected room types'} has a
                free unit that night{allowShuffle ? ', even after shuffling movable guests' : ' (shuffling is switched off)'}.
                {allowShuffle && ' A shuffle only changes which unit a guest occupies — it cannot add one.'}
              </p>
              {plan.holders.length > 0 && (
                <table className="mt-3 w-full text-xs">
                  <tbody>
                    {plan.holders.map((h) => (
                      <tr key={h.room} className="border-t border-rose-100">
                        <td className="py-1 pr-3 font-medium text-gray-700 whitespace-nowrap">{h.room}</td>
                        <td className="py-1 pr-3 text-gray-700">{h.who ?? <span className="text-emerald-700">free</span>}</td>
                        <td className="py-1 pr-3 text-gray-500 whitespace-nowrap">
                          {h.from ? `${h.from} → ${h.to}` : ''}
                        </td>
                        <td className="py-1 text-gray-500">{h.inHouse ? 'in-house' : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Possible — the itinerary */}
          {plan?.feasible && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 overflow-hidden">
              <div className="px-4 py-2.5 bg-emerald-50 border-b border-emerald-100">
                <p className="text-sm font-semibold text-emerald-800">
                  Possible — {plan.segments.length === 1
                    ? '1 reservation, no room change'
                    : `${plan.segments.length} reservations, ${plan.segments.length - 1} room change${plan.segments.length > 2 ? 's' : ''} for the guest`}
                </p>
                {/* An empty Unit column is ambiguous — say plainly whether anyone is disturbed. */}
                {(() => {
                  const moves = plan.segments.flatMap((s) => s.moves);
                  const notices = moves.filter((m) => m.needsGuestNotice).length;
                  return moves.length === 0 ? (
                    <p className="text-xs text-emerald-700 mt-0.5">No other guests need to move.</p>
                  ) : (
                    <p className="text-xs text-amber-700 mt-0.5">
                      {moves.length} other guest{moves.length > 1 ? 's' : ''} must change room — listed per segment below
                      {notices > 0 && `, ${notices} of whom already has a room/door code and must be told`}.
                    </p>
                  );
                })()}
                {preferredId > 0 && (
                  <p className="text-xs text-emerald-700 mt-0.5">
                    {plan.segments.filter((s) => s.sellableRoomId === preferredId).reduce((n, s) => n + s.nights, 0)}
                    {' of '}{plan.totalNights} nights in {SELLABLE_UNITS.find((s) => s.roomId === preferredId)?.label}
                    {' — the rest bridges nights it could not cover.'}
                  </p>
                )}
              </div>

              <table className="w-full text-xs">
                <thead className="text-gray-500">
                  <tr className="border-b border-emerald-100">
                    <th className="text-left py-2 px-3 font-medium">#</th>
                    <th className="text-left py-2 px-3 font-medium">Dates</th>
                    <th className="text-right py-2 px-3 font-medium">Nights</th>
                    <th className="text-left py-2 px-3 font-medium">Room type</th>
                    <th className="text-left py-2 px-3 font-medium">Unit</th>
                    <th className="text-right py-2 px-3 font-medium">Price</th>
                    <th className="text-right py-2 px-3 font-medium">ADR</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.segments.map((s, i) => {
                    const priced = quote?.segments[i];
                    return (
                      <tr key={`${s.from}-${s.room}`} className="border-b border-emerald-100 align-top">
                        <td className="py-2 px-3 text-gray-500">{i + 1}</td>
                        <td className="py-2 px-3 text-gray-700 whitespace-nowrap">{s.from} → {s.to}</td>
                        <td className="py-2 px-3 text-right text-gray-700">{s.nights}</td>
                        <td className="py-2 px-3 text-gray-700">{s.sellableLabel}</td>
                        <td className="py-2 px-3 text-gray-700">
                          {s.room}
                          {s.moves.length > 0 && (
                            <ul className="mt-1 space-y-0.5">
                              {s.moves.map((m) => (
                                <li key={m.reservationNumber} className="text-[11px] text-amber-700">
                                  {m.needsGuestNotice && '⚠ '}move {m.label ?? m.reservationNumber} {m.from} → {m.to}
                                  {m.needsGuestNotice && ' (inform guest)'}
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                        <td className="py-2 px-3 text-right whitespace-nowrap">
                          {priced?.price == null
                            ? <span className="text-gray-400">{loading ? '…' : '—'}</span>
                            : <span className="text-gray-800 font-medium">{formatCZK(priced.price * factor)}</span>}
                          {priced?.source === 'calendar-nominal' && (
                            <span className="block text-[10px] text-amber-600">nominal</span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-right text-gray-500 whitespace-nowrap">
                          {priced?.adr == null ? '—' : formatCZK(priced.adr * factor)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* Totals */}
              {quote && (
                <div className="px-4 py-3 bg-white border-t border-emerald-100 space-y-1 text-sm">
                  {/* Nothing priced at all: show "—", never a 0 Kč that reads as free. */}
                  <div className="flex justify-between text-gray-600">
                    <span>List total ({quote.totalNights} nights)</span>
                    <span>{anyPriced ? formatCZK(listTotal) : '—'}</span>
                  </div>
                  {discount > 0 && anyPriced && (
                    <div className="flex justify-between text-amber-700">
                      <span>Discount −{discount}%</span>
                      <span>−{formatCZK(listTotal - quoteTotal)}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-semibold text-gray-900 pt-1 border-t border-gray-100">
                    <span>Quote</span>
                    <span>
                      {anyPriced
                        ? `${formatCZK(quoteTotal)} · ${formatCZK(quoteTotal / (quote.totalNights || 1))}/night`
                        : 'no price available'}
                    </span>
                  </div>

                  {!quote.complete && (
                    <p className="text-xs text-rose-700 pt-1">
                      ⚠ Beds24 could not price every segment — the total above is partial. A segment with no
                      offer is usually blocked by a min-stay/max-stay rule or guest count over capacity.
                    </p>
                  )}
                  {quote.hasNominalPrices && (
                    <p className="text-xs text-amber-700 pt-1">
                      ⚠ Segments marked <em>nominal</em> are a sum of daily calendar rates, not a Beds24 offer —
                      no rate-plan or length-of-stay pricing applied, so they read high.
                    </p>
                  )}
                  <p className="text-xs text-gray-400 pt-1">
                    Each segment is priced as its own booking, so length-of-stay discounts restart per segment —
                    a split stay lists higher than one continuous booking of the same nights.
                  </p>

                  <div className="pt-2">
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(quoteText(plan.segments, quote));
                        setCopied(true);
                      }}
                      className="px-3 py-1.5 rounded-md border border-gray-200 text-xs font-medium text-gray-600 hover:bg-gray-50"
                    >
                      {copied ? 'Copied' : 'Copy quote'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <p className="text-[11px] text-gray-400">
            Nothing here books or moves anything — it is a what-if against the reservations currently loaded.
            Sync first if the data looks stale, and re-check before you promise dates.
          </p>
        </div>
      </div>
    </div>
  );
}

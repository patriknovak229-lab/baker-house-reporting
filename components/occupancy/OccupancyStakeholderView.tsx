'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OccupancyBoard, OccupancyResponse } from '@/types/occupancyBoard';

// ─── Date helpers (all UTC, to match the server's YYYY-MM-DD grid) ────────────
const WEEKDAY = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n: number) => String(n).padStart(2, '0');
const weekdayIdx = (iso: string) => new Date(iso + 'T00:00:00Z').getUTCDay();
const dayOfMonth = (iso: string) => iso.slice(8, 10).replace(/^0/, '');
const isWeekend = (iso: string) => weekdayIdx(iso) === 0 || weekdayIdx(iso) === 6;
const monthLabel = (iso: string) => {
  const d = new Date(iso + 'T00:00:00Z');
  return `${MONTH[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const fmtDate = (iso: string) => {
  const d = new Date(iso + 'T00:00:00Z');
  return `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
function fmtSyncedAt(iso: string | null): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function lastOfMonth(y: number, m: number): string {
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // m is 1-based; day 0 = last of month m
}

interface MonthOption { key: string; label: string; start: string; end: string }

/** Build the selectable months from the horizon (current → +12 months). */
function monthOptions(horizon: { start: string; end: string }): MonthOption[] {
  const opts: MonthOption[] = [];
  let y = Number(horizon.start.slice(0, 4));
  let m = Number(horizon.start.slice(5, 7));
  const endY = Number(horizon.end.slice(0, 4));
  const endM = Number(horizon.end.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    let start = `${y}-${pad(m)}-01`;
    let end = lastOfMonth(y, m);
    if (start < horizon.start) start = horizon.start;
    if (end > horizon.end) end = horizon.end;
    opts.push({ key: `${y}-${pad(m)}`, label: `${MONTH_LONG[m - 1]} ${y}`, start, end });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return opts;
}

type Mode = 'month' | 'custom';

export default function OccupancyStakeholderView() {
  const [resp, setResp] = useState<OccupancyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>('month');
  const [selectedMonth, setSelectedMonth] = useState<string>(''); // 'YYYY-MM'
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  const horizon = resp?.horizon ?? null;
  const months = useMemo(() => (horizon ? monthOptions(horizon) : []), [horizon]);

  // Guards against a stale in-flight response overwriting a newer one.
  const reqSeq = useRef(0);

  const fetchBoard = useCallback(async (start?: string, end?: string) => {
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    try {
      const qs = start && end ? `?start=${start}&end=${end}` : '';
      const r = await fetch(`/api/occupancy${qs}`, { cache: 'no-store' });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `Request failed (${r.status})`);
      if (seq === reqSeq.current) setResp(data as OccupancyResponse);
    } catch (e) {
      if (seq === reqSeq.current) setError(e instanceof Error ? e.message : 'Failed to load occupancy');
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, []);

  const sync = useCallback(async (start?: string, end?: string) => {
    const seq = ++reqSeq.current;
    setSyncing(true);
    setError(null);
    try {
      const qs = start && end ? `?start=${start}&end=${end}` : '';
      const r = await fetch(`/api/occupancy${qs}`, { method: 'POST', cache: 'no-store' });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `Sync failed (${r.status})`);
      if (seq === reqSeq.current) setResp(data as OccupancyResponse);
    } catch (e) {
      if (seq === reqSeq.current) setError(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      if (seq === reqSeq.current) setSyncing(false);
    }
  }, []);

  // Initial load (no range → server defaults to the current month + returns horizon).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await fetchBoard();
      if (cancelled) return;
    })();
    return () => { cancelled = true; };
  }, [fetchBoard]);

  // Seed the pickers once the first response (with horizon + board) arrives.
  useEffect(() => {
    if (!resp?.board || selectedMonth) return;
    const p = resp.board.period;
    setSelectedMonth(p.start.slice(0, 7));
    setCustomStart(p.start);
    setCustomEnd(p.end);
  }, [resp, selectedMonth]);

  function onPickMonth(key: string) {
    setMode('month');
    setSelectedMonth(key);
    const opt = months.find((o) => o.key === key);
    if (opt) fetchBoard(opt.start, opt.end);
  }

  function applyCustom(nextStart: string, nextEnd: string) {
    if (!horizon || !nextStart || !nextEnd) return;
    const start = nextStart < horizon.start ? horizon.start : nextStart;
    const end = nextEnd > horizon.end ? horizon.end : nextEnd;
    if (start > end) return; // wait for a valid pair
    fetchBoard(start, end);
  }

  const currentRange = useMemo(() => {
    if (mode === 'custom') return { start: customStart, end: customEnd };
    const opt = months.find((o) => o.key === selectedMonth);
    return opt ? { start: opt.start, end: opt.end } : undefined;
  }, [mode, customStart, customEnd, months, selectedMonth]);

  const board = resp?.board ?? null;
  const busy = loading || syncing;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Branded header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
          <p className="text-2xl text-gray-900" style={{ fontFamily: '"Great Vibes", cursive' }}>
            Baker House Apartments
          </p>
          <h1 className="text-xl font-bold text-gray-900 mt-1">Occupancy</h1>
          <p className="text-sm text-gray-600 mt-1">Which apartment-nights are free.</p>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Controls */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 sm:p-5">
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            {/* Mode toggle */}
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-500">View</span>
              <div className="inline-flex rounded-lg border border-gray-200 p-0.5 bg-gray-50">
                {(['month', 'custom'] as Mode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`px-3 py-1 text-sm rounded-md transition-colors ${
                      mode === m ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {m === 'month' ? 'Month' : 'Custom range'}
                  </button>
                ))}
              </div>
            </div>

            {mode === 'month' ? (
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-500">Month</span>
                <select
                  value={selectedMonth}
                  onChange={(e) => onPickMonth(e.target.value)}
                  disabled={!horizon || busy}
                  className="border border-gray-200 rounded-md px-3 py-1.5 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
                >
                  {months.map((o) => (
                    <option key={o.key} value={o.key}>{o.label}</option>
                  ))}
                </select>
              </label>
            ) : (
              <>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-gray-500">From</span>
                  <input
                    type="date"
                    value={customStart}
                    min={horizon?.start}
                    max={horizon?.end}
                    disabled={!horizon || busy}
                    onChange={(e) => { setCustomStart(e.target.value); applyCustom(e.target.value, customEnd); }}
                    className="border border-gray-200 rounded-md px-3 py-1.5 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-gray-500">To</span>
                  <input
                    type="date"
                    value={customEnd}
                    min={customStart || horizon?.start}
                    max={horizon?.end}
                    disabled={!horizon || busy}
                    onChange={(e) => { setCustomEnd(e.target.value); applyCustom(customStart, e.target.value); }}
                    className="border border-gray-200 rounded-md px-3 py-1.5 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
                  />
                </label>
              </>
            )}

            {/* Sync */}
            <div className="ml-auto flex items-center gap-3">
              <span className="text-xs text-gray-400 whitespace-nowrap">
                Last synced {fmtSyncedAt(resp?.syncedAt ?? null)}
              </span>
              <button
                onClick={() => sync(currentRange?.start, currentRange?.end)}
                disabled={busy}
                className="inline-flex items-center gap-2 px-3.5 py-1.5 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <svg className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                {syncing ? 'Syncing…' : 'Sync'}
              </button>
            </div>
          </div>
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        </div>

        {/* Body */}
        {resp?.neverSynced ? (
          <EmptyState onSync={() => sync(currentRange?.start, currentRange?.end)} syncing={syncing} />
        ) : board ? (
          <>
            <SummaryCards board={board} />
            <PerRoomBreakdown board={board} />
            <NightGrid board={board} loading={busy} />
          </>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-10 text-center text-gray-400">
            {busy ? 'Loading…' : 'No data.'}
          </div>
        )}

        <div className="text-center text-xs text-gray-400 pt-2 pb-8">
          Baker House Apartments ·{' '}
          <a href="https://www.bakerhouseapartments.cz" className="underline hover:text-gray-600">
            bakerhouseapartments.cz
          </a>
        </div>
      </main>
    </div>
  );
}

function EmptyState({ onSync, syncing }: { onSync: () => void; syncing: boolean }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-10 text-center">
      <h2 className="text-base font-semibold text-gray-800 mb-1">No occupancy data yet</h2>
      <p className="text-sm text-gray-500 mb-5">Press Sync to pull the latest availability.</p>
      <button
        onClick={onSync}
        disabled={syncing}
        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
      >
        {syncing ? 'Syncing…' : 'Sync now'}
      </button>
    </div>
  );
}

function SummaryCards({ board }: { board: OccupancyBoard }) {
  const { overall, period } = board;
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Occupancy</p>
          <p className="text-4xl font-bold text-indigo-600 mt-1">{overall.occupancyPct}%</p>
          <p className="text-xs text-gray-500 mt-1">
            {overall.soldNights} / {overall.availableNights} nights · {board.rooms.length} apartments
          </p>
        </div>
        <p className="text-sm text-gray-500">{period.label}</p>
      </div>
    </div>
  );
}

function PerRoomBreakdown({ board }: { board: OccupancyBoard }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
      <h2 className="text-base font-semibold text-gray-800 mb-4">Occupancy by apartment</h2>
      <div className="space-y-4">
        {board.perRoom.map((r) => (
          <div key={r.room}>
            <div className="flex justify-between items-baseline mb-1">
              <span className="text-sm font-medium text-gray-700">{r.room}</span>
              <span className="text-sm text-gray-500">
                <span className="font-semibold text-gray-800">{r.occupancyPct}%</span> · {r.soldNights} / {r.availableNights} nights
              </span>
            </div>
            <div className="w-full bg-gray-100 rounded-full h-2.5">
              <div className="h-2.5 rounded-full bg-indigo-500" style={{ width: `${Math.min(r.occupancyPct, 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function NightGrid({ board, loading }: { board: OccupancyBoard; loading: boolean }) {
  const { dates, perRoom } = board.calendar;
  const monthStartFlags = dates.map((d, i) => i === 0 || d.slice(0, 7) !== dates[i - 1].slice(0, 7));

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-gray-800">Occupied nights</h2>
        <div className="flex items-center gap-3 text-xs text-gray-500">
          <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-indigo-500" /> Occupied</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-gray-100 ring-1 ring-gray-200" /> Free</span>
        </div>
      </div>

      <div className={`overflow-x-auto transition-opacity ${loading ? 'opacity-50' : ''}`}>
        <table className="border-separate" style={{ borderSpacing: '2px' }}>
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-white" />
              {dates.map((d, i) => (
                <th key={d} className="align-bottom p-0">
                  {monthStartFlags[i] && (
                    <div className="text-[10px] font-semibold text-gray-500 text-left whitespace-nowrap pb-0.5">{monthLabel(d)}</div>
                  )}
                  <div className={`text-[10px] leading-tight w-6 ${isWeekend(d) ? 'text-gray-400' : 'text-gray-500'}`}>
                    <div>{WEEKDAY[weekdayIdx(d)]}</div>
                    <div className="font-medium">{dayOfMonth(d)}</div>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {perRoom.map((row) => (
              <tr key={row.room}>
                <td className="sticky left-0 z-10 bg-white pr-2 text-xs font-medium text-gray-700 whitespace-nowrap">{row.room}</td>
                {row.occupied.map((occ, i) => (
                  <td key={dates[i]} className="p-0">
                    <div
                      title={`${row.room} · ${fmtDate(dates[i])} · ${occ ? 'Occupied' : 'Free'}`}
                      className={`w-6 h-6 rounded-sm ${occ ? 'bg-indigo-500' : isWeekend(dates[i]) ? 'bg-gray-200/70' : 'bg-gray-100'}`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

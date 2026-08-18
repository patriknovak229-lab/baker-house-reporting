'use client';
/**
 * Global analytics filters: stay window, rooms, channels.
 *
 * Presets are chosen for the questions this section answers rather than copied
 * from the Performance tab. Performance is an operational month view ("current
 * month", "next month"); analytics is retrospective and comparative, so the
 * defaults are trailing ranges and "all time" — with a full custom range for
 * anything else.
 *
 * The default is "All time", not the current month: with six months of history the
 * whole dataset is the interesting unit, and a month-scoped default would show a
 * near-empty booking curve on first load.
 */
import { useMemo } from 'react';
import type { RoomCategoryGroup } from '@/utils/roomCategory';

export type RangePreset =
  | 'all-time'
  | 'trailing-3m'
  | 'trailing-6m'
  | 'trailing-12m'
  | 'ytd'
  | 'this-month'
  | 'last-month'
  | 'next-90d'
  | 'custom';

export interface AnalyticsFilters {
  preset: RangePreset;
  /** Only meaningful when preset === 'custom'. */
  from: string;
  to: string;
  /** Empty = all rooms. */
  rooms: string[];
  /** Empty = all channels. */
  channels: string[];
}

// ── Date helpers (UTC-safe, matching utils/periodUtils conventions) ───────────

function todayIso(): string {
  return new Date().toLocaleDateString('sv-SE');
}

function addDays(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function addMonths(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d.getUTCDate(), lastDay)),
  )
    .toISOString()
    .slice(0, 10);
}

function monthEnd(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

/**
 * "All time" starts at the property's first trading month rather than an epoch:
 * a window that begins in 2020 would add five years of zero-availability months
 * to every chart. February 2026 is the first month with any booking; the archive
 * enforces the real boundary anyway, this just keeps the axes tight.
 */
const FIRST_TRADING_MONTH = '2026-01-01';

export const RANGE_PRESETS: { key: RangePreset; label: string }[] = [
  { key: 'all-time', label: 'All time to date' },
  { key: 'trailing-12m', label: 'Last 12 months' },
  { key: 'trailing-6m', label: 'Last 6 months' },
  { key: 'trailing-3m', label: 'Last 3 months' },
  { key: 'ytd', label: 'Year to date' },
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'next-90d', label: 'Next 90 days' },
  { key: 'custom', label: 'Custom range' },
];

export function resolveRange(filters: AnalyticsFilters): { from: string; to: string } {
  const t = todayIso();
  switch (filters.preset) {
    case 'all-time':
      /**
       * Ends TODAY, not at the end of the forward book.
       *
       * Extending the window into the future puts a year of not-yet-sellable
       * nights into the availability denominator, which dragged headline
       * occupancy from ~89% down to ~28% — a number that looks like a
       * catastrophe and is really just an artefact of measuring unsold future.
       * The forward book is not lost: the on-the-books view computes its own
       * horizon regardless of this window (see `readPace`), and "Next 90 days"
       * is there for anyone who wants the future in the main metrics.
       */
      return { from: FIRST_TRADING_MONTH, to: t };
    case 'trailing-12m':
      return { from: addMonths(t, -12), to: t };
    case 'trailing-6m':
      return { from: addMonths(t, -6), to: t };
    case 'trailing-3m':
      return { from: addMonths(t, -3), to: t };
    case 'ytd':
      return { from: `${t.slice(0, 4)}-01-01`, to: t };
    case 'this-month':
      return { from: `${t.slice(0, 7)}-01`, to: monthEnd(t) };
    case 'last-month': {
      const prev = addMonths(`${t.slice(0, 7)}-01`, -1);
      return { from: prev, to: monthEnd(prev) };
    }
    case 'next-90d':
      return { from: t, to: addDays(t, 90) };
    case 'custom':
      return { from: filters.from, to: filters.to };
  }
}

export const defaultFilters: AnalyticsFilters = {
  preset: 'all-time',
  from: FIRST_TRADING_MONTH,
  to: todayIso(),
  rooms: [],
  channels: [],
};

export function filtersToQuery(filters: AnalyticsFilters): string {
  const { from, to } = resolveRange(filters);
  const params = new URLSearchParams({ from, to });
  if (filters.rooms.length > 0) params.set('rooms', filters.rooms.join(','));
  if (filters.channels.length > 0) params.set('channels', filters.channels.join(','));
  return params.toString();
}

// ── Component ────────────────────────────────────────────────────────────────

interface Props {
  filters: AnalyticsFilters;
  onChange: (next: AnalyticsFilters) => void;
  roomGroups: RoomCategoryGroup[];
  allRooms: string[];
  channels: string[];
}

const CHIP_BASE =
  'px-2.5 py-1 rounded-md text-xs font-medium border transition-colors whitespace-nowrap';
const CHIP_ON = 'bg-indigo-50 border-indigo-200 text-indigo-700';
const CHIP_OFF = 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50';

export default function FilterBar({ filters, onChange, roomGroups, allRooms, channels }: Props) {
  const range = useMemo(() => resolveRange(filters), [filters]);

  const toggle = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 print:shadow-none">
      {/*
        Wrapping flex rather than three justified columns: with seven room chips
        and five channel chips the columns collide somewhere around 1400 px and
        the last room chip gets clipped by the channel group. Letting the groups
        wrap keeps every chip readable at any width, at the cost of the columns
        not always lining up.
      */}
      <div className="flex flex-wrap gap-x-10 gap-y-5 items-start">
        {/* Period */}
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">
            Stay period
          </p>
          <div className="flex flex-wrap gap-1.5">
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.key}
                onClick={() => onChange({ ...filters, preset: p.key })}
                className={`${CHIP_BASE} ${filters.preset === p.key ? CHIP_ON : CHIP_OFF}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {filters.preset === 'custom' ? (
            <div className="flex items-center gap-2 mt-3">
              <input
                type="date"
                value={filters.from}
                max={filters.to}
                onChange={(e) => onChange({ ...filters, from: e.target.value })}
                className="px-2 py-1.5 rounded-md border border-gray-200 text-xs text-gray-700"
              />
              <span className="text-gray-400 text-xs">→</span>
              <input
                type="date"
                value={filters.to}
                min={filters.from}
                onChange={(e) => onChange({ ...filters, to: e.target.value })}
                className="px-2 py-1.5 rounded-md border border-gray-200 text-xs text-gray-700"
              />
            </div>
          ) : (
            <p className="text-[11px] text-gray-400 mt-2">
              {range.from} → {range.to}
            </p>
          )}
        </div>

        {/* Rooms */}
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 mb-2">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Rooms</p>
            {filters.rooms.length > 0 && (
              <button
                onClick={() => onChange({ ...filters, rooms: [] })}
                className="text-[11px] text-indigo-600 hover:text-indigo-800"
              >
                all
              </button>
            )}
          </div>
          <div className="flex flex-col gap-2">
            {roomGroups.map((group) => (
              <div key={group.category} className="flex items-center gap-1.5">
                <span className="text-[10px] uppercase tracking-wide text-gray-300 w-12 shrink-0">
                  {group.category}
                </span>
                {group.rooms.map((room) => (
                  <button
                    key={room}
                    onClick={() => onChange({ ...filters, rooms: toggle(filters.rooms, room) })}
                    className={`${CHIP_BASE} ${
                      filters.rooms.length === 0 || filters.rooms.includes(room) ? CHIP_ON : CHIP_OFF
                    }`}
                  >
                    {room}
                  </button>
                ))}
              </div>
            ))}
          </div>
          {filters.rooms.length > 0 && filters.rooms.length < allRooms.length && (
            <p className="text-[11px] text-amber-600 mt-2">
              Portfolio totals below cover only the selected rooms.
            </p>
          )}
        </div>

        {/* Channels */}
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 mb-2">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Channels</p>
            {filters.channels.length > 0 && (
              <button
                onClick={() => onChange({ ...filters, channels: [] })}
                className="text-[11px] text-indigo-600 hover:text-indigo-800"
              >
                all
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5 max-w-xs">
            {channels.length === 0 ? (
              <span className="text-xs text-gray-300">loading…</span>
            ) : (
              channels.map((channel) => (
                <button
                  key={channel}
                  onClick={() => onChange({ ...filters, channels: toggle(filters.channels, channel) })}
                  className={`${CHIP_BASE} ${
                    filters.channels.length === 0 || filters.channels.includes(channel) ? CHIP_ON : CHIP_OFF
                  }`}
                >
                  {channel}
                </button>
              ))
            )}
          </div>
          {filters.channels.length > 0 && (
            <p className="text-[11px] text-amber-600 mt-2">
              Occupancy still divides by ALL available nights, so a channel filter lowers it by design.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

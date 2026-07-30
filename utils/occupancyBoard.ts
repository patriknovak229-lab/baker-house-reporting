/**
 * Pure helpers for the stakeholder occupancy board (no Redis / no Next types),
 * so they can be unit-tested directly. The route (app/api/occupancy/route.ts)
 * handles auth + Redis + request parsing and delegates the math to these.
 */
import type { OccupancyBoard } from '@/types/occupancyBoard';

export const MAX_RANGE_DAYS = 186; // ~6 months — keeps the grid renderable

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n: number) => String(n).padStart(2, '0');

/** Whole-horizon PII-free grid persisted in Redis. */
export interface OccupancyCache {
  syncedAt: string;
  rooms: string[];
  dates: string[];
  perRoom: { room: string; occupied: boolean[] }[];
}

/** Selectable bounds: first of the current month → last day of +12 months. No past. */
export function horizonRange(now: Date = new Date()): { start: string; end: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = `${y}-${pad(m + 1)}-01`;
  const end = new Date(Date.UTC(y, m + 13, 0)).toISOString().slice(0, 10); // last day of month +12
  return { start, end };
}

export function lastOfCurrentMonth(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

export function daysInclusive(start: string, end: string): number {
  return Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86_400_000) + 1;
}

export function rangeLabel(start: string, end: string): string {
  const s = new Date(start + 'T00:00:00Z');
  const e = new Date(end + 'T00:00:00Z');
  const firstOfMonth = start.slice(8) === '01';
  const lastOfMonth = end === new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  if (firstOfMonth && lastOfMonth && start.slice(0, 7) === end.slice(0, 7)) {
    return `${MONTHS_LONG[s.getUTCMonth()]} ${s.getUTCFullYear()}`;
  }
  const fmt = (d: Date) => `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return `${fmt(s)} – ${fmt(e)}`;
}

/**
 * Resolve + validate a requested range against the horizon. Missing values
 * default to the current month. Clamps into the horizon (no past, no beyond
 * +12 months) and rejects malformed or over-long ranges.
 */
export function resolveRange(
  startRaw: string | null | undefined,
  endRaw: string | null | undefined,
  horizon: { start: string; end: string },
  now: Date = new Date(),
): { start: string; end: string } | { error: string } {
  let start = (startRaw ?? '').trim() || horizon.start;
  let end = (endRaw ?? '').trim() || lastOfCurrentMonth(now);
  if (!YMD.test(start) || !YMD.test(end)) return { error: 'start/end must be YYYY-MM-DD' };
  if (start < horizon.start) start = horizon.start;
  if (end > horizon.end) end = horizon.end;
  if (start > end) return { error: 'start is after end (or outside the selectable window)' };
  if (daysInclusive(start, end) > MAX_RANGE_DAYS) return { error: `range exceeds ${MAX_RANGE_DAYS} days` };
  return { start, end };
}

/** Slice the cached horizon grid to a range and derive occupancy %s from the booleans. */
export function computeBoard(cache: OccupancyCache, start: string, end: string): OccupancyBoard {
  const idxs: number[] = [];
  for (let i = 0; i < cache.dates.length; i++) {
    if (cache.dates[i] >= start && cache.dates[i] <= end) idxs.push(i);
  }
  const dates = idxs.map((i) => cache.dates[i]);
  const available = dates.length;

  const calRows = cache.perRoom.map((r) => ({
    room: r.room,
    occupied: idxs.map((i) => r.occupied[i] ?? false),
  }));
  const perRoom = calRows.map((r) => {
    const sold = r.occupied.filter(Boolean).length;
    return {
      room: r.room,
      soldNights: sold,
      availableNights: available,
      occupancyPct: available > 0 ? Math.round((sold / available) * 100) : 0,
    };
  });
  const soldTotal = perRoom.reduce((s, r) => s + r.soldNights, 0);
  const availableTotal = cache.rooms.length * available;

  return {
    syncedAt: cache.syncedAt,
    period: { start, end, label: rangeLabel(start, end) },
    rooms: cache.rooms,
    overall: {
      soldNights: soldTotal,
      availableNights: availableTotal,
      occupancyPct: availableTotal > 0 ? Math.round((soldTotal / availableTotal) * 100) : 0,
    },
    perRoom,
    calendar: { dates, perRoom: calRows },
  };
}

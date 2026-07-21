'use client';
import { useState, useMemo, type ReactNode } from 'react';
import type { Reservation, Room, CustomerFlag } from "@/types/reservation";
import { computeParking, PARKING_SPACES } from "@/utils/parkingUtils";
import {
  groupRoomsByCategory,
  ALL_ROOMS_BY_CATEGORY,
  type RoomCategory,
} from "@/utils/roomCategory";
import { effectiveRateType } from "@/utils/rateType";
import { getEffectiveFlags } from "@/utils/flagUtils";

interface Props {
  reservations: Reservation[];
  /**
   * Click handler for booked / blacked-out / non-arrival day cells. Receives the
   * matching Reservation so the parent can open its drawer. Empty cells aren't
   * clickable.
   */
  onReservationClick?: (reservation: Reservation) => void;
}

// All rooms across both categories — used for the overall occupancy counters
// in the day header (which always represent total inventory regardless of
// whether a category is collapsed).
const ROOMS: Room[] = ALL_ROOMS_BY_CATEGORY as unknown as Room[];

const CATEGORY_STYLES: Record<RoomCategory, { headerBg: string; headerText: string; headerBorder: string; chevron: string }> = {
  Urban:  { headerBg: 'bg-cyan-50',  headerText: 'text-cyan-900',  headerBorder: 'border-cyan-200',  chevron: 'text-cyan-700' },
  Deluxe: { headerBg: 'bg-amber-50', headerText: 'text-amber-900', headerBorder: 'border-amber-200', chevron: 'text-amber-700' },
};

// ─── Colour-by modes ───────────────────────────────────────────────────────────
// The cell fill carries ONE dimension at a time (operator-selectable). Rate is
// the default; occupancy reproduces the old green→red heat; channel uses OTA
// brand colours. Non-arrival + blackout are status overlays shown in every mode.
type ColorBy = 'rate' | 'channel' | 'occupancy';

// Rate fills reuse today's rate palette. Booked-but-no-rate (e.g. Direct) → slate.
const RATE_FILL: Record<string, string> = {
  "Standard":       "bg-blue-200 text-blue-900",
  "Flexi":          "bg-emerald-200 text-emerald-900",
  "Weekly":         "bg-amber-200 text-amber-900",
  "Non-Refundable": "bg-red-200 text-red-900",
  "One-Night":      "bg-violet-200 text-violet-900",
};
const RATE_FILL_NONE = "bg-slate-200 text-slate-700";

const CHANNEL_FILL: Record<string, string> = {
  "Booking.com":  "bg-[#003B95] text-white",
  "Airbnb":       "bg-[#FF5A5F] text-white",
  "Direct":       "bg-indigo-500 text-white",
  "Direct-Phone": "bg-indigo-400 text-white",
  "Direct-Web":   "bg-emerald-500 text-white",
};
const CHANNEL_FILL_NONE = "bg-slate-400 text-white";

// Non-arrival: purple with a diagonal stripe so it never reads as a solid rate
// fill (One-Night is solid violet). Blackout: slate stripe (unchanged).
const NON_ARRIVAL_FILL =
  "bg-purple-100 text-purple-900 bg-[repeating-linear-gradient(45deg,rgba(109,40,217,0.28)_0_3px,transparent_3px_6px)]";
const BLACKOUT_FILL =
  "bg-slate-700 text-white bg-[repeating-linear-gradient(45deg,rgba(255,255,255,0.12)_0_3px,transparent_3px_6px)]";

// ─── Date helpers ─────────────────────────────────────────────────────────────

function getTodayStr(): string {
  return new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD, local time
}

function nextDay(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function get30DaysFrom(baseStr: string, offset: number): string[] {
  const days: string[] = [];
  const base = new Date(baseStr + "T00:00:00");
  base.setDate(base.getDate() + offset);
  for (let i = 0; i < 30; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

function formatDateRange(days: string[]): string {
  if (days.length === 0) return "";
  const fmt = (s: string) => {
    const d = new Date(s + "T00:00:00");
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  };
  return `${fmt(days[0])} – ${fmt(days[days.length - 1])}`;
}

// ─── Cell resolution ────────────────────────────────────────────────────────────

function roomMatches(r: Reservation, room: string): boolean {
  return r.room === room || (r.linkedRooms?.includes(room) ?? false);
}

function coversCell(r: Reservation, room: string, date: string): boolean {
  return roomMatches(r, room) && r.checkInDate <= date && r.checkOutDate > date;
}

/** Active guest stay on a cell — not blackout, not cancelled/non-arrival, not refunded. */
function findActiveRes(reservations: Reservation[], room: Room, date: string): Reservation | null {
  return (
    reservations.find(
      (r) => !r.isBlackout && !r.isCancelled && r.paymentStatus !== "Refunded" && coversCell(r, room, date),
    ) ?? null
  );
}

function isRoomBooked(reservations: Reservation[], room: Room, date: string): boolean {
  return findActiveRes(reservations, room, date) !== null;
}

/** Non-arrival covering a cell — only surfaced when no active stay resold the night. */
function findNonArrivalForCell(reservations: Reservation[], room: Room, date: string): Reservation | null {
  return reservations.find((r) => r.nonArrival && coversCell(r, room, date)) ?? null;
}

function findBlackoutForCell(reservations: Reservation[], room: Room, date: string): Reservation | null {
  return reservations.find((r) => r.isBlackout && coversCell(r, room, date)) ?? null;
}

type CellKind = 'active' | 'blackout' | 'nonarrival' | 'empty';
interface ResolvedCell {
  kind: CellKind;
  res: Reservation | null;
}

/** Priority: active guest > blackout > non-arrival stripe > empty. */
function resolveCell(reservations: Reservation[], room: Room, date: string): ResolvedCell {
  const active = findActiveRes(reservations, room, date);
  if (active) return { kind: 'active', res: active };
  const blackout = findBlackoutForCell(reservations, room, date);
  if (blackout) return { kind: 'blackout', res: blackout };
  const nonArr = findNonArrivalForCell(reservations, room, date);
  if (nonArr) return { kind: 'nonarrival', res: nonArr };
  return { kind: 'empty', res: null };
}

function initialsOf(r: Reservation): string {
  return [r.firstName?.[0], r.lastName?.[0]].filter(Boolean).join("").toUpperCase();
}

// Highest-priority flag glyph for the arrival cell (problem > VIP > high-value > repeat).
function flagGlyph(flags: CustomerFlag[]): string | null {
  if (flags.includes("Problematic Customer")) return "⚠";
  if (flags.includes("VIP Customer")) return "👑";
  if (flags.includes("High Value Customer")) return "★";
  if (flags.includes("Repeat Customer")) return "↩";
  return null;
}

// Occupancy heat — 0 green, ≤33 amber, ≤66 orange, >66 red (full = red, kept scale).
function occHeaderClass(pct: number): string {
  if (pct <= 0) return "bg-emerald-100 text-emerald-700";
  if (pct <= 33) return "bg-amber-100 text-amber-700";
  if (pct <= 66) return "bg-orange-100 text-orange-700";
  return "bg-red-100 text-red-700";
}
function occFillClass(pct: number): string {
  if (pct <= 0) return "bg-emerald-400";
  if (pct <= 33) return "bg-amber-400";
  if (pct <= 66) return "bg-orange-500";
  return "bg-red-500";
}

function parkingRowLabel(space: string): string {
  return `P${space}`;
}

function formatRoomForTooltip(room: string): string {
  return room.replace(/\./g, '').replace(/\s+/g, '');
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function OccupancyCalendar({ reservations, onReservationClick }: Props) {
  const todayStr = getTodayStr();
  const [startOffset, setStartOffset] = useState(0);
  const [showParking, setShowParking] = useState(false);
  const [colorBy, setColorBy] = useState<ColorBy>('rate');
  const [collapsed, setCollapsed] = useState<Record<RoomCategory, boolean>>({
    Urban:  false,
    Deluxe: false,
  });

  const days = useMemo(() => get30DaysFrom(todayStr, startOffset), [todayStr, startOffset]);
  const parkingResult = useMemo(() => computeParking(reservations), [reservations]);
  const categoryGroups = useMemo(() => groupRoomsByCategory(), []);

  // Booked-room count per day (whole property) — drives the day-header heat and
  // the occupancy colour-by mode. Computed once per render rather than per cell.
  const bookedCountByDate = useMemo(() => {
    const m: Record<string, number> = {};
    for (const date of days) {
      m[date] = ROOMS.filter((r) => isRoomBooked(reservations, r, date)).length;
    }
    return m;
  }, [reservations, days]);

  // Per-category occupancy % across the visible window (sold room-nights ÷ available).
  const occByCategory = useMemo(() => {
    const m: Record<string, number> = {};
    for (const group of categoryGroups) {
      let sold = 0;
      for (const room of group.rooms) {
        for (const date of days) if (isRoomBooked(reservations, room as Room, date)) sold += 1;
      }
      const avail = group.rooms.length * days.length;
      m[group.category] = avail > 0 ? Math.round((sold / avail) * 100) : 0;
    }
    return m;
  }, [reservations, days, categoryGroups]);

  function cellFill(res: Reservation, date: string): string {
    if (colorBy === 'channel') return CHANNEL_FILL[res.channel] ?? CHANNEL_FILL_NONE;
    if (colorBy === 'occupancy') {
      const pct = Math.round(((bookedCountByDate[date] ?? 0) / ROOMS.length) * 100);
      return `${occFillClass(pct)} text-white`;
    }
    const rt = effectiveRateType(res);
    return (rt && RATE_FILL[rt]) || RATE_FILL_NONE;
  }

  const legendItems: { label: string; cls: string }[] =
    colorBy === 'rate'
      ? [
          { label: "Standard", cls: RATE_FILL.Standard },
          { label: "Flexi", cls: RATE_FILL.Flexi },
          { label: "Weekly", cls: RATE_FILL.Weekly },
          { label: "Non-ref.", cls: RATE_FILL["Non-Refundable"] },
          { label: "1-night", cls: RATE_FILL["One-Night"] },
          { label: "Other", cls: RATE_FILL_NONE },
        ]
      : colorBy === 'channel'
      ? [
          { label: "Booking", cls: CHANNEL_FILL["Booking.com"] },
          { label: "Airbnb", cls: CHANNEL_FILL.Airbnb },
          { label: "Direct", cls: CHANNEL_FILL.Direct },
        ]
      : [
          { label: "Free", cls: "bg-emerald-400" },
          { label: "Low", cls: "bg-amber-400" },
          { label: "High", cls: "bg-orange-500" },
          { label: "Full", cls: "bg-red-500" },
        ];

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 mb-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-y-2 mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-sm font-semibold text-gray-700">Availability</p>
          <span className="text-xs text-gray-400 truncate">{formatDateRange(days)}</span>
        </div>

        <div className="flex items-center gap-3 flex-wrap justify-end">
          {/* Colour-by switch */}
          <label className="flex items-center gap-1.5 text-xs text-gray-500">
            <span className="hidden sm:inline">Colour by</span>
            <select
              value={colorBy}
              onChange={(e) => setColorBy(e.target.value as ColorBy)}
              className="border border-gray-200 rounded-md px-2 py-1 text-xs text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="rate">Rate</option>
              <option value="channel">Channel</option>
              <option value="occupancy">Occupancy</option>
            </select>
          </label>

          {/* Navigation */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setStartOffset((o) => Math.max(o - 7, -7))}
              disabled={startOffset <= -7}
              className="p-1 rounded hover:bg-gray-100 text-gray-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="Previous week"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>

            {startOffset !== 0 && (
              <button
                onClick={() => setStartOffset(0)}
                className="px-2 py-0.5 text-xs font-medium text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
              >
                Today
              </button>
            )}

            <button
              onClick={() => setStartOffset((o) => o + 7)}
              className="p-1 rounded hover:bg-gray-100 text-gray-500 transition-colors"
              title="Next week"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>

          {/* Parking toggle */}
          <button
            onClick={() => setShowParking((v) => !v)}
            className={`px-2 py-1 text-xs font-medium rounded transition-colors ${
              showParking ? "bg-indigo-100 text-indigo-700 hover:bg-indigo-200" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
            }`}
          >
            <span className="flex items-center gap-1">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8" />
              </svg>
              Parking
            </span>
          </button>

          {/* Legend — mode-dependent fills + always-on status overlays */}
          <div className="flex items-center gap-2 sm:gap-3 text-xs text-gray-500 flex-wrap">
            {legendItems.map(({ label, cls }) => (
              <span key={label} className="flex items-center gap-1.5" title={label}>
                <span className={`inline-block w-3 h-3 rounded-sm ${cls}`} />
                <span className="hidden lg:inline">{label}</span>
              </span>
            ))}
            <span className="flex items-center gap-1.5" title="Non-arrival">
              <span className={`inline-block w-3 h-3 rounded-sm ${NON_ARRIVAL_FILL}`} />
              <span className="hidden lg:inline">Non-arrival</span>
            </span>
            <span className="flex items-center gap-1.5" title="Blackout">
              <span className={`inline-block w-3 h-3 rounded-sm ${BLACKOUT_FILL}`} />
              <span className="hidden lg:inline">Blackout</span>
            </span>
          </div>
        </div>
      </div>

      {/* Grid — scrollable on small screens */}
      <div className="overflow-x-auto">
        <table className="border-collapse w-full">
          <thead>
            <tr>
              <th className="w-14" />
              {days.map((date) => {
                const d = new Date(date + "T00:00:00");
                const dayNum = d.getDate();
                const isToday = date === todayStr;
                const showMonth = dayNum === 1 || date === days[0];
                const bookedCount = bookedCountByDate[date] ?? 0;
                const pct = Math.round((bookedCount / ROOMS.length) * 100);
                const dayAbbr = d.toLocaleString("en-GB", { weekday: "short" }).slice(0, 2);

                return (
                  <th key={date} className="px-px pb-1 min-w-[2rem]">
                    <div
                      className={`rounded-sm px-0.5 py-0.5 ${occHeaderClass(pct)} ${isToday ? "ring-2 ring-indigo-400 ring-inset" : ""}`}
                      title={bookedCount === 0 ? "All rooms free" : `${bookedCount} / ${ROOMS.length} rooms booked`}
                    >
                      <div className={`text-center text-xs font-bold leading-none ${isToday ? "underline" : ""}`}>{dayNum}</div>
                      <div className="text-center text-[9px] leading-tight opacity-70">{dayAbbr}</div>
                      <div className="text-center text-[9px] leading-tight opacity-70 h-3">
                        {showMonth ? d.toLocaleString("en-GB", { month: "short" }) : ""}
                      </div>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>

          {categoryGroups.map((group) => {
            const style = CATEGORY_STYLES[group.category];
            const isCollapsed = collapsed[group.category];
            const groupRooms = group.rooms;
            const occPct = occByCategory[group.category] ?? 0;
            return (
              <tbody key={group.category}>
                {/* Category header row — collapse toggle + occupancy % for the window */}
                <tr>
                  <td colSpan={days.length + 1} className={`p-0 ${style.headerBorder} border-t border-b`}>
                    <div className={`w-full flex items-center gap-2 px-2 py-1.5 ${style.headerBg} ${style.headerText}`}>
                      <button
                        onClick={() => setCollapsed((c) => ({ ...c, [group.category]: !c[group.category] }))}
                        className="flex items-center gap-2 hover:brightness-95 transition"
                        title={isCollapsed ? `Show ${group.category} rooms` : `Hide ${group.category} rooms`}
                      >
                        <svg
                          className={`w-3.5 h-3.5 ${style.chevron} transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                          fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                        </svg>
                        <span className="text-xs font-semibold uppercase tracking-wide">{group.category}</span>
                        <span className="text-[11px] opacity-70 font-medium">
                          · {groupRooms.length} room{groupRooms.length === 1 ? '' : 's'}
                        </span>
                      </button>
                      {/* Occupancy for the displayed period */}
                      <span className="ml-auto flex items-center gap-2" title={`${group.category} occupancy for ${formatDateRange(days)}`}>
                        <span className="text-[11px] opacity-70 hidden sm:inline">occupancy</span>
                        <span className="inline-block w-16 h-1.5 rounded-full bg-black/10 overflow-hidden">
                          <span className={`block h-1.5 ${occFillClass(occPct)}`} style={{ width: `${occPct}%` }} />
                        </span>
                        <span className="text-xs font-semibold tabular-nums">{occPct}%</span>
                      </span>
                    </div>
                  </td>
                </tr>

                {/* Day-cell rows */}
                {!isCollapsed && groupRooms.map((room) => (
                  <tr key={room}>
                    <td className="pr-2 py-0.5 text-xs font-medium text-gray-500 text-right whitespace-nowrap">{room}</td>

                    {days.map((date) => {
                      const isToday = date === todayStr;
                      const { kind, res } = resolveCell(reservations, room as Room, date);
                      const clickable = kind !== 'empty' && !!onReservationClick;

                      let inner: ReactNode = null;
                      let title = `${room} — free`;
                      let barCls = 'bg-gray-100'; // empty
                      let isStart = false;
                      let isEnd = false;

                      if (res && kind !== 'empty') {
                        isStart = res.checkInDate === date;
                        isEnd = nextDay(date) === res.checkOutDate;
                        if (kind === 'active') {
                          barCls = cellFill(res, date);
                          const glyph = isStart ? flagGlyph(getEffectiveFlags(res, reservations)) : null;
                          title = `${room} — ${`${res.firstName} ${res.lastName}`.trim() || 'booked'}`;
                          inner = isStart ? (
                            <span className="flex items-center gap-0.5 text-[9px] font-bold leading-none select-none tracking-tight truncate px-0.5">
                              {glyph && <span>{glyph}</span>}
                              {initialsOf(res)}
                            </span>
                          ) : null;
                        } else if (kind === 'blackout') {
                          barCls = BLACKOUT_FILL;
                          title = `${room} — blacked out`;
                          inner = isStart ? <span className="text-[9px] font-bold leading-none select-none">BLK</span> : null;
                        } else {
                          // non-arrival
                          barCls = NON_ARRIVAL_FILL;
                          title = `${room} — non-arrival (room freed for resale)`;
                          inner = isStart ? <span className="text-[10px] leading-none select-none">🚨</span> : null;
                        }
                      }

                      const handleClick = clickable && res ? () => onReservationClick!(res) : undefined;

                      return (
                        <td key={date} className={`px-px py-0.5 ${isToday ? "ring-1 ring-indigo-300 ring-inset" : ""}`}>
                          <div
                            className={`h-5 flex items-center justify-center ${barCls} ${
                              kind === 'empty' ? 'rounded-sm' : ''
                            } ${isStart ? 'ml-1 rounded-l-md' : ''} ${isEnd ? 'mr-1 rounded-r-md' : ''} ${
                              clickable ? 'cursor-pointer hover:ring-2 hover:ring-indigo-400 hover:ring-inset' : ''
                            }`}
                            title={title}
                            onClick={handleClick}
                          >
                            {inner}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            );
          })}

          {/* Parking rows */}
          {showParking && (
            <tbody>
              {PARKING_SPACES.map((ps, psIdx) => {
                const spaceGrid = parkingResult.grid.get(ps.space);
                return (
                  <tr key={ps.space}>
                    <td className={`pr-2 py-0.5 text-xs font-medium text-gray-500 text-right whitespace-nowrap ${psIdx === 0 ? "pt-2 border-t border-gray-200" : ""}`}>
                      {parkingRowLabel(ps.space)}
                    </td>
                    {days.map((date) => {
                      const cell = spaceGrid?.get(date) ?? null;
                      const isToday = date === todayStr;
                      const occupied = cell != null;
                      const occupantRes = occupied
                        ? reservations.find((r) => r.reservationNumber === cell!.reservationNumber)
                        : null;
                      const roomStr = occupantRes ? formatRoomForTooltip(occupantRes.room) : '';

                      return (
                        <td key={date} className={`px-px py-0.5 ${isToday ? "ring-1 ring-indigo-300 ring-inset" : ""} ${psIdx === 0 ? "pt-2 border-t border-gray-200" : ""}`}>
                          <div
                            className={`h-5 rounded-sm flex items-center justify-center ${occupied ? "bg-red-400" : "bg-emerald-200"}`}
                            title={occupied ? `P${ps.space}-${cell!.initials}${roomStr ? `-${roomStr}` : ''}` : `P${ps.space} — free`}
                          >
                            {occupied && (
                              <span className="text-[9px] font-bold text-white leading-none select-none">{cell!.initials}</span>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          )}
        </table>
      </div>
    </div>
  );
}

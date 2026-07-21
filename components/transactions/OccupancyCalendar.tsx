'use client';
import { useState, useMemo, type ReactNode, type CSSProperties } from 'react';
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
   * Click handler for a reservation bar (booked / blacked-out / non-arrival).
   * Empty days aren't clickable.
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
// The bar fill carries ONE dimension at a time (operator-selectable). Rate is
// the default; channel uses OTA brand colours; occupancy tints the day columns
// with the green→red heat and leaves the bars transparent so it reads through.
// Non-arrival + blackout are status overlays shown in every mode.
type ColorBy = 'rate' | 'channel' | 'occupancy';

// A booking bar's palette: soft fill (f), border (b), text (t), avatar chip (a).
// Fills sit one step up from the lightest tint so the colour reads at a glance
// without going back to saturated solid blocks.
interface Palette { f: string; b: string; t: string; a: string }

const RATE_FILL: Record<string, Palette> = {
  "Standard":       { f: '#B5D4F4', b: '#378ADD', t: '#042C53', a: '#185FA5' },
  "Flexi":          { f: '#C0DD97', b: '#639922', t: '#173404', a: '#3B6D11' },
  "Weekly":         { f: '#FAC775', b: '#BA7517', t: '#412402', a: '#854F0B' },
  "Non-Refundable": { f: '#F7C1C1', b: '#E24B4A', t: '#501313', a: '#A32D2D' },
  "One-Night":      { f: '#CECBF6', b: '#7F77DD', t: '#26215C', a: '#534AB7' },
};
const RATE_NONE: Palette = { f: '#D3D1C7', b: '#888780', t: '#2C2C2A', a: '#5F5E5A' };

const CHANNEL_FILL: Record<string, Palette> = {
  "Booking.com":  { f: '#B5D4F4', b: '#378ADD', t: '#042C53', a: '#003B95' },
  "Airbnb":       { f: '#F7C1C1', b: '#E24B4A', t: '#501313', a: '#FF5A5F' },
  "Direct":       { f: '#CECBF6', b: '#7F77DD', t: '#26215C', a: '#534AB7' },
  "Direct-Phone": { f: '#CECBF6', b: '#7F77DD', t: '#26215C', a: '#7F77DD' },
  "Direct-Web":   { f: '#C0DD97', b: '#639922', t: '#173404', a: '#3B6D11' },
};
const CHANNEL_NONE: Palette = RATE_NONE;

// Non-arrival: purple with a diagonal stripe so it never reads as a solid rate
// fill (One-Night is solid violet). Blackout: dark slate stripe.
const NA_PAL: Palette = { f: '#CECBF6', b: '#534AB7', t: '#26215C', a: '#3C3489' };
const BLACKOUT_PAL: Palette = { f: '#444441', b: '#2C2C2A', t: '#F1EFE8', a: '#2C2C2A' };
const NA_STRIPE = 'repeating-linear-gradient(45deg,rgba(60,52,137,0.22) 0 5px,transparent 5px 10px)';
const BLACKOUT_STRIPE = 'repeating-linear-gradient(45deg,rgba(255,255,255,0.14) 0 5px,transparent 5px 10px)';

// Layout — a comfortable row height with breathing room, and a minimum column
// width so the grid stays legible and scrolls horizontally on small screens.
const LABEL_W = '3rem';
const OCC_W = '4.5rem';
const DAY_MIN_PX = 30;
const ROW_H = '2.25rem';
const BAR_H = '1.6rem';

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
      (r) =>
        !r.isBlackout &&
        !r.isCancelled &&
        !r.nonArrival && // a flagged non-arrival frees the room even before the Beds24 cancel syncs
        r.paymentStatus !== "Refunded" &&
        coversCell(r, room, date),
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

/** A contiguous run of days in the visible window that belongs to one booking. */
interface Segment {
  kind: Exclude<CellKind, 'empty'>;
  res: Reservation;
  startIdx: number;
  endIdx: number;
  resold: boolean;
}

function initialsOf(r: Reservation): string {
  return [r.firstName?.[0], r.lastName?.[0]].filter(Boolean).join("").toUpperCase() || "?";
}

function guestName(r: Reservation): string {
  return `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim();
}

// Highest-priority flag for a reservation (problem > VIP > high-value > repeat).
// Fixed colours (NOT inherited from the bar): star = gold, crown = red,
// problem = red, repeat = indigo — rendered in a white chip so they read on any fill.
function flagInfo(flags: CustomerFlag[]): { glyph: string; color: string } | null {
  if (flags.includes("Problematic Customer")) return { glyph: "!", color: "#dc2626" };
  if (flags.includes("VIP Customer")) return { glyph: "♛", color: "#dc2626" };
  if (flags.includes("High Value Customer")) return { glyph: "★", color: "#d97706" };
  if (flags.includes("Repeat Customer")) return { glyph: "↻", color: "#4f46e5" };
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
// Light heat fill behind the day columns in the "occupancy" colour-by mode.
function occCellBg(pct: number): string {
  if (pct <= 0) return "#E1F5EE";
  if (pct <= 33) return "#FAEEDA";
  if (pct <= 66) return "#FAC775";
  return "#F7C1C1";
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

  const N = days.length;
  const trackCols = `repeat(${N}, minmax(0, 1fr))`;
  const rowCols = `${LABEL_W} minmax(0, 1fr) ${OCC_W}`;
  const minWidth = `${(N * DAY_MIN_PX) + 48 + 72}px`;

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

  // Per-room occupancy % across the visible window (right-hand column).
  const occByRoom = useMemo(() => {
    const m: Record<string, number> = {};
    for (const room of ROOMS) {
      let sold = 0;
      for (const date of days) if (isRoomBooked(reservations, room, date)) sold += 1;
      m[room] = days.length > 0 ? Math.round((sold / days.length) * 100) : 0;
    }
    return m;
  }, [reservations, days]);

  // Effective guest flag per reservation (computed once, not per cell).
  const flagByRes = useMemo(() => {
    const m: Record<string, { glyph: string; color: string } | null> = {};
    for (const r of reservations) {
      if (!r.isBlackout) m[r.reservationNumber] = flagInfo(getEffectiveFlags(r, reservations));
    }
    return m;
  }, [reservations]);

  // Coalesce a room's visible days into booking segments (one bar per booking).
  const segmentsByRoom = useMemo(() => {
    const m: Record<string, Segment[]> = {};
    for (const room of ROOMS) {
      const segs: Segment[] = [];
      let cur: Segment | null = null;
      days.forEach((date, idx) => {
        const { kind, res } = resolveCell(reservations, room, date);
        if (kind === 'empty' || !res) { cur = null; return; }
        if (cur && cur.res.reservationNumber === res.reservationNumber && cur.kind === kind && cur.endIdx === idx - 1) {
          cur.endIdx = idx;
        } else {
          cur = { kind, res, startIdx: idx, endIdx: idx, resold: false };
          segs.push(cur);
        }
      });
      // Mark active segments that resold a non-arrival's freed nights.
      for (const s of segs) {
        if (s.kind !== 'active') continue;
        for (let i = s.startIdx; i <= s.endIdx; i++) {
          if (findNonArrivalForCell(reservations, room, days[i])) { s.resold = true; break; }
        }
      }
      m[room] = segs;
    }
    return m;
  }, [reservations, days]);

  function segPalette(seg: Segment): { pal: Palette; transparent: boolean } {
    if (seg.kind === 'blackout') return { pal: BLACKOUT_PAL, transparent: false };
    if (seg.kind === 'nonarrival') return { pal: NA_PAL, transparent: false };
    const ratePal =
      colorBy === 'channel'
        ? (CHANNEL_FILL[seg.res.channel] ?? CHANNEL_NONE)
        : (RATE_FILL[effectiveRateType(seg.res) ?? ''] ?? RATE_NONE);
    return { pal: ratePal, transparent: colorBy === 'occupancy' };
  }

  const legendItems: { label: string; pal: Palette }[] =
    colorBy === 'rate'
      ? [
          { label: "Standard", pal: RATE_FILL.Standard },
          { label: "Flexi", pal: RATE_FILL.Flexi },
          { label: "Weekly", pal: RATE_FILL.Weekly },
          { label: "Non-ref.", pal: RATE_FILL["Non-Refundable"] },
          { label: "1-night", pal: RATE_FILL["One-Night"] },
          { label: "Other", pal: RATE_NONE },
        ]
      : colorBy === 'channel'
      ? [
          { label: "Booking", pal: CHANNEL_FILL["Booking.com"] },
          { label: "Airbnb", pal: CHANNEL_FILL.Airbnb },
          { label: "Direct", pal: CHANNEL_FILL.Direct },
        ]
      : [
          { label: "Free", pal: { f: occCellBg(0), b: '#9FE1CB', t: '', a: '' } },
          { label: "Low", pal: { f: occCellBg(30), b: '#FAC775', t: '', a: '' } },
          { label: "High", pal: { f: occCellBg(60), b: '#EF9F27', t: '', a: '' } },
          { label: "Full", pal: { f: occCellBg(100), b: '#E24B4A', t: '', a: '' } },
        ];

  function renderBar(room: Room, seg: Segment): ReactNode {
    const { pal, transparent } = segPalette(seg);
    const res = seg.res;
    const isTrueStart = res.checkInDate === days[seg.startIdx];
    const isTrueEnd = nextDay(days[seg.endIdx]) === res.checkOutDate;
    const flag = seg.kind === 'active' ? flagByRes[res.reservationNumber] : null;
    const stripe = seg.kind === 'nonarrival' ? NA_STRIPE : seg.kind === 'blackout' ? BLACKOUT_STRIPE : undefined;
    const textColor = transparent ? '#2C2C2A' : pal.t;

    const label =
      seg.kind === 'blackout' ? 'Blackout' : guestName(res) || (seg.kind === 'nonarrival' ? 'Non-arrival' : 'Booked');
    const title =
      seg.kind === 'blackout'
        ? `${room} — blacked out`
        : seg.kind === 'nonarrival'
        ? `${room} — non-arrival (room freed for resale)`
        : `${room} — ${label}${seg.resold ? ' (resold from a non-arrival)' : ''}`;

    const barStyle: CSSProperties = {
      gridColumn: `${seg.startIdx + 1} / ${seg.endIdx + 2}`,
      gridRow: 1,
      alignSelf: 'center',
      zIndex: 1,
      height: BAR_H,
      margin: '0 2px',
      background: transparent ? 'transparent' : pal.f,
      backgroundImage: stripe,
      border: transparent ? '1px dashed rgba(0,0,0,0.18)' : `1px solid ${pal.b}`,
      borderTopLeftRadius: isTrueStart ? 8 : 0,
      borderBottomLeftRadius: isTrueStart ? 8 : 0,
      borderTopRightRadius: isTrueEnd ? 8 : 0,
      borderBottomRightRadius: isTrueEnd ? 8 : 0,
      color: textColor,
    };

    return (
      <div
        key={`${res.reservationNumber}-${seg.startIdx}`}
        role={onReservationClick ? 'button' : undefined}
        tabIndex={onReservationClick ? 0 : undefined}
        onClick={onReservationClick ? () => onReservationClick(res) : undefined}
        onKeyDown={
          onReservationClick
            ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onReservationClick(res); } }
            : undefined
        }
        title={title}
        className={`relative flex items-center gap-1 px-1 overflow-hidden ${onReservationClick ? 'cursor-pointer hover:ring-2 hover:ring-indigo-400' : ''}`}
        style={barStyle}
      >
        {seg.kind !== 'blackout' && (
          <span
            className="inline-flex items-center justify-center rounded-full text-white font-medium shrink-0"
            style={{ width: 18, height: 18, fontSize: 9, background: pal.a }}
          >
            {initialsOf(res)}
          </span>
        )}
        {seg.kind === 'nonarrival' && (
          <span className="text-[10px] leading-none shrink-0" aria-hidden>🚨</span>
        )}
        {flag && (
          <span
            className="inline-flex items-center justify-center rounded-full bg-white shrink-0 shadow-sm"
            style={{ width: 14, height: 14, fontSize: 8, color: flag.color, fontWeight: 700 }}
            title={flag.glyph}
          >
            {flag.glyph}
          </span>
        )}
        <span className="text-[11px] font-medium leading-none truncate select-none">{label}</span>
        {seg.resold && (
          <span
            className="absolute bottom-0 right-0"
            style={{ width: 0, height: 0, borderLeft: '5px solid transparent', borderBottom: '5px solid #7C3AED' }}
            title="Resold from a non-arrival"
          />
        )}
      </div>
    );
  }

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
            {legendItems.map(({ label, pal }) => (
              <span key={label} className="flex items-center gap-1.5" title={label}>
                <span className="inline-block w-3 h-3 rounded" style={{ background: pal.f, border: `1px solid ${pal.b}` }} />
                <span className="hidden lg:inline">{label}</span>
              </span>
            ))}
            <span className="flex items-center gap-1.5" title="Non-arrival">
              <span className="inline-block w-3 h-3 rounded" style={{ background: NA_PAL.f, border: `1px solid ${NA_PAL.b}`, backgroundImage: NA_STRIPE }} />
              <span className="hidden lg:inline">Non-arrival</span>
            </span>
            <span className="flex items-center gap-1.5" title="Blackout">
              <span className="inline-block w-3 h-3 rounded" style={{ background: BLACKOUT_PAL.f, backgroundImage: BLACKOUT_STRIPE }} />
              <span className="hidden lg:inline">Blackout</span>
            </span>
          </div>
        </div>
      </div>

      {/* Grid — scrollable on small screens */}
      <div className="overflow-x-auto">
        <div style={{ minWidth }}>
          {/* Day header */}
          <div style={{ display: 'grid', gridTemplateColumns: rowCols, alignItems: 'end' }} className="mb-1.5">
            <div />
            <div style={{ display: 'grid', gridTemplateColumns: trackCols }}>
              {days.map((date) => {
                const d = new Date(date + "T00:00:00");
                const dayNum = d.getDate();
                const isToday = date === todayStr;
                const showMonth = dayNum === 1 || date === days[0];
                const bookedCount = bookedCountByDate[date] ?? 0;
                const pct = Math.round((bookedCount / ROOMS.length) * 100);
                const dayAbbr = d.toLocaleString("en-GB", { weekday: "short" }).slice(0, 2);
                return (
                  <div key={date} className="px-px">
                    <div
                      className={`rounded-md px-0.5 py-0.5 ${occHeaderClass(pct)} ${isToday ? "ring-2 ring-indigo-400 ring-inset" : ""}`}
                      title={bookedCount === 0 ? "All rooms free" : `${bookedCount} / ${ROOMS.length} rooms booked`}
                    >
                      <div className={`text-center text-xs font-bold leading-none ${isToday ? "underline" : ""}`}>{dayNum}</div>
                      <div className="text-center text-[9px] leading-tight opacity-70">{dayAbbr}</div>
                      <div className="text-center text-[9px] leading-tight opacity-70 h-3">
                        {showMonth ? d.toLocaleString("en-GB", { month: "short" }) : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="pl-2 text-[10px] font-medium text-gray-400 text-right">Occ</div>
          </div>

          {categoryGroups.map((group) => {
            const style = CATEGORY_STYLES[group.category];
            const isCollapsed = collapsed[group.category];
            const groupRooms = group.rooms;
            const occPct = occByCategory[group.category] ?? 0;
            return (
              <div key={group.category}>
                {/* Category header row — collapse toggle + occupancy % for the window */}
                <div className={`flex items-center gap-2 px-2 py-1.5 my-1 rounded-md border ${style.headerBorder} ${style.headerBg} ${style.headerText}`}>
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

                {/* Day-cell rows */}
                {!isCollapsed && groupRooms.map((room) => (
                  <div key={room} style={{ display: 'grid', gridTemplateColumns: rowCols, alignItems: 'center', height: ROW_H }}>
                    <div className="pr-2 text-xs font-medium text-gray-500 text-right whitespace-nowrap">{room}</div>

                    {/* Track: background day columns + booking bars overlaid in the same grid row */}
                    <div style={{ display: 'grid', gridTemplateColumns: trackCols, position: 'relative', height: ROW_H }}>
                      {days.map((date, idx) => {
                        const isToday = date === todayStr;
                        const bg =
                          colorBy === 'occupancy'
                            ? occCellBg(Math.round(((bookedCountByDate[date] ?? 0) / ROOMS.length) * 100))
                            : undefined;
                        return (
                          <div
                            key={date}
                            style={{ gridColumn: `${idx + 1} / ${idx + 2}`, gridRow: 1, background: bg }}
                            className={`border-r border-gray-100 ${isToday ? 'bg-indigo-50/60' : ''}`}
                          />
                        );
                      })}
                      {(segmentsByRoom[room] ?? []).map((seg) => renderBar(room as Room, seg))}
                    </div>

                    {/* Per-room occupancy for the visible window */}
                    <div className="pl-2 flex items-center justify-end gap-1.5 whitespace-nowrap">
                      <span className="inline-block w-8 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                        <span className={`block h-1.5 ${occFillClass(occByRoom[room] ?? 0)}`} style={{ width: `${occByRoom[room] ?? 0}%` }} />
                      </span>
                      <span className="text-xs text-gray-600 tabular-nums w-8 text-right">{occByRoom[room] ?? 0}%</span>
                    </div>
                  </div>
                ))}
              </div>
            );
          })}

          {/* Parking rows */}
          {showParking && (
            <div className="mt-2 pt-2 border-t border-gray-200">
              {PARKING_SPACES.map((ps) => {
                const spaceGrid = parkingResult.grid.get(ps.space);
                return (
                  <div key={ps.space} style={{ display: 'grid', gridTemplateColumns: rowCols, alignItems: 'center', height: ROW_H }}>
                    <div className="pr-2 text-xs font-medium text-gray-500 text-right whitespace-nowrap">{parkingRowLabel(ps.space)}</div>
                    <div style={{ display: 'grid', gridTemplateColumns: trackCols, height: ROW_H, alignItems: 'center' }}>
                      {days.map((date) => {
                        const cell = spaceGrid?.get(date) ?? null;
                        const isToday = date === todayStr;
                        const occupied = cell != null;
                        const occupantRes = occupied
                          ? reservations.find((r) => r.reservationNumber === cell!.reservationNumber)
                          : null;
                        const roomStr = occupantRes ? formatRoomForTooltip(occupantRes.room) : '';
                        return (
                          <div key={date} className="px-px flex items-center">
                            <div
                              className={`w-full flex items-center justify-center rounded ${occupied ? "bg-rose-200" : "bg-emerald-50"} ${isToday ? 'ring-1 ring-indigo-300 ring-inset' : ''}`}
                              style={{ height: BAR_H }}
                              title={occupied ? `P${ps.space}-${cell!.initials}${roomStr ? `-${roomStr}` : ''}` : `P${ps.space} — free`}
                            >
                              {occupied && (
                                <span className="text-[9px] font-bold text-rose-800 leading-none select-none">{cell!.initials}</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

'use client';
import { useState, useMemo } from 'react';
import type { Reservation, Room } from "@/types/reservation";
import { computeParking, PARKING_SPACES } from "@/utils/parkingUtils";
import {
  groupRoomsByCategory,
  ALL_ROOMS_BY_CATEGORY,
  type RoomCategory,
} from "@/utils/roomCategory";

interface Props {
  reservations: Reservation[];
}

// All rooms across both categories — used for the overall occupancy counters
// in the day header (which always represent total inventory regardless of
// whether a category is collapsed).
const ROOMS: Room[] = ALL_ROOMS_BY_CATEGORY as unknown as Room[];

// Visual treatment per category — matches the warm/cool palette used by
// roomVisuals.ts so the calendar grouping looks consistent with room chips.
const CATEGORY_STYLES: Record<RoomCategory, { headerBg: string; headerText: string; headerBorder: string; chevron: string }> = {
  Urban:  {
    headerBg:     'bg-cyan-50',
    headerText:   'text-cyan-900',
    headerBorder: 'border-cyan-200',
    chevron:      'text-cyan-700',
  },
  Deluxe: {
    headerBg:     'bg-amber-50',
    headerText:   'text-amber-900',
    headerBorder: 'border-amber-200',
    chevron:      'text-amber-700',
  },
};

// ─── Date helpers ─────────────────────────────────────────────────────────────

function getTodayStr(): string {
  return new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD, local time
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

// ─── Occupancy helpers ────────────────────────────────────────────────────────

function roomMatches(r: Reservation, room: string): boolean {
  return r.room === room || (r.linkedRooms?.includes(room) ?? false);
}

function isRoomBooked(reservations: Reservation[], room: Room, date: string): boolean {
  return reservations.some(
    (r) =>
      roomMatches(r, room) &&
      r.paymentStatus !== "Refunded" &&
      r.checkInDate <= date &&
      r.checkOutDate > date
  );
}

function getGuest(reservations: Reservation[], room: Room, date: string): { name: string; initials: string } | null {
  const res = reservations.find(
    (r) =>
      roomMatches(r, room) &&
      r.paymentStatus !== "Refunded" &&
      r.checkInDate <= date &&
      r.checkOutDate > date
  );
  if (!res) return null;
  const name = `${res.firstName} ${res.lastName}`.trim();
  const initials = [res.firstName?.[0], res.lastName?.[0]].filter(Boolean).join("").toUpperCase();
  return name ? { name, initials } : null;
}

// Colour scale: 0% = green, 1–33% = amber, 34–66% = orange, 67–100% = red.
function getOccupancyStyle(bookedCount: number, totalRooms: number) {
  if (bookedCount === 0) {
    return { header: "bg-emerald-100 text-emerald-700", filled: "bg-emerald-400" };
  }
  const pct = bookedCount / totalRooms;
  if (pct <= 0.33) return { header: "bg-amber-100 text-amber-700",  filled: "bg-amber-400"  };
  if (pct <= 0.66) return { header: "bg-orange-100 text-orange-700", filled: "bg-orange-500" };
  return              { header: "bg-red-100 text-red-700",    filled: "bg-red-500"   };
}

// Parking row label: "P153", "P152"
function parkingRowLabel(space: string): string {
  return `P${space}`;
}

// Format room string for tooltip: "K.203" → "K203", "K.202 + K.203" → "K202+K203"
function formatRoomForTooltip(room: string): string {
  return room.replace(/\./g, '').replace(/\s+/g, '');
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function OccupancyCalendar({ reservations }: Props) {
  const todayStr = getTodayStr();
  const [startOffset, setStartOffset] = useState(0);
  const [showParking, setShowParking] = useState(false);
  // Per-category collapse state — both expanded on first load. Operator can
  // hide a whole category to free vertical space; the overall day-header
  // occupancy counters keep summing across all categories regardless.
  const [collapsed, setCollapsed] = useState<Record<RoomCategory, boolean>>({
    Urban:  false,
    Deluxe: false,
  });

  const days = useMemo(() => get30DaysFrom(todayStr, startOffset), [todayStr, startOffset]);
  const parkingResult = useMemo(() => computeParking(reservations), [reservations]);
  const categoryGroups = useMemo(() => groupRoomsByCategory(), []);

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 mb-6">
      {/* Header — wraps to a second row on narrow viewports so the legend +
          nav + parking pill never push past the calendar's right edge. */}
      <div className="flex flex-wrap items-center justify-between gap-y-2 mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-sm font-semibold text-gray-700">Availability</p>
          <span className="text-xs text-gray-400 truncate">{formatDateRange(days)}</span>
        </div>

        <div className="flex items-center gap-3 flex-wrap justify-end">
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
              showParking
                ? "bg-indigo-100 text-indigo-700 hover:bg-indigo-200"
                : "bg-gray-100 text-gray-500 hover:bg-gray-200"
            }`}
          >
            <span className="flex items-center gap-1">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8" />
              </svg>
              Parking
            </span>
          </button>

          {/* Legend — labels collapse to swatches-only on mobile to keep the
              header from outgrowing the viewport. Tooltip still shows the
              label on long-press / hover. */}
          <div className="flex items-center gap-2 sm:gap-4 text-xs text-gray-500">
            {[
              { label: "Free",    color: "bg-emerald-400" },
              { label: "Low",     color: "bg-amber-400"   },
              { label: "High",    color: "bg-orange-500"  },
              { label: "Full",    color: "bg-red-500"     },
            ].map(({ label, color }) => (
              <span key={label} className="flex items-center gap-1.5" title={label}>
                <span className={`inline-block w-3 h-3 rounded-sm ${color}`} />
                <span className="hidden sm:inline">{label}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Grid — scrollable on small screens */}
      <div className="overflow-x-auto">
        <table className="border-collapse w-full">
          <thead>
            <tr>
              {/* Empty cell above room labels */}
              <th className="w-14" />

              {days.map((date) => {
                const d = new Date(date + "T00:00:00");
                const dayNum = d.getDate();
                const isToday = date === todayStr;
                const showMonth = dayNum === 1 || date === days[0];
                const bookedCount = ROOMS.filter((r) => isRoomBooked(reservations, r, date)).length;
                const { header } = getOccupancyStyle(bookedCount, ROOMS.length);

                const dayAbbr = d.toLocaleString("en-GB", { weekday: "short" }).slice(0, 2);

                return (
                  <th key={date} className="px-px pb-1 min-w-[2rem]">
                    <div
                      className={`rounded-sm px-0.5 py-0.5 ${header} ${isToday ? "ring-2 ring-indigo-400 ring-inset" : ""}`}
                      title={
                        bookedCount === 0
                          ? "All rooms free"
                          : `${bookedCount} / ${ROOMS.length} rooms booked`
                      }
                    >
                      <div className={`text-center text-xs font-bold leading-none ${isToday ? "underline" : ""}`}>
                        {dayNum}
                      </div>
                      <div className="text-center text-[9px] leading-tight opacity-70">
                        {dayAbbr}
                      </div>
                      <div className="text-center text-[9px] leading-tight opacity-70 h-3">
                        {showMonth ? d.toLocaleString("en-GB", { month: "short" }) : ""}
                      </div>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>

          {/* One <tbody> per category — Urban first (more turnover) then Deluxe.
              Each group leads with a clickable header row that toggles collapse.
              When collapsed only the header is rendered; the day-cell rows are
              hidden but their occupancy still feeds the overall counters at top. */}
          {categoryGroups.map((group) => {
            const style = CATEGORY_STYLES[group.category];
            const isCollapsed = collapsed[group.category];
            const groupRooms = group.rooms;
            return (
              <tbody key={group.category}>
                {/* Category header row — spans all columns */}
                <tr>
                  <td
                    colSpan={days.length + 1}
                    className={`p-0 ${style.headerBorder} border-t border-b`}
                  >
                    <button
                      onClick={() => setCollapsed((c) => ({ ...c, [group.category]: !c[group.category] }))}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 ${style.headerBg} ${style.headerText} hover:brightness-95 transition`}
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
                  </td>
                </tr>

                {/* Day-cell rows — hidden when category collapsed */}
                {!isCollapsed && groupRooms.map((room) => (
                  <tr key={room}>
                    {/* Room label */}
                    <td className="pr-2 py-0.5 text-xs font-medium text-gray-500 text-right whitespace-nowrap">
                      {room}
                    </td>

                    {/* Day cells */}
                    {days.map((date) => {
                      const booked = isRoomBooked(reservations, room, date);
                      const isToday = date === todayStr;
                      const bookedCount = ROOMS.filter((r) => isRoomBooked(reservations, r, date)).length;
                      const { filled } = getOccupancyStyle(bookedCount, ROOMS.length);
                      const guest = booked ? getGuest(reservations, room, date) : null;

                      return (
                        <td
                          key={date}
                          className={`px-px py-0.5 ${isToday ? "ring-1 ring-indigo-300 ring-inset" : ""}`}
                        >
                          <div
                            className={`h-5 rounded-sm flex items-center justify-center ${booked ? filled : "bg-gray-100"}`}
                            title={booked ? `${room} — ${guest?.name ?? "booked"}` : `${room} — free`}
                          >
                            {guest?.initials && (
                              <span className="text-[9px] font-bold text-white leading-none select-none">
                                {guest.initials}
                              </span>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            );
          })}

          {/* Parking rows — same table so columns align */}
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
                        <td
                          key={date}
                          className={`px-px py-0.5 ${isToday ? "ring-1 ring-indigo-300 ring-inset" : ""} ${psIdx === 0 ? "pt-2 border-t border-gray-200" : ""}`}
                        >
                          <div
                            className={`h-5 rounded-sm flex items-center justify-center ${
                              occupied ? "bg-red-400" : "bg-emerald-200"
                            }`}
                            title={
                              occupied
                                ? `P${ps.space}-${cell!.initials}${roomStr ? `-${roomStr}` : ''}`
                                : `P${ps.space} — free`
                            }
                          >
                            {occupied && (
                              <span className="text-[9px] font-bold text-white leading-none select-none">
                                {cell!.initials}
                              </span>
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

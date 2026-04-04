'use client';
import type { Reservation, Room } from "@/types/reservation";

interface Props {
  reservations: Reservation[];
}

const ROOMS: Room[] = ["K.201", "K.202", "K.203"];

// ─── Date helpers ─────────────────────────────────────────────────────────────

function getTodayStr(): string {
  return new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD, local time
}

function getNext30Days(todayStr: string): string[] {
  const days: string[] = [];
  const start = new Date(todayStr + "T00:00:00");
  for (let i = 0; i < 30; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
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
// Scales automatically with any room count.
function getOccupancyStyle(bookedCount: number, totalRooms: number) {
  if (bookedCount === 0) {
    return { header: "bg-emerald-100 text-emerald-700", filled: "bg-emerald-400" };
  }
  const pct = bookedCount / totalRooms;
  if (pct <= 0.33) return { header: "bg-amber-100 text-amber-700",  filled: "bg-amber-400"  };
  if (pct <= 0.66) return { header: "bg-orange-100 text-orange-700", filled: "bg-orange-500" };
  return              { header: "bg-red-100 text-red-700",    filled: "bg-red-500"   };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function OccupancyCalendar({ reservations }: Props) {
  const todayStr = getTodayStr();
  const days = getNext30Days(todayStr);

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 mb-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm font-semibold text-gray-700">Availability — Next 30 Days</p>
        <div className="flex items-center gap-4 text-xs text-gray-500">
          {[
            { label: "Free",    color: "bg-emerald-400" },
            { label: "Low",     color: "bg-amber-400"   },
            { label: "High",    color: "bg-orange-500"  },
            { label: "Full",    color: "bg-red-500"     },
          ].map(({ label, color }) => (
            <span key={label} className="flex items-center gap-1.5">
              <span className={`inline-block w-3 h-3 rounded-sm ${color}`} />
              {label}
            </span>
          ))}
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
                      <div className="text-center text-[9px] leading-tight opacity-70 h-3">
                        {showMonth ? d.toLocaleString("en-GB", { month: "short" }) : ""}
                      </div>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {ROOMS.map((room, roomIdx) => (
              <tr key={room}>
                {/* Room label */}
                <td className={`pr-2 py-0.5 text-xs font-medium text-gray-500 text-right whitespace-nowrap ${roomIdx === 0 ? "pt-1" : ""}`}>
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
        </table>
      </div>
    </div>
  );
}

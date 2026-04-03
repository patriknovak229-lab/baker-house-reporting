'use client';
import type { Reservation, Room } from "@/types/reservation";

interface Props {
  reservations: Reservation[];
}

const ROOMS: Room[] = ["K.201", "K.202", "K.203"];
const DAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

// ISO date string YYYY-MM-DD without timezone shift
function toDateStr(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

// Monday-based day index (0=Mon … 6=Sun)
function getFirstDayIndex(year: number, month: number): number {
  const jsDay = new Date(year, month, 1).getDay(); // 0=Sun
  return (jsDay + 6) % 7;
}

function getRoomsBookedOnDate(reservations: Reservation[], date: string): Room[] {
  return ROOMS.filter((room) =>
    reservations.some(
      (r) =>
        r.room === room &&
        r.paymentStatus !== "Refunded" &&
        r.checkInDate <= date &&
        r.checkOutDate > date
    )
  );
}

// Colour palette per occupancy count
const PALETTE = [
  // 0 booked — green
  { bar: "bg-emerald-400", empty: "bg-emerald-100", header: "text-emerald-700" },
  // 1 booked — amber
  { bar: "bg-amber-400",   empty: "bg-amber-100",   header: "text-amber-700"  },
  // 2 booked — orange
  { bar: "bg-orange-500",  empty: "bg-orange-100",  header: "text-orange-700" },
  // 3 booked — red
  { bar: "bg-red-500",     empty: "bg-red-100",     header: "text-red-700"    },
];

interface CalendarMonthProps {
  year: number;
  month: number;       // 0-based
  reservations: Reservation[];
  isToday: (date: string) => boolean;
}

function CalendarMonth({ year, month, reservations, isToday }: CalendarMonthProps) {
  const daysInMonth = getDaysInMonth(year, month);
  const firstDayIdx = getFirstDayIndex(year, month);

  const monthLabel = new Date(year, month, 1).toLocaleString("en-GB", {
    month: "long",
    year: "numeric",
  });

  // Build cells: null = empty leading cell
  const cells: (number | null)[] = [
    ...Array(firstDayIdx).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  return (
    <div className="flex-1 min-w-0">
      <p className="text-sm font-semibold text-gray-700 mb-3 text-center">{monthLabel}</p>

      {/* Day-of-week headers */}
      <div className="grid grid-cols-7 mb-1">
        {DAY_LABELS.map((d) => (
          <div key={d} className="text-center text-xs font-medium text-gray-400 pb-1">
            {d}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((day, idx) => {
          if (day === null) return <div key={`empty-${idx}`} />;

          const date = toDateStr(year, month, day);
          const bookedRooms = getRoomsBookedOnDate(reservations, date);
          const count = bookedRooms.length;
          const palette = PALETTE[count];
          const today = isToday(date);

          return (
            <div
              key={date}
              className={`rounded flex flex-col overflow-hidden ${today ? "ring-2 ring-indigo-400 ring-offset-1" : ""}`}
              title={
                count === 0
                  ? "All rooms available"
                  : `Booked: ${bookedRooms.join(", ")}`
              }
            >
              {/* Day number */}
              <div className={`text-center text-xs py-0.5 font-medium leading-none ${palette.header} ${today ? "font-bold" : ""}`}>
                {day}
              </div>
              {/* 3 room strips */}
              <div className="flex flex-col gap-px pb-0.5 mx-auto w-[40%]">
                {ROOMS.map((room) => {
                  const booked = bookedRooms.includes(room);
                  return (
                    <div
                      key={room}
                      className={`h-1.5 rounded-sm ${booked ? palette.bar : palette.empty}`}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function OccupancyCalendar({ reservations }: Props) {
  const now = new Date();
  const curYear  = now.getFullYear();
  const curMonth = now.getMonth();
  const nextYear  = curMonth === 11 ? curYear + 1 : curYear;
  const nextMonth = (curMonth + 1) % 12;

  const todayStr = now.toLocaleDateString("sv-SE"); // YYYY-MM-DD in local time

  const isToday = (date: string) => date === todayStr;

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 mb-6">
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm font-semibold text-gray-700">Availability Overview</p>
        {/* Legend */}
        <div className="flex items-center gap-4 text-xs text-gray-500">
          {[
            { label: "Free", color: "bg-emerald-400" },
            { label: "1 booked", color: "bg-amber-400" },
            { label: "2 booked", color: "bg-orange-500" },
            { label: "Full", color: "bg-red-500" },
          ].map(({ label, color }) => (
            <span key={label} className="flex items-center gap-1.5">
              <span className={`inline-block w-3 h-3 rounded-sm ${color}`} />
              {label}
            </span>
          ))}
        </div>
      </div>

      <div className="flex gap-8">
        <CalendarMonth
          year={curYear}
          month={curMonth}
          reservations={reservations}
          isToday={isToday}
        />
        <div className="w-px bg-gray-100 shrink-0" />
        <CalendarMonth
          year={nextYear}
          month={nextMonth}
          reservations={reservations}
          isToday={isToday}
        />
      </div>
    </div>
  );
}

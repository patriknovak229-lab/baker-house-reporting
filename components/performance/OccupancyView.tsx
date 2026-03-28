'use client';
import { daysBetween } from "@/utils/periodUtils";
import type { DateRange } from "@/utils/periodUtils";
import type { Reservation, Room } from "@/types/reservation";

interface Props {
  reservations: Reservation[];
  dateRange: DateRange;
  selectedRooms: Room[];
}

function pct(sold: number, available: number) {
  if (available === 0) return 0;
  return Math.round((sold / available) * 100);
}

function OccupancyBar({ value }: { value: number }) {
  return (
    <div className="w-full bg-gray-100 rounded-full h-2.5 mt-1">
      <div
        className="h-2.5 rounded-full bg-indigo-500 transition-all duration-500"
        style={{ width: `${Math.min(value, 100)}%` }}
      />
    </div>
  );
}

export default function OccupancyView({ reservations, dateRange, selectedRooms }: Props) {
  const daysInPeriod = daysBetween(dateRange.start, dateRange.end);
  const availableTotal = selectedRooms.length * daysInPeriod;
  const soldTotal = reservations.reduce((sum, r) => sum + r.numberOfNights, 0);
  const occupancyPct = pct(soldTotal, availableTotal);

  const perRoom = selectedRooms.map((room) => {
    const roomReservations = reservations.filter((r) => r.room === room);
    const soldNights = roomReservations.reduce((sum, r) => sum + r.numberOfNights, 0);
    return { room, soldNights, available: daysInPeriod, pct: pct(soldNights, daysInPeriod) };
  });

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
      <h2 className="text-base font-semibold text-gray-800 mb-5">Occupancy</h2>

      {selectedRooms.length === 0 ? (
        <p className="text-sm text-gray-400">No rooms selected.</p>
      ) : (
        <>
          {/* Overall summary */}
          <div className="mb-6">
            <div className="flex items-baseline gap-3">
              <span className="text-4xl font-bold text-indigo-600">{occupancyPct}%</span>
              <span className="text-sm text-gray-500">
                {soldTotal} nights sold / {availableTotal} available
              </span>
            </div>
            <OccupancyBar value={occupancyPct} />
            <p className="text-xs text-gray-400 mt-1">
              {daysInPeriod} days · {selectedRooms.length} room{selectedRooms.length > 1 ? "s" : ""}
            </p>
          </div>

          {/* Per-room breakdown */}
          {selectedRooms.length > 1 && (
            <div className="border-t border-gray-100 pt-4">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">
                Per Room
              </p>
              <div className="space-y-4">
                {perRoom.map(({ room, soldNights, available, pct: roomPct }) => (
                  <div key={room}>
                    <div className="flex justify-between items-baseline mb-1">
                      <span className="text-sm font-medium text-gray-700">{room}</span>
                      <span className="text-sm text-gray-500">
                        <span className="font-semibold text-gray-800">{roomPct}%</span>
                        {" "}· {soldNights} / {available} nights
                      </span>
                    </div>
                    <OccupancyBar value={roomPct} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

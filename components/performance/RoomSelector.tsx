'use client';
import { ALL_ROOMS } from "@/data/performanceMockData";
import type { Room } from "@/types/reservation";

interface Props {
  selected: Room[];
  onChange: (rooms: Room[]) => void;
}

export default function RoomSelector({ selected, onChange }: Props) {
  const allSelected = selected.length === ALL_ROOMS.length;

  function toggleAll() {
    onChange(allSelected ? [] : [...ALL_ROOMS]);
  }

  function toggleRoom(room: Room) {
    if (selected.includes(room)) {
      onChange(selected.filter((r) => r !== room));
    } else {
      onChange([...selected, room]);
    }
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        onClick={toggleAll}
        className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors ${
          allSelected
            ? "bg-indigo-600 text-white shadow-sm"
            : "bg-gray-100 text-gray-600 hover:bg-gray-200"
        }`}
      >
        All Rooms
      </button>
      {ALL_ROOMS.map((room) => (
        <button
          key={room}
          onClick={() => toggleRoom(room)}
          className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors ${
            selected.includes(room)
              ? "bg-indigo-100 text-indigo-700 border border-indigo-200"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          {room}
        </button>
      ))}
    </div>
  );
}

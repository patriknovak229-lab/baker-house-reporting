'use client';
import { ALL_ROOMS } from "@/data/performanceMockData";
import { groupRoomsByCategory } from "@/utils/roomCategory";
import type { Room } from "@/types/reservation";

interface Props {
  selected: Room[];
  onChange: (rooms: Room[]) => void;
}

export default function RoomSelector({ selected, onChange }: Props) {
  const allSelected = selected.length === ALL_ROOMS.length;
  const groups = groupRoomsByCategory();

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

  function toggleCategory(rooms: readonly string[]) {
    // If every room in the category is currently selected, deselect them all;
    // otherwise add the missing ones (don't disturb other categories).
    const allInCategorySelected = rooms.every((r) => selected.includes(r as Room));
    if (allInCategorySelected) {
      onChange(selected.filter((r) => !rooms.includes(r)));
    } else {
      const merged = new Set<Room>(selected);
      for (const r of rooms) merged.add(r as Room);
      onChange([...merged]);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <button
          onClick={toggleAll}
          className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors ${
            allSelected
              ? 'bg-indigo-600 text-white shadow-sm'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          All Rooms
        </button>
      </div>

      {groups.map((group) => {
        const allInCategorySelected = group.rooms.every((r) => selected.includes(r as Room));
        const categoryLabelClass =
          group.category === 'Urban' ? 'text-cyan-700' : 'text-amber-700';
        return (
          <div key={group.category} className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => toggleCategory(group.rooms)}
              className={`px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded ${categoryLabelClass} hover:bg-gray-50 transition-colors`}
              title={
                allInCategorySelected
                  ? `Deselect all ${group.category} rooms`
                  : `Select all ${group.category} rooms`
              }
            >
              {group.category}
              {allInCategorySelected && ' ✓'}
            </button>
            {group.rooms.map((roomStr) => {
              const room = roomStr as Room;
              return (
                <button
                  key={room}
                  onClick={() => toggleRoom(room)}
                  className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors ${
                    selected.includes(room)
                      ? 'bg-indigo-100 text-indigo-700 border border-indigo-200'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {room}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

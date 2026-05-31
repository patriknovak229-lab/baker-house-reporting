'use client';
import { useState } from 'react';

// Physical rooms only — Beds24 inventory overrides are set on physical
// inventory (the virtual rooms 648816 / 679714 are sellable abstractions,
// not actual blockable inventory).
const ROOM_OPTIONS = [
  { label: 'K.102', roomId: 679703, category: 'Urban' },
  { label: 'K.103', roomId: 679704, category: 'Urban' },
  { label: 'K.106', roomId: 679705, category: 'Urban' },
  { label: 'K.201', roomId: 656437, category: 'Deluxe' },
  { label: 'K.202', roomId: 648596, category: 'Deluxe' },
  { label: 'K.203', roomId: 648772, category: 'Deluxe' },
  { label: 'O.308', roomId: 674672, category: 'Deluxe' },
] as const;

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

interface FormState {
  // Multi-select — operators frequently blackout several rooms at once
  // (e.g. "close everything for renovation week"), and Beds24's calendar
  // endpoint accepts a multi-room payload in a single POST.
  roomIds: number[];
  arrival: string;
  departure: string;
  notes: string;
}

const DEFAULT_FORM: FormState = {
  roomIds: [],
  arrival: '',
  departure: '',
  notes: '',
};

const inputCls =
  'w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rose-300';

export default function BlackoutModal({ onClose, onCreated }: Props) {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function toggleRoom(roomId: number) {
    setForm((f) => ({
      ...f,
      roomIds: f.roomIds.includes(roomId)
        ? f.roomIds.filter((id) => id !== roomId)
        : [...f.roomIds, roomId],
    }));
  }

  function selectAll() {
    setForm((f) => ({ ...f, roomIds: ROOM_OPTIONS.map((r) => r.roomId) }));
  }

  function clearAll() {
    setForm((f) => ({ ...f, roomIds: [] }));
  }

  async function handleSubmit() {
    if (form.roomIds.length === 0) {
      setError('Pick at least one room to black out.');
      return;
    }
    if (!form.arrival || !form.departure) {
      setError('Pick both an arrival and a departure date.');
      return;
    }
    if (form.departure <= form.arrival) {
      setError('Departure must be after arrival.');
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/bookings/blackout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomIds: form.roomIds,
          arrival: form.arrival,
          departure: form.departure,
          notes: form.notes,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to create blackout');
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create blackout');
    } finally {
      setSubmitting(false);
    }
  }

  // Group rooms by building so the checkbox grid mirrors the calendar layout
  const urbanRooms = ROOM_OPTIONS.filter((r) => r.category === 'Urban');
  const deluxeRooms = ROOM_OPTIONS.filter((r) => r.category === 'Deluxe');

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Black Out Rooms</h2>
            <p className="text-[11px] text-gray-500 mt-0.5">
              Inventory override — same as Beds24&apos;s &ldquo;Blackout&rdquo; option in the calendar.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {/* Rooms */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-medium text-gray-600">
                Rooms * <span className="text-gray-400 font-normal">({form.roomIds.length} selected)</span>
              </label>
              <div className="flex items-center gap-2 text-[11px]">
                <button
                  type="button"
                  onClick={selectAll}
                  className="text-indigo-600 hover:text-indigo-800"
                >
                  All
                </button>
                <span className="text-gray-300">|</span>
                <button
                  type="button"
                  onClick={clearAll}
                  className="text-gray-500 hover:text-gray-700"
                >
                  Clear
                </button>
              </div>
            </div>

            {[
              { label: 'Urban', rooms: urbanRooms },
              { label: 'Deluxe', rooms: deluxeRooms },
            ].map(({ label, rooms }) => (
              <div key={label} className="mb-2 last:mb-0">
                <p className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">{label}</p>
                <div className="grid grid-cols-4 gap-1.5">
                  {rooms.map((r) => {
                    const selected = form.roomIds.includes(r.roomId);
                    return (
                      <button
                        key={r.roomId}
                        type="button"
                        onClick={() => toggleRoom(r.roomId)}
                        className={`px-2 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                          selected
                            ? 'bg-rose-600 border-rose-600 text-white'
                            : 'bg-white border-gray-200 text-gray-700 hover:border-rose-300 hover:bg-rose-50'
                        }`}
                      >
                        {r.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">From *</label>
              <input
                type="date"
                value={form.arrival}
                onChange={(e) => update('arrival', e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">To *</label>
              <input
                type="date"
                value={form.departure}
                onChange={(e) => update('departure', e.target.value)}
                className={inputCls}
              />
            </div>
          </div>

          {/* Reason */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Reason <span className="text-gray-400 font-normal">(optional, local-only)</span>
            </label>
            <input
              type="text"
              value={form.notes}
              onChange={(e) => update('notes', e.target.value)}
              placeholder="e.g. Renovation, Owner stay, Maintenance"
              className={inputCls}
            />
            <p className="text-[10px] text-gray-400 mt-1">
              Beds24 calendar overrides don&apos;t carry comments — the reason is just a note for you.
            </p>
          </div>

          {error && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={submitting}
              className="flex-1 py-2.5 border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-40 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="flex-1 py-2.5 bg-rose-600 text-white text-sm font-medium rounded-lg hover:bg-rose-700 disabled:opacity-40 transition-colors"
            >
              {submitting
                ? 'Creating…'
                : form.roomIds.length > 1
                ? `Black Out ${form.roomIds.length} rooms`
                : 'Black Out'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

'use client';
import { useState } from 'react';
import { RESTRICTION_LABEL, eachDay, unitForRoomId, type RestrictionKind } from '@/utils/stayRestrictions';

// Same chips as BlackoutModal. The difference is where the change lands: a
// restriction goes on the room each unit is SOLD as, so picking one Urban or
// Deluxe 1KK studio picks its whole type (see utils/stayRestrictions.ts).
const ROOM_OPTIONS = [
  { label: 'K.102', roomId: 679703, category: 'Urban' },
  { label: 'K.103', roomId: 679704, category: 'Urban' },
  { label: 'K.106', roomId: 679705, category: 'Urban' },
  { label: 'K.201', roomId: 656437, category: 'Deluxe' },
  { label: 'K.202', roomId: 648596, category: 'Deluxe' },
  { label: 'K.203', roomId: 648772, category: 'Deluxe' },
  { label: 'O.308', roomId: 674672, category: 'Deluxe' },
] as const;

const KIND_OPTIONS: { kind: RestrictionKind; label: string; hint: string }[] = [
  {
    kind: 'noCheckIn',
    label: 'Check-in',
    hint: 'Guests can’t arrive on these days. Stays passing through are fine.',
  },
  {
    kind: 'noCheckOut',
    label: 'Check-out',
    hint: 'Guests can’t leave on these days, so there’s nothing to clean. Stays passing through are fine.',
  },
  {
    kind: 'noCheckInOrCheckOut',
    label: 'Both',
    hint: 'No arrivals and no departures on these days. Stays passing through are fine.',
  },
];

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

interface FormState {
  roomIds: number[];
  kind: RestrictionKind;
  from: string;
  to: string;
  notes: string;
}

const DEFAULT_FORM: FormState = {
  roomIds: [],
  kind: 'noCheckOut',
  from: '',
  to: '',
  notes: '',
};

const inputCls =
  'w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300';

const KIND_VERB: Record<RestrictionKind, string> = {
  noCheckIn: 'check-ins',
  noCheckOut: 'check-outs',
  noCheckInOrCheckOut: 'check-ins and check-outs',
};

function dayLabel(ymd: string): string {
  return new Date(ymd + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/**
 * The days in words, before saving. Black Out's "To" is the departure morning,
 * so an operator used to it enters the NEXT day here and blocks two days; this
 * sentence is what makes that visible.
 */
function daysSummary(kind: RestrictionKind, from: string, to: string): string | null {
  if (!from || !to || to < from) return null;
  const count = eachDay(from, to).length;
  const span = count === 1 ? dayLabel(from) : `${count} days, ${dayLabel(from)} – ${dayLabel(to)}`;
  return `Blocks ${KIND_VERB[kind]} on ${span}.`;
}

/** Every chip in the same sold unit as `roomId` (the whole type for the studios). */
function unitChipIds(roomId: number): number[] {
  const unit = unitForRoomId(roomId);
  if (!unit) return [roomId];
  const ids = new Set(unit.units.map((u) => u.roomId));
  return ROOM_OPTIONS.filter((r) => ids.has(r.roomId)).map((r) => r.roomId);
}

export default function StayRestrictionModal({ onClose, onCreated }: Props) {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function toggleRoom(roomId: number) {
    const group = unitChipIds(roomId);
    setForm((f) => {
      const selected = f.roomIds.includes(roomId);
      return {
        ...f,
        roomIds: selected
          ? f.roomIds.filter((id) => !group.includes(id))
          : [...new Set([...f.roomIds, ...group])],
      };
    });
  }

  function selectAll() {
    setForm((f) => ({ ...f, roomIds: ROOM_OPTIONS.map((r) => r.roomId) }));
  }

  function clearAll() {
    setForm((f) => ({ ...f, roomIds: [] }));
  }

  async function handleSubmit() {
    if (form.roomIds.length === 0) {
      setError('Pick at least one room.');
      return;
    }
    if (!form.from || !form.to) {
      setError('Pick the first and the last day.');
      return;
    }
    if (form.to < form.from) {
      setError('The last day must be on or after the first day.');
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/bookings/restrictions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomIds: form.roomIds,
          kind: form.kind,
          from: form.from,
          to: form.to,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to set restriction');
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to set restriction');
    } finally {
      setSubmitting(false);
    }
  }

  const urbanRooms = ROOM_OPTIONS.filter((r) => r.category === 'Urban');
  const deluxeRooms = ROOM_OPTIONS.filter((r) => r.category === 'Deluxe');
  const kindHint = KIND_OPTIONS.find((o) => o.kind === form.kind)?.hint;
  const summary = daysSummary(form.kind, form.from, form.to);

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
            <h2 className="text-base font-semibold text-gray-900">No Check-in / Check-out</h2>
            <p className="text-[11px] text-gray-500 mt-0.5">
              Inventory override: same as Beds24&apos;s &ldquo;No check in / No check out&rdquo; options in the calendar.
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
                            ? 'bg-amber-500 border-amber-500 text-white'
                            : 'bg-white border-gray-200 text-gray-700 hover:border-amber-300 hover:bg-amber-50'
                        }`}
                      >
                        {r.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <p className="text-[10px] text-gray-400 mt-1">
              Urban studios (K.102/103/106) and Deluxe 1KK (K.202/203) are sold as one room type on
              Booking.com, Airbnb and the website, so they&apos;re restricted together.
            </p>
          </div>

          {/* Restriction */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Block *</label>
            <div className="grid grid-cols-3 gap-1.5">
              {KIND_OPTIONS.map((o) => {
                const selected = form.kind === o.kind;
                return (
                  <button
                    key={o.kind}
                    type="button"
                    onClick={() => update('kind', o.kind)}
                    title={RESTRICTION_LABEL[o.kind]}
                    className={`px-2 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                      selected
                        ? 'bg-amber-500 border-amber-500 text-white'
                        : 'bg-white border-gray-200 text-gray-700 hover:border-amber-300 hover:bg-amber-50'
                    }`}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
            {kindHint && <p className="text-[10px] text-gray-400 mt-1">{kindHint}</p>}
          </div>

          {/* Days */}
          <div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">First day *</label>
                <input
                  type="date"
                  value={form.from}
                  onChange={(e) => {
                    const from = e.target.value;
                    // Most restrictions are one day: default "To" to the same day.
                    setForm((f) => ({ ...f, from, to: !f.to || f.to < from ? from : f.to }));
                  }}
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Last day * <span className="text-gray-400 font-normal">(included)</span>
                </label>
                <input
                  type="date"
                  value={form.to}
                  min={form.from || undefined}
                  onChange={(e) => update('to', e.target.value)}
                  className={inputCls}
                />
              </div>
            </div>
            {summary ? (
              <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">
                {summary}{' '}
                <span className="text-amber-700/80">Existing bookings aren&apos;t affected.</span>
              </p>
            ) : (
              <p className="text-[10px] text-gray-400 mt-1">
                One day? Leave the last day the same as the first. Unlike Black Out, the last day is blocked too.
              </p>
            )}
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
              placeholder="e.g. Cleaners off, Christmas"
              className={inputCls}
            />
            <p className="text-[10px] text-gray-400 mt-1">
              Beds24 calendar overrides don&apos;t carry comments, so the reason is just a note for you.
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
              className="flex-1 py-2.5 bg-amber-500 text-white text-sm font-medium rounded-lg hover:bg-amber-600 disabled:opacity-40 transition-colors"
            >
              {submitting
                ? 'Saving…'
                : form.roomIds.length > 1
                ? `Restrict ${form.roomIds.length} rooms`
                : 'Restrict'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

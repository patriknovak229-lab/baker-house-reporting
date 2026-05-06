'use client';
import { useState } from 'react';

const ROOM_OPTIONS = [
  { label: 'K.201', roomId: 656437 },
  { label: 'K.202', roomId: 648596 },
  { label: 'K.203', roomId: 648772 },
  { label: 'O.308', roomId: 674672 },
];

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

interface FormState {
  roomId: number;
  arrival: string;
  departure: string;
  notes: string;
}

const DEFAULT_FORM: FormState = {
  roomId: 648596,
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

  async function handleSubmit() {
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
        body: JSON.stringify(form),
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
            <h2 className="text-base font-semibold text-gray-900">Black Out Room</h2>
            <p className="text-[11px] text-gray-500 mt-0.5">
              Closes the room for the date range — channel managers will not sell it.
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
          {/* Room */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Room *</label>
            <select
              value={form.roomId}
              onChange={(e) => update('roomId', Number(e.target.value))}
              className={inputCls}
            >
              {ROOM_OPTIONS.map((r) => (
                <option key={r.roomId} value={r.roomId}>
                  {r.label}
                </option>
              ))}
            </select>
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
              Reason <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={form.notes}
              onChange={(e) => update('notes', e.target.value)}
              placeholder="e.g. Renovation, Owner stay, Maintenance"
              className={inputCls}
            />
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
              {submitting ? 'Creating…' : 'Black Out'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

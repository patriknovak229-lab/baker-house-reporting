'use client';
import { useState } from "react";

const ROOM_OPTIONS = [
  { label: "K.201", roomId: 656437 },
  { label: "K.202", roomId: 648596 },
  { label: "K.203", roomId: 648772 },
];

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

interface FormState {
  roomId: number;
  arrival: string;
  departure: string;
  numAdult: number;
  numChild: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  price: string;
  notes: string;
}

const DEFAULT_FORM: FormState = {
  roomId: 648596,
  arrival: "",
  departure: "",
  numAdult: 1,
  numChild: 0,
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  price: "",
  notes: "",
};

function Field({ label, optional, children }: { label: string; optional?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">
        {label}{" "}
        {optional && <span className="text-gray-400 font-normal">(optional)</span>}
      </label>
      {children}
    </div>
  );
}

const inputCls = "w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300";

export default function CreateBookingModal({ onClose, onCreated }: Props) {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (form.departure && form.arrival && form.departure <= form.arrival) {
      setError("Check-out must be after check-in");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, price: form.price ? parseFloat(form.price) : 0 }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to create booking");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-900">New Direct Booking</h2>
            <p className="text-xs text-gray-400 mt-0.5">Bypasses min-stay · Custom price</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">

          {/* Room + Dates */}
          <div className="grid grid-cols-3 gap-3">
            <Field label="Room">
              <select
                value={form.roomId}
                onChange={(e) => set("roomId", parseInt(e.target.value))}
                className={inputCls}
              >
                {ROOM_OPTIONS.map((r) => (
                  <option key={r.roomId} value={r.roomId}>{r.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Check-in">
              <input
                type="date"
                required
                value={form.arrival}
                onChange={(e) => set("arrival", e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label="Check-out">
              <input
                type="date"
                required
                value={form.departure}
                min={form.arrival || undefined}
                onChange={(e) => set("departure", e.target.value)}
                className={inputCls}
              />
            </Field>
          </div>

          {/* Guest name */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name">
              <input
                type="text"
                required
                value={form.firstName}
                onChange={(e) => set("firstName", e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label="Last name" optional>
              <input
                type="text"
                value={form.lastName}
                onChange={(e) => set("lastName", e.target.value)}
                className={inputCls}
              />
            </Field>
          </div>

          {/* Contact */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Email" optional>
              <input
                type="email"
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label="Phone" optional>
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => set("phone", e.target.value)}
                className={inputCls}
              />
            </Field>
          </div>

          {/* Guests + Price */}
          <div className="grid grid-cols-3 gap-3">
            <Field label="Adults">
              <input
                type="number"
                min={1}
                max={10}
                value={form.numAdult}
                onChange={(e) => set("numAdult", parseInt(e.target.value) || 1)}
                className={inputCls}
              />
            </Field>
            <Field label="Children">
              <input
                type="number"
                min={0}
                max={10}
                value={form.numChild}
                onChange={(e) => set("numChild", parseInt(e.target.value) || 0)}
                className={inputCls}
              />
            </Field>
            <Field label="Price (Kč)">
              <input
                type="number"
                min={0}
                required
                value={form.price}
                onChange={(e) => set("price", e.target.value)}
                placeholder="0"
                className={inputCls}
              />
            </Field>
          </div>

          {/* Notes */}
          <Field label="Notes" optional>
            <textarea
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              rows={2}
              className={`${inputCls} resize-none`}
            />
          </Field>

          {/* Error */}
          {error && (
            <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? "Creating…" : "Create Booking"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

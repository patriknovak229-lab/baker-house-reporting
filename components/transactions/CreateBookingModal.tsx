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

type Step = 'form' | 'link';

export default function CreateBookingModal({ onClose, onCreated }: Props) {
  const [form, setForm]                     = useState<FormState>(DEFAULT_FORM);
  const [submitting, setSubmitting]         = useState(false);
  const [error, setError]                   = useState<string | null>(null);
  const [includePaymentLink, setIncludePaymentLink] = useState(false);

  // Link step state
  const [step, setStep]         = useState<Step>('form');
  const [paymentUrl, setPaymentUrl] = useState('');
  const [copied, setCopied]         = useState(false);

  function set<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function handleCopy() {
    navigator.clipboard.writeText(paymentUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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

      if (includePaymentLink && form.price && parseFloat(form.price) > 0) {
        // Try to extract the new booking ID from Beds24 response
        const newBookingId = Array.isArray(json.data) ? json.data[0] : json.data?.id;
        const reservationNumber = newBookingId ? `BH-${newBookingId}` : undefined;
        const guestName = [form.firstName, form.lastName].filter(Boolean).join(' ');
        const description = reservationNumber
          ? `Baker House — reservation ${reservationNumber}`
          : `Baker House — ${guestName}`;

        const linkRes = await fetch('/api/stripe/payment-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amountCzk:         parseFloat(form.price),
            description,
            guestEmail:        form.email  || undefined,
            guestPhone:        form.phone  || undefined,
            reservationNumber: reservationNumber,
          }),
        });
        const linkData = await linkRes.json();
        if (!linkRes.ok) throw new Error(linkData.error ?? 'Booking created but failed to generate payment link');

        setPaymentUrl(linkData.url);
        setStep('link');
      } else {
        onCreated();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Link step ──────────────────────────────────────────────────────────────
  if (step === 'link') {
    const guestName = [form.firstName, form.lastName].filter(Boolean).join(' ');
    const amountNum = parseFloat(form.price);
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
            <h2 className="text-base font-semibold text-gray-900">Booking Created · Payment Link</h2>
            <button onClick={() => { onCreated(); }} className="text-gray-400 hover:text-gray-600 transition-colors">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="px-6 py-5 space-y-4">
            {/* Success notice */}
            <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Booking created for {guestName || 'guest'}
            </div>

            {/* Summary */}
            <div className="bg-gray-50 rounded-xl px-4 py-3 space-y-1">
              <p className="text-sm font-medium text-gray-900">
                Baker House — {form.arrival} to {form.departure}
              </p>
              <p className="text-xl font-bold text-indigo-700">
                {amountNum.toLocaleString('cs-CZ')} Kč
              </p>
            </div>

            {/* URL box */}
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={paymentUrl}
                className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-xs text-gray-500 bg-gray-50 truncate"
              />
              <button
                onClick={handleCopy}
                className={`px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                  copied ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>

            {/* WhatsApp shortcut if phone is available */}
            {form.phone && (
              <button
                onClick={() => {
                  const guestName2 = [form.firstName, form.lastName].filter(Boolean).join(' ');
                  const text = encodeURIComponent(
                    `Hi ${guestName2 || 'there'}, here is your payment link for your Baker House stay: ${paymentUrl}`
                  );
                  const num = form.phone.replace(/\D/g, '');
                  window.open(`https://wa.me/${num}?text=${text}`, '_blank');
                }}
                className="w-full flex items-center justify-center gap-1.5 py-2 border border-green-200 text-green-700 text-xs font-medium rounded-lg hover:bg-green-50 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                  <path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.554 4.116 1.527 5.845L0 24l6.333-1.505A11.955 11.955 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.885 0-3.647-.494-5.17-1.358l-.37-.216-3.758.893.939-3.65-.24-.384A9.96 9.96 0 012 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/>
                </svg>
                Send via WhatsApp
              </button>
            )}

            <button
              onClick={() => { onCreated(); }}
              className="w-full py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Form step ──────────────────────────────────────────────────────────────
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

          {/* Payment link toggle */}
          <button
            type="button"
            onClick={() => setIncludePaymentLink((v) => !v)}
            className="flex items-center gap-2 text-xs font-medium text-gray-600 hover:text-gray-900"
          >
            <span
              className={`relative inline-flex h-4 w-7 flex-shrink-0 rounded-full border-2 border-transparent transition-colors ${
                includePaymentLink ? 'bg-indigo-600' : 'bg-gray-200'
              }`}
            >
              <span
                className={`inline-block h-3 w-3 rounded-full bg-white shadow transform transition-transform ${
                  includePaymentLink ? 'translate-x-3' : 'translate-x-0'
                }`}
              />
            </span>
            Send payment link after booking
          </button>

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
              {submitting
                ? (includePaymentLink ? "Creating…" : "Creating…")
                : (includePaymentLink ? "Create & Get Link" : "Create Booking")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

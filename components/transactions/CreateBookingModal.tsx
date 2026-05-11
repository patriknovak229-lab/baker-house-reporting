'use client';
import { useEffect, useState } from "react";

// Operator-facing manual bookings target SELLING UNITS only — Beds24 handles
// physical-unit allocation underneath. Physical room IDs (K.102, K.201, …)
// are intentionally NOT in this dropdown; they're inferred from Beds24's
// sub-bookings after the master is created.
//
// Selling units:
//   • 1KK Urban Studios — VR 679714, qty 1..3 (allocates K.102/103/106)
//   • K.201             — physical, qty fixed at 1 (only one unit exists)
//   • 1KK Deluxe        — VR 648816, qty 1..2 (allocates K.202/203). The
//                         operator-facing name is "1KK Deluxe"; "Twin
//                         Apartments" is an Airbnb-only listing concept.
//   • O.308 (2 Bedroom) — physical, qty fixed at 1 (only one unit exists)
interface SellingUnit {
  roomId: number;
  label: string;
  category: 'Urban' | 'Deluxe';
  maxQty: number;
}

const SELLING_UNITS: SellingUnit[] = [
  { roomId: 679714, label: '1KK Urban Studios',         category: 'Urban',  maxQty: 3 },
  { roomId: 656437, label: 'K.201 (2KK Deluxe)',        category: 'Deluxe', maxQty: 1 },
  { roomId: 648816, label: '1KK Deluxe',                category: 'Deluxe', maxQty: 2 },
  { roomId: 674672, label: 'O.308 (2 Bedroom)',         category: 'Deluxe', maxQty: 1 },
];

const SELLING_UNIT_BY_ROOM_ID: Record<number, SellingUnit> = Object.fromEntries(
  SELLING_UNITS.map((s) => [s.roomId, s]),
);

const SELLING_UNIT_GROUPS = [
  { category: 'Urban'  as const, options: SELLING_UNITS.filter((s) => s.category === 'Urban') },
  { category: 'Deluxe' as const, options: SELLING_UNITS.filter((s) => s.category === 'Deluxe') },
];

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

/** One row in the multi-unit booking form. Multiple rows let the operator
 *  build combination bookings (e.g. 1 × 1KK Urban + 1 × 1KK Deluxe for a
 *  4-guest party). Each row turns into one Beds24 booking; all rows share
 *  the same guest details and dates and are linked via a [GROUP:xxx]
 *  marker in comments. */
interface UnitRow {
  roomId: number;
  /** 1..maxQty for the selected selling unit. */
  roomQty: number;
  /** Per-row price in CZK (raw input — converted on submit). */
  price: string;
}

interface FormState {
  units: UnitRow[];
  arrival: string;
  departure: string;
  numAdult: number;
  numChild: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  notes: string;
}

const DEFAULT_FORM: FormState = {
  units: [{ roomId: 679714, roomQty: 1, price: "" }],
  arrival: "",
  departure: "",
  numAdult: 1,
  numChild: 0,
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
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
type PaymentMode = 'pct' | 'czk';

interface PaymentRow {
  amount: string;     // raw input value (interpreted by mode)
  sendDate: string;   // YYYY-MM-DD
}

interface ResultPaymentRow {
  paymentNumber: number;
  totalPayments: number;
  amountCzk: number;
  sendDate: string;
  status: 'sent' | 'scheduled';
  url?: string;
}

function todayLocal(): string {
  return new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD in local time
}

function defaultPaymentsForCount(count: number): PaymentRow[] {
  if (count === 2) {
    return [
      { amount: "50", sendDate: "" },
      { amount: "50", sendDate: "" },
    ];
  }
  return [
    { amount: "33", sendDate: "" },
    { amount: "33", sendDate: "" },
    { amount: "34", sendDate: "" },
  ];
}

export default function CreateBookingModal({ onClose, onCreated }: Props) {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includePaymentLink, setIncludePaymentLink] = useState(false);
  const [splitPayment, setSplitPayment] = useState(false);
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('pct');
  const [payments, setPayments] = useState<PaymentRow[]>(defaultPaymentsForCount(2));

  // Link step state
  const [step, setStep] = useState<Step>('form');
  const [paymentUrl, setPaymentUrl] = useState('');
  const [resultPayments, setResultPayments] = useState<ResultPaymentRow[] | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  function set<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  // ── Unit-row helpers ──────────────────────────────────────────────────────
  function updateUnit(idx: number, patch: Partial<UnitRow>) {
    setForm((prev) => ({
      ...prev,
      units: prev.units.map((u, i) => (i === idx ? { ...u, ...patch } : u)),
    }));
  }

  function addUnit() {
    setForm((prev) => ({
      ...prev,
      units: [...prev.units, { roomId: 679714, roomQty: 1, price: "" }],
    }));
  }

  function removeUnit(idx: number) {
    setForm((prev) => {
      if (prev.units.length <= 1) return prev;
      return { ...prev, units: prev.units.filter((_, i) => i !== idx) };
    });
  }

  // Per-row price as a number (0 when blank/invalid)
  function unitPriceCzk(u: UnitRow): number {
    const n = parseFloat(u.price);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // Sum of all row prices — replaces the old top-level form.price
  function totalPrice(): number {
    return form.units.reduce((s, u) => s + unitPriceCzk(u), 0);
  }

  // ── Fetch-prices flow ──────────────────────────────────────────────────────
  // Pulls Beds24's daily rates for the selected dates and auto-fills the
  // per-row Price field for every row (multiplied by its qty). Uses
  // ignoreAvailability=true so we get rates even when the unit shows as
  // booked — operator may be entering a manual booking that overrides.
  const [fetchingPrices, setFetchingPrices] = useState(false);
  const [priceFetchNote, setPriceFetchNote] = useState<string | null>(null);

  async function fetchPricesForAllRows() {
    if (!form.arrival || !form.departure) return;
    setFetchingPrices(true);
    setPriceFetchNote(null);
    try {
      const url = `/api/price-check?arrival=${encodeURIComponent(form.arrival)}&departure=${encodeURIComponent(form.departure)}&ignoreAvailability=true`;
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Price check failed');

      // Build a per-unit price map keyed by selling roomId
      const perUnitByRoomId = new Map<number, number>();
      for (const offer of (data.offers ?? []) as { roomId?: number; price?: number | null }[]) {
        if (offer.roomId && offer.price != null && offer.price > 0) {
          perUnitByRoomId.set(offer.roomId, offer.price);
        }
      }

      // Fill each row — multiply per-unit price by the row's qty
      let filled = 0;
      let missing = 0;
      setForm((prev) => ({
        ...prev,
        units: prev.units.map((u) => {
          const perUnit = perUnitByRoomId.get(u.roomId);
          if (perUnit == null) {
            missing += 1;
            return u; // leave the price as-is for rows where Beds24 has no rate
          }
          filled += 1;
          const total = Math.round(perUnit * u.roomQty);
          return { ...u, price: String(total) };
        }),
      }));

      if (filled === 0) {
        setPriceFetchNote('No rates published in Beds24 for these dates.');
      } else if (missing > 0) {
        setPriceFetchNote(`Filled ${filled} row${filled === 1 ? '' : 's'}; ${missing} had no rate in Beds24.`);
      } else {
        setPriceFetchNote(`Filled ${filled} row${filled === 1 ? '' : 's'} with Beds24 rates.`);
      }
      setTimeout(() => setPriceFetchNote(null), 4000);
    } catch (e) {
      setPriceFetchNote((e as Error).message);
      setTimeout(() => setPriceFetchNote(null), 4000);
    } finally {
      setFetchingPrices(false);
    }
  }

  // Initialize default send dates whenever payments are reset or arrival changes.
  // Row 1 = today; row 2 = arrival (check-in); row 3 = no default (user fills).
  // Only fills empty rows so we don't trample manual edits.
  useEffect(() => {
    if (!splitPayment) return;
    setPayments((prev) => {
      const next = [...prev];
      const today = todayLocal();
      if (next[0] && !next[0].sendDate) next[0] = { ...next[0], sendDate: today };
      if (next[1] && !next[1].sendDate && form.arrival) {
        next[1] = { ...next[1], sendDate: form.arrival };
      }
      return next;
    });
  }, [splitPayment, form.arrival]);

  // When split is freshly turned on: reset to clean defaults
  function toggleSplit(on: boolean) {
    setSplitPayment(on);
    if (on) {
      setPaymentMode('pct');
      setPayments(defaultPaymentsForCount(2));
    }
  }

  function updatePayment(idx: number, patch: Partial<PaymentRow>) {
    setPayments((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }

  function addPaymentRow() {
    setPayments((prev) => {
      if (prev.length >= 3) return prev;
      // Switch to 3-row defaults if we're going from 2 → 3
      const defaults = defaultPaymentsForCount(3);
      // Preserve existing send dates from rows the user already touched
      return defaults.map((d, i) => {
        const existing = prev[i];
        if (!existing) return d;
        return { ...d, sendDate: existing.sendDate, amount: existing.amount };
      });
    });
  }

  function removePaymentRow(idx: number) {
    setPayments((prev) => {
      if (prev.length <= 2) return prev; // minimum 2 in split mode
      const next = prev.filter((_, i) => i !== idx);
      // If we drop down to 2, re-balance to 50/50 only if amounts came from auto-defaults
      return next;
    });
  }

  function switchMode(newMode: PaymentMode) {
    if (newMode === paymentMode) return;
    const priceNum = totalPrice();
    const hasPrice = priceNum > 0;
    setPayments((prev) =>
      prev.map((p) => {
        const v = parseFloat(p.amount);
        if (!Number.isFinite(v) || v <= 0 || !hasPrice) return { ...p, amount: '' };
        if (newMode === 'czk' && paymentMode === 'pct') {
          // % → Kč
          return { ...p, amount: String(Math.round((priceNum * v) / 100)) };
        }
        if (newMode === 'pct' && paymentMode === 'czk') {
          // Kč → %
          return { ...p, amount: String(Math.round((v / priceNum) * 100)) };
        }
        return p;
      }),
    );
    setPaymentMode(newMode);
  }

  function handleCopy(idx: number, url: string) {
    navigator.clipboard.writeText(url);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx((v) => (v === idx ? null : v)), 2000);
  }

  // Compute Kč amount for a given row (resolves % to Kč if needed)
  function rowAmountCzk(row: PaymentRow, priceNum: number): number {
    const v = parseFloat(row.amount);
    if (!Number.isFinite(v) || v <= 0) return 0;
    if (paymentMode === 'pct') return Math.round((priceNum * v) / 100);
    return Math.round(v);
  }

  // Live sum for display — derived from all unit rows
  const priceNum = totalPrice();
  const sumActual = payments.reduce((s, p) => s + rowAmountCzk(p, priceNum), 0);
  const sumPct = paymentMode === 'pct'
    ? payments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0)
    : 0;
  const sumMatches = paymentMode === 'pct'
    ? Math.abs(sumPct - 100) < 0.001
    : sumActual === Math.round(priceNum);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (form.departure && form.arrival && form.departure <= form.arrival) {
      setError("Check-out must be after check-in");
      return;
    }

    // Split payment validation
    if (includePaymentLink && splitPayment) {
      if (priceNum <= 0) {
        setError("Price must be set to use split payments");
        return;
      }
      const today = todayLocal();
      const hasFutureScheduled = payments.some((p) => p.sendDate && p.sendDate > today);
      if (hasFutureScheduled && !form.email.trim()) {
        setError("Guest email is required when any payment is scheduled for a future date (the link is sent by email automatically)");
        return;
      }
      for (let i = 0; i < payments.length; i++) {
        const p = payments[i];
        const amount = rowAmountCzk(p, priceNum);
        if (amount <= 0) {
          setError(`Payment ${i + 1}: amount must be greater than 0`);
          return;
        }
        if (!p.sendDate) {
          setError(`Payment ${i + 1}: send date is required`);
          return;
        }
        if (p.sendDate < today) {
          setError(`Payment ${i + 1}: send date cannot be in the past`);
          return;
        }
        if (i > 0 && p.sendDate < payments[i - 1].sendDate) {
          setError(`Payment ${i + 1}: send date must be on or after the previous payment`);
          return;
        }
      }
      // Sum check with confirmation
      if (!sumMatches) {
        const msg = paymentMode === 'pct'
          ? `Percentages add up to ${sumPct}% (not 100%). Continue anyway?`
          : `Payments sum to ${sumActual.toLocaleString('cs-CZ')} Kč but booking total is ${Math.round(priceNum).toLocaleString('cs-CZ')} Kč. Continue anyway?`;
        if (!window.confirm(msg)) return;
      }
    }

    // Per-row validation
    for (let i = 0; i < form.units.length; i++) {
      const u = form.units[i];
      const su = SELLING_UNIT_BY_ROOM_ID[u.roomId];
      if (!su) {
        setError(`Row ${i + 1}: invalid selling unit`);
        return;
      }
      if (u.roomQty < 1 || u.roomQty > su.maxQty) {
        setError(`Row ${i + 1}: qty must be 1–${su.maxQty} for ${su.label}`);
        return;
      }
    }

    setError(null);
    setSubmitting(true);
    try {
      // 1. Create the Beds24 booking(s).
      // Server-side handles single vs multi-row: when units.length > 1 it
      // generates a [GROUP:xxx] marker and POSTs an array of bookings to
      // Beds24 in one call, returning all created IDs.
      const payload = {
        units: form.units.map((u) => ({
          roomId: u.roomId,
          roomQty: u.roomQty,
          price: unitPriceCzk(u),
        })),
        arrival: form.arrival,
        departure: form.departure,
        numAdult: form.numAdult,
        numChild: form.numChild,
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email,
        phone: form.phone,
        notes: form.notes,
      };
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to create booking");

      // Server returns the canonical reservation number (first booking ID)
      // along with the full list of created IDs. The payment link attaches
      // to the canonical reservation so the merged "package" view shows it.
      const reservationNumber: string | undefined = json.reservationNumber;

      if (!includePaymentLink || priceNum <= 0) {
        onCreated();
        return;
      }

      const guestName = [form.firstName, form.lastName].filter(Boolean).join(' ');

      // 2a. Split payment path
      if (splitPayment && reservationNumber) {
        const total = payments.length;
        const paymentInputs = payments.map((p, i) => ({
          paymentNumber: i + 1,
          totalPayments: total,
          amountCzk: rowAmountCzk(p, priceNum),
          sendDate: p.sendDate,
        }));

        const linkRes = await fetch('/api/stripe/split-payments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reservationNumber,
            guestEmail: form.email || undefined,
            guestPhone: form.phone || undefined,
            guestName: guestName || undefined,
            payments: paymentInputs,
          }),
        });
        const linkData = await linkRes.json();
        if (!linkRes.ok) throw new Error(linkData.error ?? 'Booking created but failed to set up split payments');

        setResultPayments(linkData.payments ?? []);
        setStep('link');
        return;
      }

      // 2b. Single payment path (existing flow)
      const description = reservationNumber
        ? `Baker House — reservation ${reservationNumber}`
        : `Baker House — ${guestName}`;

      const linkRes = await fetch('/api/stripe/payment-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amountCzk: priceNum,
          description,
          guestEmail: form.email || undefined,
          guestPhone: form.phone || undefined,
          reservationNumber: reservationNumber,
        }),
      });
      const linkData = await linkRes.json();
      if (!linkRes.ok) throw new Error(linkData.error ?? 'Booking created but failed to generate payment link');

      setPaymentUrl(linkData.url);
      setStep('link');
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Link step ──────────────────────────────────────────────────────────────
  if (step === 'link') {
    const guestName = [form.firstName, form.lastName].filter(Boolean).join(' ');
    const submittedTotal = totalPrice();

    // Build display rows: split path uses resultPayments; single path synthesizes one row
    const displayRows: ResultPaymentRow[] = resultPayments ?? [{
      paymentNumber: 1,
      totalPayments: 1,
      amountCzk: submittedTotal,
      sendDate: todayLocal(),
      status: 'sent',
      url: paymentUrl,
    }];

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden max-h-[90vh] overflow-y-auto">
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 sticky top-0 bg-white z-10">
            <h2 className="text-base font-semibold text-gray-900">
              Booking Created · {displayRows.length} {displayRows.length === 1 ? 'Payment Link' : 'Payments'}
            </h2>
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
                {submittedTotal.toLocaleString('cs-CZ')} Kč
              </p>
            </div>

            {/* Payment rows */}
            <div className="space-y-3">
              {displayRows.map((row, idx) => (
                <div
                  key={idx}
                  className="border border-gray-200 rounded-lg px-4 py-3 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold text-gray-900">
                        {row.totalPayments > 1
                          ? `Payment ${row.paymentNumber} of ${row.totalPayments}`
                          : 'Payment'}
                      </p>
                      <p className="text-xs text-gray-500">
                        {row.amountCzk.toLocaleString('cs-CZ')} Kč
                      </p>
                    </div>
                    {row.status === 'sent' ? (
                      <span className="text-[10px] font-medium uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded">
                        Link ready
                      </span>
                    ) : (
                      <span className="text-[10px] font-medium uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">
                        Scheduled
                      </span>
                    )}
                  </div>

                  {row.status === 'sent' && row.url ? (
                    <>
                      <div className="flex items-center gap-2">
                        <input
                          readOnly
                          value={row.url}
                          className="flex-1 px-2 py-1.5 border border-gray-200 rounded text-[11px] text-gray-500 bg-gray-50 truncate"
                        />
                        <button
                          onClick={() => handleCopy(idx, row.url!)}
                          className={`px-2.5 py-1.5 text-[11px] font-medium rounded transition-colors whitespace-nowrap ${
                            copiedIdx === idx ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                          }`}
                        >
                          {copiedIdx === idx ? 'Copied!' : 'Copy'}
                        </button>
                      </div>
                      {form.phone && (
                        <button
                          onClick={() => {
                            const text = encodeURIComponent(
                              `Hi ${guestName || 'there'}, here is your payment link${row.totalPayments > 1 ? ` (Payment ${row.paymentNumber} of ${row.totalPayments})` : ''} for your Baker House stay: ${row.url}`,
                            );
                            const num = form.phone.replace(/\D/g, '');
                            window.open(`https://wa.me/${num}?text=${text}`, '_blank');
                          }}
                          className="w-full flex items-center justify-center gap-1.5 py-1.5 border border-green-200 text-green-700 text-[11px] font-medium rounded hover:bg-green-50 transition-colors"
                        >
                          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                            <path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.554 4.116 1.527 5.845L0 24l6.333-1.505A11.955 11.955 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.885 0-3.647-.494-5.17-1.358l-.37-.216-3.758.893.939-3.65-.24-.384A9.96 9.96 0 012 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/>
                          </svg>
                          Send via WhatsApp
                        </button>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-gray-500">
                      Will be emailed to the guest automatically on{' '}
                      <span className="font-medium text-gray-700">{row.sendDate}</span>.
                    </p>
                  )}
                </div>
              ))}
            </div>

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
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden max-h-[95vh] overflow-y-auto">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 sticky top-0 bg-white z-10">
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

          {/* Dates */}
          <div className="grid grid-cols-2 gap-3">
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

          {/* Units — one or more rows. Each row becomes a separate Beds24
              booking; multi-row bookings are linked into a single visual
              reservation via a group marker in comments. */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-gray-600">Units</p>
              <button
                type="button"
                onClick={fetchPricesForAllRows}
                disabled={!form.arrival || !form.departure || fetchingPrices}
                className="text-[11px] font-medium text-indigo-600 hover:text-indigo-800 flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                title={
                  !form.arrival || !form.departure
                    ? 'Set check-in and check-out first'
                    : 'Pull Beds24 daily rates for these dates and fill the price fields (qty-multiplied)'
                }
              >
                {fetchingPrices ? (
                  <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                ) : (
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                )}
                {fetchingPrices ? 'Fetching…' : 'Fetch prices from Beds24'}
              </button>
            </div>
            {form.units.map((unit, idx) => {
              const su = SELLING_UNIT_BY_ROOM_ID[unit.roomId];
              const showQty = su?.maxQty && su.maxQty > 1;
              return (
                <div
                  key={idx}
                  className={`grid ${showQty ? 'grid-cols-[1fr_70px_120px_28px]' : 'grid-cols-[1fr_120px_28px]'} gap-2 items-end`}
                >
                  <Field label={idx === 0 ? "Selling unit" : ""}>
                    <select
                      value={unit.roomId}
                      onChange={(e) => {
                        const newId = parseInt(e.target.value);
                        // Reset qty to 1 when switching unit (qty bounds change)
                        updateUnit(idx, { roomId: newId, roomQty: 1 });
                      }}
                      className={inputCls}
                    >
                      {SELLING_UNIT_GROUPS.map((group) => (
                        <optgroup key={group.category} label={group.category}>
                          {group.options.map((o) => (
                            <option key={o.roomId} value={o.roomId}>{o.label}</option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </Field>
                  {showQty && (
                    <Field label={idx === 0 ? "Qty" : ""}>
                      <select
                        value={unit.roomQty}
                        onChange={(e) => updateUnit(idx, { roomQty: parseInt(e.target.value) })}
                        className={inputCls}
                      >
                        {Array.from({ length: su!.maxQty }, (_, i) => i + 1).map((n) => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </select>
                    </Field>
                  )}
                  <Field label={idx === 0 ? "Price (Kč)" : ""}>
                    <input
                      type="number"
                      min={0}
                      value={unit.price}
                      onChange={(e) => updateUnit(idx, { price: e.target.value })}
                      placeholder="0"
                      className={inputCls}
                    />
                  </Field>
                  {form.units.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => removeUnit(idx)}
                      className="h-9 w-7 flex items-center justify-center text-gray-400 hover:text-red-500 transition-colors"
                      title="Remove this unit"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  ) : <span />}
                </div>
              );
            })}

            <div className="flex items-center justify-between pt-1">
              <button
                type="button"
                onClick={addUnit}
                className="text-xs font-medium text-indigo-600 hover:text-indigo-800 flex items-center gap-1"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Add another unit
              </button>
              {form.units.length > 1 && (
                <div className="text-xs text-gray-600">
                  Total: <strong>{priceNum.toLocaleString('cs-CZ')} Kč</strong>
                </div>
              )}
            </div>

            {priceFetchNote && (
              <p className="text-[11px] text-gray-500 italic">{priceFetchNote}</p>
            )}
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
          <div className="grid grid-cols-2 gap-3">
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
            onClick={() => {
              const next = !includePaymentLink;
              setIncludePaymentLink(next);
              if (!next) setSplitPayment(false); // turning off parent disables child
            }}
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

          {/* Split payment sub-toggle */}
          {includePaymentLink && (
            <div className="pl-4 ml-2 border-l-2 border-indigo-100 space-y-3">
              <button
                type="button"
                onClick={() => toggleSplit(!splitPayment)}
                className="flex items-center gap-2 text-xs font-medium text-gray-600 hover:text-gray-900"
              >
                <span
                  className={`relative inline-flex h-4 w-7 flex-shrink-0 rounded-full border-2 border-transparent transition-colors ${
                    splitPayment ? 'bg-indigo-600' : 'bg-gray-200'
                  }`}
                >
                  <span
                    className={`inline-block h-3 w-3 rounded-full bg-white shadow transform transition-transform ${
                      splitPayment ? 'translate-x-3' : 'translate-x-0'
                    }`}
                  />
                </span>
                Split payment
              </button>

              {splitPayment && (
                <div className="space-y-3">
                  {/* Mode pill */}
                  <div className="inline-flex rounded-md border border-gray-200 overflow-hidden text-xs">
                    <button
                      type="button"
                      onClick={() => switchMode('pct')}
                      className={`px-3 py-1.5 font-medium transition-colors flex items-center gap-1 ${
                        paymentMode === 'pct'
                          ? 'bg-indigo-600 text-white'
                          : 'bg-white text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 5L5 19M9 7a2 2 0 11-4 0 2 2 0 014 0zm10 10a2 2 0 11-4 0 2 2 0 014 0z" />
                      </svg>
                      Percent
                    </button>
                    <button
                      type="button"
                      onClick={() => switchMode('czk')}
                      className={`px-3 py-1.5 font-medium transition-colors flex items-center gap-1 ${
                        paymentMode === 'czk'
                          ? 'bg-indigo-600 text-white'
                          : 'bg-white text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" />
                      </svg>
                      Kč
                    </button>
                  </div>

                  {/* Payment rows */}
                  <div className="space-y-2">
                    {payments.map((p, idx) => {
                      const total = payments.length;
                      const computedKc = rowAmountCzk(p, priceNum);
                      return (
                        <div key={idx} className="grid grid-cols-[1fr_90px_140px_28px] gap-2 items-end">
                          <div className="text-xs">
                            <p className="font-medium text-gray-700">
                              Payment {idx + 1} of {total}
                            </p>
                            {paymentMode === 'pct' && computedKc > 0 && (
                              <p className="text-[10px] text-gray-400">
                                ≈ {computedKc.toLocaleString('cs-CZ')} Kč
                              </p>
                            )}
                          </div>
                          <div className="relative">
                            <input
                              type="number"
                              min={0}
                              step={paymentMode === 'pct' ? 1 : 1}
                              value={p.amount}
                              onChange={(e) => updatePayment(idx, { amount: e.target.value })}
                              placeholder={paymentMode === 'pct' ? '50' : '2500'}
                              className={`${inputCls} pr-8`}
                            />
                            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">
                              {paymentMode === 'pct' ? '%' : 'Kč'}
                            </span>
                          </div>
                          <input
                            type="date"
                            value={p.sendDate}
                            min={todayLocal()}
                            onChange={(e) => updatePayment(idx, { sendDate: e.target.value })}
                            className={inputCls}
                          />
                          {idx >= 2 ? (
                            <button
                              type="button"
                              onClick={() => removePaymentRow(idx)}
                              className="h-9 w-7 flex items-center justify-center text-gray-400 hover:text-red-500 transition-colors"
                              title="Remove this payment"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          ) : (
                            <span />
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Add payment button */}
                  {payments.length < 3 && (
                    <button
                      type="button"
                      onClick={addPaymentRow}
                      className="text-xs font-medium text-indigo-600 hover:text-indigo-800 flex items-center gap-1"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                      Add a payment
                    </button>
                  )}

                  {/* Sum line */}
                  <div className={`text-xs px-3 py-1.5 rounded ${
                    sumMatches
                      ? 'bg-green-50 text-green-700 border border-green-200'
                      : 'bg-amber-50 text-amber-800 border border-amber-200'
                  }`}>
                    {paymentMode === 'pct' ? (
                      <>Sum: <strong>{sumPct}%</strong> of 100% {sumMatches ? '✓' : '⚠️'}</>
                    ) : (
                      <>Sum: <strong>{sumActual.toLocaleString('cs-CZ')} Kč</strong> of {Math.round(priceNum).toLocaleString('cs-CZ')} Kč {sumMatches ? '✓' : '⚠️'}</>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

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
              {submitting ? "Creating…" : (includePaymentLink ? "Create & Get Link" : "Create Booking")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

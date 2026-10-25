'use client';
import { useEffect, useState } from "react";
import FloatingPanel from "@/components/shared/FloatingPanel";
import type { InvoiceData, Reservation } from "@/types/reservation";
import { COUNTRY_OPTIONS, languageNameForCountry } from "@/utils/countries";
import { pragueToday } from "@/utils/periodUtils";
import { stayAvailability, effectiveFreeUnits, type TypeAvailability, type UnitAvailability } from "@/utils/bookingAvailability";
import { hasAnyInvoiceData, invoiceDeliveryProblem, type InvoiceDelivery } from "@/utils/newBookingInvoice";

// Operator-facing manual bookings target one of TWO unit kinds:
//
//   1. SELLABLE (default) — virtual or single-physical inventory rows
//      operators normally use. Beds24 handles physical-unit allocation
//      underneath (e.g. "1KK Urban Studios" → K.102/K.103/K.106).
//
//   2. PHYSICAL (force room) — explicit physical roomId. Use case: guest
//      wants to extend the stay in their current physical room (Beds24's
//      VR allocator wouldn't necessarily pick the same room), operator
//      wants to honour an OTA "we promised K.202 specifically" request,
//      or any flow where the operator needs to bypass the allocator.
//
// Both produce a normal Beds24 booking — the POST shape is identical;
// only the roomId differs.
//
// Sellable units:
//   • 1KK Urban Studios — VR 679714, qty 1..3 (auto-allocates K.102/103/106)
//   • K.201             — physical, qty fixed at 1 (only one unit exists)
//   • 1KK Deluxe        — VR 648816, qty 1..2 (auto-allocates K.202/203).
//                         The operator-facing name is "1KK Deluxe"; "Twin
//                         Apartments" is an Airbnb-only listing concept.
//   • O.308 (2 Bedroom) — physical, qty fixed at 1 (only one unit exists)
//
// Physical units (force room):
//   • K.102, K.103, K.106 — Urban physical rooms (force-allocate one)
//   • K.202, K.203        — Deluxe Studios physical rooms (force-allocate one)
//   (K.201 + O.308 are NOT duplicated here — their sellable row IS the
//    physical room, same roomId.)
interface SellingUnit {
  roomId: number;
  label: string;
  category: 'Urban' | 'Deluxe';
  kind: 'sellable' | 'physical';
  maxQty: number;
}

const SELLING_UNITS: SellingUnit[] = [
  // ── Sellable (default) ────────────────────────────────────────────────
  { roomId: 679714, label: '1KK Urban Studios',         category: 'Urban',  kind: 'sellable', maxQty: 3 },
  { roomId: 656437, label: 'K.201 (2KK Deluxe)',        category: 'Deluxe', kind: 'sellable', maxQty: 1 },
  { roomId: 648816, label: '1KK Deluxe',                category: 'Deluxe', kind: 'sellable', maxQty: 2 },
  { roomId: 674672, label: 'O.308 (2 Bedroom)',         category: 'Deluxe', kind: 'sellable', maxQty: 1 },
  // ── Force physical room (extend-stay, OTA-specific requests, etc.) ────
  { roomId: 679703, label: 'K.102 (force)',             category: 'Urban',  kind: 'physical', maxQty: 1 },
  { roomId: 679704, label: 'K.103 (force)',             category: 'Urban',  kind: 'physical', maxQty: 1 },
  { roomId: 679705, label: 'K.106 (force)',             category: 'Urban',  kind: 'physical', maxQty: 1 },
  { roomId: 648596, label: 'K.202 (force)',             category: 'Deluxe', kind: 'physical', maxQty: 1 },
  { roomId: 648772, label: 'K.203 (force)',             category: 'Deluxe', kind: 'physical', maxQty: 1 },
];

const SELLING_UNIT_BY_ROOM_ID: Record<number, SellingUnit> = Object.fromEntries(
  SELLING_UNITS.map((s) => [s.roomId, s]),
);

/** Sellable roomIds in dropdown order — the availability list follows it. */
const SELLABLE_ORDER = SELLING_UNITS.filter((s) => s.kind === 'sellable').map((s) => s.roomId);

// Two-level grouping for the dropdown: kind first (sellable vs force-physical),
// then category (Urban / Deluxe) so operators can find what they need fast.
const SELLING_UNIT_GROUPS = [
  {
    label: 'Sellable',
    options: SELLING_UNITS.filter((s) => s.kind === 'sellable'),
  },
  {
    label: 'Force physical room',
    options: SELLING_UNITS.filter((s) => s.kind === 'physical'),
  },
];

interface Props {
  /** Reservations on screen — the occupancy behind "Check availability & prices". */
  reservations: Reservation[];
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
  /** Beds24 price for ONE unit, when the row was filled from the availability
   *  list — lets a qty change rescale the price it set. */
  quotedUnitPrice?: number;
  /** "arrival|departure" that price was quoted for — warns if the dates move. */
  quotedFor?: string;
}

/** Someone on the booking besides the lead guest. */
interface GuestName {
  firstName: string;
  lastName: string;
}

interface FormState {
  units: UnitRow[];
  arrival: string;
  departure: string;
  numAdult: number;
  numChild: number;
  firstName: string;
  lastName: string;
  /** Written into the Beds24 booking and printed on the invoice. */
  additionalGuests: GuestName[];
  email: string;
  phone: string;
  /** ISO 3166-1 alpha-2 (uppercase), mandatory — see the Nationality field. */
  nationality: string;
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
  additionalGuests: [],
  email: "",
  phone: "",
  nationality: "",
  notes: "",
};

const EMPTY_INVOICE: InvoiceData = {
  companyName: "",
  companyAddress: "",
  ico: "",
  vatNumber: "",
  billingEmail: "",
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

/** The on/off switch every toggle in this form uses. */
function Switch({ on }: { on: boolean }) {
  return (
    <span
      className={`relative inline-flex h-4 w-7 flex-shrink-0 rounded-full border-2 border-transparent transition-colors ${
        on ? 'bg-indigo-600' : 'bg-gray-200'
      }`}
    >
      <span
        className={`inline-block h-3 w-3 rounded-full bg-white shadow transform transition-transform ${
          on ? 'translate-x-3' : 'translate-x-0'
        }`}
      />
    </span>
  );
}

const inputCls = "w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300";

type Step = 'form' | 'result';
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

/** A sellable type in the availability list, priced. */
interface QuotedType extends TypeAvailability {
  /** Beds24 price for ONE unit of this type, for the whole stay. */
  price: number | null;
  /** 'offer' = Beds24's own quote; 'estimate' = rebuilt from daily rates
   *  because Beds24 won't sell this span on the web (min-stay, advance or
   *  check-in rule) even though a unit is free — which a manual booking may
   *  still take, since it bypasses those rules. */
  source: 'offer' | 'estimate' | null;
}

interface AvailabilityResult {
  /** arrival|departure|adults|children the list was built for. */
  key: string;
  nights: number;
  party: number;
  types: QuotedType[];
  /** Beds24 pricing failed — occupancy is still shown. */
  pricingError?: string;
}

type InvoiceTiming = 'now' | 'schedule';

/** What happened to the invoice after the booking was created. */
type InvoiceOutcome =
  | { kind: 'saved' }
  | { kind: 'scheduled'; sendDate: string; to: string; withPaymentDetails: boolean }
  | {
      kind: 'sent' | 'deferred';
      invoiceNumber: string;
      to: string;
      withPaymentDetails: boolean;
      deferral?: string;
      statusSaved: boolean;
      revenueRecorded?: boolean;
    }
  | { kind: 'error'; message: string; saved: boolean };

/** Everything the result step reports once the booking exists. */
interface CreatedBooking {
  reservationNumber?: string;
  /** null = no payment link was requested. */
  paymentRows: ResultPaymentRow[] | null;
  paymentError: string | null;
  /** null = no invoice step. */
  invoice: InvoiceOutcome | null;
}

function todayLocal(): string {
  return pragueToday();
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function nightsBetween(arrival: string, departure: string): number {
  return Math.round((Date.parse(`${departure}T00:00:00Z`) - Date.parse(`${arrival}T00:00:00Z`)) / 86_400_000);
}

function formatCZK(n: number): string {
  return Math.round(n).toLocaleString('cs-CZ') + ' Kč';
}

function formatDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** "Jan Novák" → "Novák"; several holders → "2 stays"; a blackout → "Blocked". */
function shortHolder(heldBy: string | null): string {
  if (!heldBy) return '';
  if (heldBy.startsWith('Blocked')) return 'Blocked';
  const holders = heldBy.split(', ');
  if (holders.length > 1) return `${holders.length} stays`;
  const parts = heldBy.trim().split(/\s+/);
  return parts[parts.length - 1];
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

/** Beds24 per-unit prices by sellable roomId, via the Price Check endpoint. */
async function fetchPriceMap(
  arrival: string,
  departure: string,
  adults: number,
  children: number,
  ignoreAvailability = false,
): Promise<Map<number, number>> {
  const params = new URLSearchParams({
    arrival,
    departure,
    adults: String(adults),
    children: String(children),
  });
  if (ignoreAvailability) params.set('ignoreAvailability', 'true');
  const res = await fetch(`/api/price-check?${params.toString()}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `Price check failed (HTTP ${res.status})`);
  const map = new Map<number, number>();
  for (const o of (data.offers ?? []) as { roomId?: number; price?: number | null }[]) {
    if (o.roomId && o.price != null && o.price > 0) map.set(o.roomId, o.price);
  }
  return map;
}

export default function CreateBookingModal({ reservations, onClose, onCreated }: Props) {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [submitting, setSubmitting] = useState(false);
  /** What the submit is doing right now — shown on the button. */
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includePaymentLink, setIncludePaymentLink] = useState(false);
  const [splitPayment, setSplitPayment] = useState(false);
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('pct');
  const [payments, setPayments] = useState<PaymentRow[]>(defaultPaymentsForCount(2));

  // Invoice — off by default; for bookings the customer pays by invoice.
  const [invoiceOn, setInvoiceOn] = useState(false);
  const [invoiceData, setInvoiceData] = useState<InvoiceData>(EMPTY_INVOICE);
  const [sendInvoice, setSendInvoice] = useState(false);
  const [invoiceTiming, setInvoiceTiming] = useState<InvoiceTiming>('now');
  const [invoiceSendDate, setInvoiceSendDate] = useState('');
  // On by default: an invoice the customer pays needs the account and VS.
  const [invoicePaymentDetails, setInvoicePaymentDetails] = useState(true);

  // Result step state
  const [step, setStep] = useState<Step>('form');
  const [created, setCreated] = useState<CreatedBooking | null>(null);
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

  /** Qty change. A price the availability list filled in follows the qty;
   *  one the operator typed is theirs and stays. */
  function changeQty(idx: number, qty: number) {
    setForm((prev) => ({
      ...prev,
      units: prev.units.map((u, i) => {
        if (i !== idx) return u;
        const listPriced =
          u.quotedUnitPrice != null && u.price === String(Math.round(u.quotedUnitPrice * u.roomQty));
        return {
          ...u,
          roomQty: qty,
          ...(listPriced ? { price: String(Math.round(u.quotedUnitPrice! * qty)) } : {}),
        };
      }),
    }));
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

  // ── Additional guests ─────────────────────────────────────────────────────
  function addGuest() {
    setForm((prev) => {
      const additionalGuests = [...prev.additionalGuests, { firstName: "", lastName: "" }];
      // More names than guests means the headcount is stale — grow it, never shrink.
      const names = 1 + additionalGuests.length;
      const numAdult = prev.numAdult + prev.numChild < names ? names - prev.numChild : prev.numAdult;
      return { ...prev, additionalGuests, numAdult };
    });
  }

  function updateGuest(idx: number, patch: Partial<GuestName>) {
    setForm((prev) => ({
      ...prev,
      additionalGuests: prev.additionalGuests.map((g, i) => (i === idx ? { ...g, ...patch } : g)),
    }));
  }

  function removeGuest(idx: number) {
    setForm((prev) => ({
      ...prev,
      additionalGuests: prev.additionalGuests.filter((_, i) => i !== idx),
    }));
  }

  const additionalGuestNames = form.additionalGuests
    .map((g) => `${g.firstName.trim()} ${g.lastName.trim()}`.trim())
    .filter(Boolean);
  const leadGuestName = [form.firstName, form.lastName].map((s) => s.trim()).filter(Boolean).join(' ');

  // ── Availability & prices ─────────────────────────────────────────────────
  // The Price Check list, inside the booking form: every apartment type with
  // its Beds24 price for these dates and which physical units are free (from
  // the reservations on screen). "Use" fills the last unit row; a unit chip
  // forces that specific apartment.
  const [availability, setAvailability] = useState<AvailabilityResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const datesValid = !!form.arrival && !!form.departure && form.departure > form.arrival;
  const listKey = `${form.arrival}|${form.departure}|${form.numAdult}|${form.numChild}`;
  const quoteDates = `${form.arrival}|${form.departure}`;
  const listStale = !!availability && availability.key !== listKey;

  async function checkAvailability() {
    if (!datesValid || checking) return;
    setChecking(true);
    setCheckError(null);
    try {
      await buildAvailability();
    } catch (e) {
      setCheckError(e instanceof Error ? e.message : 'Availability check failed');
    } finally {
      setChecking(false);
    }
  }

  async function buildAvailability() {
    const { arrival, departure, numAdult, numChild } = form;
    const key = `${arrival}|${departure}|${numAdult}|${numChild}`;
    const partySize = numAdult + numChild;
    const occupancy = stayAvailability(reservations, arrival, departure);

    const priced = new Map<number, { price: number; source: 'offer' | 'estimate' }>();
    let pricingError: string | undefined;
    try {
      // 1. Beds24's own quote for the whole party — one call prices every type
      //    that can host it (same call the Price Check pill makes).
      const offers = await fetchPriceMap(arrival, departure, numAdult, numChild);
      for (const t of occupancy) {
        const p = offers.get(t.roomId);
        if (partySize <= t.sleeps && p != null) priced.set(t.roomId, { price: p, source: 'offer' });
      }

      // 2. A party bigger than a studio gets no studio offer at all, but may
      //    still take two studios — so quote the studios for what one sleeps.
      const tooSmall = occupancy.filter((t) => partySize > t.sleeps);
      for (const sleeps of [...new Set(tooSmall.map((t) => t.sleeps))]) {
        const adults = Math.max(1, Math.min(numAdult, sleeps));
        const children = Math.max(0, Math.min(numChild, sleeps - adults));
        const perUnit = await fetchPriceMap(arrival, departure, adults, children);
        for (const t of tooSmall.filter((x) => x.sleeps === sleeps)) {
          const p = perUnit.get(t.roomId);
          if (p != null) priced.set(t.roomId, { price: p, source: 'offer' });
        }
      }

      // 3. A free unit Beds24 won't quote (min-stay, advance or check-in rule)
      //    is still bookable here — estimate it from the daily rates.
      const unquoted = occupancy.filter((t) => effectiveFreeUnits(t) > 0 && !priced.has(t.roomId));
      if (unquoted.length > 0) {
        const estimates = await fetchPriceMap(arrival, departure, 2, 0, true);
        for (const t of unquoted) {
          const p = estimates.get(t.roomId);
          if (p != null) priced.set(t.roomId, { price: p, source: 'estimate' });
        }
      }
    } catch (e) {
      pricingError = e instanceof Error ? e.message : 'Price check failed';
    }

    const types: QuotedType[] = occupancy
      .map((t) => {
        const p = priced.get(t.roomId);
        return { ...t, price: p?.price ?? null, source: p?.source ?? null };
      })
      .sort((a, b) => SELLABLE_ORDER.indexOf(a.roomId) - SELLABLE_ORDER.indexOf(b.roomId));

    setAvailability({ key, nights: nightsBetween(arrival, departure), party: partySize, types, pricingError });
  }

  /** The availability-list price for a dropdown roomId (sellable or forced unit). */
  function listPriceFor(roomId: number): number | null {
    if (!availability || listStale) return null;
    const t = availability.types.find(
      (x) => x.roomId === roomId || x.units.some((u) => u.roomId === roomId),
    );
    return t?.price ?? null;
  }

  /** "Use" in the list → fill the LAST unit row (the one "Add another unit" just added). */
  function applyFromList(roomId: number, perUnit: number | null) {
    const idx = form.units.length - 1;
    updateUnit(
      idx,
      perUnit != null
        ? { roomId, roomQty: 1, price: String(Math.round(perUnit)), quotedUnitPrice: perUnit, quotedFor: quoteDates }
        : { roomId, roomQty: 1, price: '', quotedUnitPrice: undefined, quotedFor: undefined },
    );
  }

  /** Dropdown change — picks up the list's price for the new unit when there is one. */
  function changeUnit(idx: number, roomId: number) {
    const price = listPriceFor(roomId);
    updateUnit(
      idx,
      price != null
        ? { roomId, roomQty: 1, price: String(Math.round(price)), quotedUnitPrice: price, quotedFor: quoteDates }
        // Reset qty to 1 when switching unit (qty bounds change)
        : { roomId, roomQty: 1, quotedUnitPrice: undefined, quotedFor: undefined },
    );
  }

  // ── Invoice ───────────────────────────────────────────────────────────────
  function setInvoiceField<K extends keyof InvoiceData>(field: K, value: InvoiceData[K]) {
    setInvoiceData((prev) => ({ ...prev, [field]: value }));
  }

  function toggleInvoice() {
    const next = !invoiceOn;
    setInvoiceOn(next);
    // The guest's own address is the usual billing address — start from it.
    if (next && !invoiceData.billingEmail.trim() && form.email.trim()) {
      setInvoiceField('billingEmail', form.email.trim());
    }
  }

  function chooseInvoiceTiming(timing: InvoiceTiming) {
    setInvoiceTiming(timing);
    if (timing === 'schedule' && !invoiceSendDate) {
      // Checkout is when the chat flow's invoices go out too.
      const tomorrow = addDays(todayLocal(), 1);
      setInvoiceSendDate(form.departure && form.departure > tomorrow ? form.departure : tomorrow);
    }
  }

  /** What the invoice step will do on submit; null = no invoice step. */
  function invoiceDelivery(): InvoiceDelivery | null {
    if (!invoiceOn) return null;
    if (sendInvoice) return invoiceTiming === 'now' ? 'now' : 'schedule';
    return hasAnyInvoiceData(invoiceData) ? 'save' : null;
  }

  const delivery = invoiceDelivery();
  const invoiceProblem = delivery
    ? invoiceDeliveryProblem(invoiceData, delivery, delivery === 'schedule' ? invoiceSendDate : undefined, todayLocal())
    : null;

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

  /** Stripe link(s) for the new booking — the flow this modal always had. */
  async function createPaymentLinks(reservationNumber: string | undefined): Promise<ResultPaymentRow[]> {
    const guestName = [form.firstName, form.lastName].filter(Boolean).join(' ');

    // Split payment path
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
      if (!linkRes.ok) throw new Error(linkData.error ?? 'Failed to set up split payments');
      return linkData.payments ?? [];
    }

    // Single payment path
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
    if (!linkRes.ok) throw new Error(linkData.error ?? 'Failed to generate payment link');
    return [{
      paymentNumber: 1,
      totalPayments: 1,
      amountCzk: priceNum,
      sendDate: todayLocal(),
      status: 'sent',
      url: linkData.url,
    }];
  }

  /** Store the billing details on the new booking and send / schedule the invoice. */
  async function setUpInvoice(reservationNumbers: string[], how: InvoiceDelivery): Promise<InvoiceOutcome> {
    const withPaymentDetails = how !== 'save' && invoicePaymentDetails;
    try {
      const res = await fetch('/api/bookings/initial-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reservationNumbers,
          invoiceData,
          delivery: how,
          ...(how === 'schedule' ? { sendDate: invoiceSendDate } : {}),
          includeQR: withPaymentDetails,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { kind: 'error', message: json.error ?? `HTTP ${res.status}`, saved: json.saved === true };
      }
      if (json.status === 'saved') return { kind: 'saved' };
      if (json.status === 'scheduled') {
        return { kind: 'scheduled', sendDate: json.sendDate ?? invoiceSendDate, to: invoiceData.billingEmail.trim(), withPaymentDetails };
      }
      return {
        kind: json.status === 'deferred' ? 'deferred' : 'sent',
        invoiceNumber: json.invoiceNumber ?? '',
        to: json.sentTo ?? invoiceData.billingEmail.trim(),
        withPaymentDetails,
        deferral: json.deferral,
        statusSaved: json.statusSaved !== false,
        revenueRecorded: json.revenueRecorded,
      };
    } catch (err) {
      return {
        kind: 'error',
        message: `${err instanceof Error ? err.message : 'Network error'} — open the reservation to check what was saved before retrying.`,
        saved: false,
      };
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (form.departure && form.arrival && form.departure <= form.arrival) {
      setError("Check-out must be after check-in");
      return;
    }
    if (!form.nationality) {
      setError("Nationality is required — Beds24 uses it to pick the language of the automated guest messages");
      return;
    }
    if (invoiceProblem) {
      setError(invoiceProblem);
      return;
    }
    if ((delivery === 'now' || delivery === 'schedule') && priceNum <= 0) {
      setError("Set the price before sending an invoice — it would bill 0 Kč");
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
    setProgress('Creating booking…');

    // 1. Create the Beds24 booking(s).
    // Server-side handles single vs multi-row: when units.length > 1 it
    // generates a [GROUP:xxx] marker and POSTs an array of bookings to
    // Beds24 in one call, returning all created IDs.
    let reservationNumber: string | undefined;
    let reservationNumbers: string[] = [];
    try {
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
        additionalGuests: additionalGuestNames,
        email: form.email,
        phone: form.phone,
        nationality: form.nationality,
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
      reservationNumber = json.reservationNumber;
      reservationNumbers = Array.isArray(json.reservationNumbers)
        ? json.reservationNumbers
        : reservationNumber ? [reservationNumber] : [];
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setSubmitting(false);
      setProgress(null);
      return;
    }

    // ── The booking exists from here on. ──
    // Nothing below may drop the operator back on the form: a failed payment
    // link or invoice is reported in the result step instead, because "Create"
    // again would create a second booking.
    const outcome: CreatedBooking = { reservationNumber, paymentRows: null, paymentError: null, invoice: null };

    if (includePaymentLink && priceNum > 0) {
      setProgress('Creating payment link…');
      try {
        outcome.paymentRows = await createPaymentLinks(reservationNumber);
      } catch (err) {
        outcome.paymentError = err instanceof Error ? err.message : 'Failed to create the payment link';
      }
    }

    if (delivery) {
      setProgress(delivery === 'now' ? 'Sending invoice…' : 'Saving invoice…');
      outcome.invoice = reservationNumbers.length > 0
        ? await setUpInvoice(reservationNumbers, delivery)
        : {
            kind: 'error',
            message: "Beds24 didn't return the new booking number, so the invoice details weren't saved — add them in the reservation drawer.",
            saved: false,
          };
    }

    setSubmitting(false);
    setProgress(null);

    // Nothing worth a second screen → close as before.
    const quiet =
      outcome.paymentRows === null &&
      outcome.paymentError === null &&
      (outcome.invoice === null || outcome.invoice.kind === 'saved');
    if (quiet) {
      onCreated();
      return;
    }
    setCreated(outcome);
    setStep('result');
  }

  // ── Result step ────────────────────────────────────────────────────────────
  if (step === 'result' && created) {
    const guestLine = [leadGuestName || 'guest', ...additionalGuestNames].join(', ');
    const submittedTotal = totalPrice();
    const displayRows = created.paymentRows ?? [];
    const inv = created.invoice;

    return (
      <FloatingPanel
        id="new-booking"
        title={`Booking Created${displayRows.length > 0 ? ` · ${displayRows.length} ${displayRows.length === 1 ? 'Payment Link' : 'Payments'}` : ''}`}
        chipLabel="Booking Created"
        onClose={() => { onCreated(); }}
      >
        <div className="px-6 py-5 space-y-4">
          {/* Success notice */}
          <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
            <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span>
              Booking {created.reservationNumber ? <strong>{created.reservationNumber}</strong> : null} created for {guestLine}
            </span>
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

          {/* Payment link failed — the booking itself is fine */}
          {created.paymentError && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              Payment link not created: {created.paymentError}. Create it from the reservation drawer (Request Payment) — don&apos;t re-create the booking.
            </p>
          )}

          {/* Payment rows */}
          {displayRows.length > 0 && (
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
                              `Hi ${leadGuestName || 'there'}, here is your payment link${row.totalPayments > 1 ? ` (Payment ${row.paymentNumber} of ${row.totalPayments})` : ''} for your Baker House stay: ${row.url}`,
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
          )}

          {/* Invoice */}
          {inv && <InvoiceOutcomeCard outcome={inv} />}

          <button
            onClick={() => { onCreated(); }}
            className="w-full py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
          >
            Done
          </button>
        </div>
      </FloatingPanel>
    );
  }

  // ── Form step ──────────────────────────────────────────────────────────────
  // Only rows the operator has actually priced — the untouched default row
  // (Urban, no price) must not read as a choice already made.
  const usedRoomIds = new Set(form.units.filter((u) => u.price.trim() !== '').map((u) => u.roomId));
  const lastRowNumber = form.units.length;

  return (
    <FloatingPanel
      id="new-booking"
      title="New Direct Booking"
      subtitle="Bypasses min-stay · Custom price"
      width={576}
      onClose={onClose}
    >
      {/* Form */}
      <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">

        {/* Dates */}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Check-in">
            <input
              type="date"
              required
              value={form.arrival}
              onChange={(e) => {
                const arrival = e.target.value;
                setForm((prev) => ({
                  ...prev,
                  arrival,
                  // Keep the stay at least one night when check-in moves past check-out.
                  departure: arrival && prev.departure && prev.departure <= arrival ? addDays(arrival, 1) : prev.departure,
                }));
              }}
              className={inputCls}
            />
          </Field>
          <Field label="Check-out">
            <input
              type="date"
              required
              value={form.departure}
              min={form.arrival ? addDays(form.arrival, 1) : undefined}
              onChange={(e) => set("departure", e.target.value)}
              className={inputCls}
            />
          </Field>
        </div>

        {/* Guests — up here because the availability check prices for them */}
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

        {/* Availability & prices — what the Price Check pill shows, usable in place */}
        <div className="space-y-2">
          <button
            type="button"
            onClick={checkAvailability}
            disabled={!datesValid || checking}
            className="w-full py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            title={datesValid ? 'List every apartment with its Beds24 price and free units for these dates' : 'Set check-in and check-out first'}
          >
            {checking ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                Checking Beds24…
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                {availability && !listStale ? 'Check again' : 'Check availability & prices'}
              </>
            )}
          </button>
          {!datesValid && (
            <p className="text-[11px] text-gray-400 text-center">Pick check-in and check-out to see what&apos;s free and what it costs.</p>
          )}

          {availability && (
            <AvailabilityList
              result={availability}
              stale={listStale}
              usedRoomIds={usedRoomIds}
              targetRow={lastRowNumber}
              noOccupancyData={reservations.length === 0}
              onUse={applyFromList}
            />
          )}
          {checkError && (
            <p className="text-[11px] text-red-600">{checkError}</p>
          )}
        </div>

        {/* Units — one or more rows. Each row becomes a separate Beds24
            booking; multi-row bookings are linked into a single visual
            reservation via a group marker in comments. */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-600">Units</p>
          {form.units.map((unit, idx) => {
            const su = SELLING_UNIT_BY_ROOM_ID[unit.roomId];
            const showQty = su?.maxQty && su.maxQty > 1;
            const quoteStale = !!unit.quotedFor && unit.quotedFor !== quoteDates;
            return (
              <div key={idx} className="space-y-1">
                <div
                  className={`grid ${showQty ? 'grid-cols-[1fr_70px_120px_28px]' : 'grid-cols-[1fr_120px_28px]'} gap-2 items-end`}
                >
                  <Field label={idx === 0 ? "Selling unit" : ""}>
                    <select
                      value={unit.roomId}
                      onChange={(e) => changeUnit(idx, parseInt(e.target.value))}
                      className={inputCls}
                    >
                      {SELLING_UNIT_GROUPS.map((group) => (
                        <optgroup key={group.label} label={group.label}>
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
                        onChange={(e) => changeQty(idx, parseInt(e.target.value))}
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
                      onChange={(e) => updateUnit(idx, { price: e.target.value, quotedUnitPrice: undefined, quotedFor: undefined })}
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
                {quoteStale && (
                  <p className="text-[11px] text-amber-700">
                    This price was fetched for other dates — check availability again or adjust it.
                  </p>
                )}
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

        {/* Additional guests — written into the Beds24 booking and printed
            on the invoice next to the lead guest. */}
        {form.additionalGuests.length > 0 && (
          <div className="space-y-2">
            {form.additionalGuests.map((g, idx) => (
              <div key={idx} className="grid grid-cols-[1fr_1fr_28px] gap-3 items-end">
                <Field label={`Guest ${idx + 2} — first name`}>
                  <input
                    type="text"
                    value={g.firstName}
                    onChange={(e) => updateGuest(idx, { firstName: e.target.value })}
                    className={inputCls}
                  />
                </Field>
                <Field label="Last name" optional>
                  <input
                    type="text"
                    value={g.lastName}
                    onChange={(e) => updateGuest(idx, { lastName: e.target.value })}
                    className={inputCls}
                  />
                </Field>
                <button
                  type="button"
                  onClick={() => removeGuest(idx)}
                  className="h-9 w-7 flex items-center justify-center text-gray-400 hover:text-red-500 transition-colors"
                  title="Remove this guest"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="-mt-1 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={addGuest}
            className="text-xs font-medium text-indigo-600 hover:text-indigo-800 flex items-center gap-1"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add guest
          </button>
          {form.additionalGuests.length > 0 && (
            <p className="text-[11px] text-gray-400 text-right">
              Saved on the Beds24 booking and printed on the invoice.
            </p>
          )}
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

        {/* Nationality — mandatory. The server turns it into Beds24's
            `country` + `lang`; `lang` is what selects the template language
            for auto-actions, so leaving it unset made every automated guest
            message go out in English. Same country→language mapping the
            rental-site checkout uses. */}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Nationality">
            <select
              required
              value={form.nationality}
              onChange={(e) => set("nationality", e.target.value)}
              className={inputCls}
            >
              <option value="">Select country…</option>
              {COUNTRY_OPTIONS.map((c) => (
                <option key={c.code} value={c.code}>{c.name}</option>
              ))}
            </select>
          </Field>
          <div className="flex items-end">
            <p className="text-[11px] text-gray-500 leading-snug pb-2">
              {form.nationality
                ? `Beds24 will send automated guest messages in ${languageNameForCountry(form.nationality)}.`
                : "Sets the guest country in Beds24 and the language of its automated messages."}
            </p>
          </div>
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

        {/* Invoice info — for bookings the customer pays by invoice */}
        <button
          type="button"
          onClick={toggleInvoice}
          className="flex items-center gap-2 text-xs font-medium text-gray-600 hover:text-gray-900"
        >
          <Switch on={invoiceOn} />
          Add invoice info
        </button>

        {invoiceOn && (
          <div className="pl-4 ml-2 border-l-2 border-indigo-100 space-y-3">
            <Field label="Company name">
              <input
                type="text"
                value={invoiceData.companyName}
                onChange={(e) => setInvoiceField('companyName', e.target.value)}
                placeholder="Acme s.r.o."
                className={inputCls}
              />
            </Field>
            <Field label="Company address" optional>
              <input
                type="text"
                value={invoiceData.companyAddress}
                onChange={(e) => setInvoiceField('companyAddress', e.target.value)}
                placeholder="Šumavská 10, 602 00 Brno"
                className={inputCls}
              />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="IČO">
                <input
                  type="text"
                  value={invoiceData.ico}
                  onChange={(e) => setInvoiceField('ico', e.target.value)}
                  placeholder="19876107"
                  className={inputCls}
                />
              </Field>
              <Field label="DIČ / VAT">
                <input
                  type="text"
                  value={invoiceData.vatNumber}
                  onChange={(e) => setInvoiceField('vatNumber', e.target.value)}
                  placeholder="CZ19876107"
                  className={inputCls}
                />
              </Field>
              <Field label="Billing email">
                <input
                  type="email"
                  value={invoiceData.billingEmail}
                  onChange={(e) => setInvoiceField('billingEmail', e.target.value)}
                  placeholder="accounting@acme.cz"
                  className={inputCls}
                />
              </Field>
            </div>
            {!sendInvoice && (
              <p className="text-[11px] text-gray-400">
                Saved on the reservation — the invoice is ready to issue from the drawer. To send it from here, turn on Send invoice below.
              </p>
            )}
          </div>
        )}

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
          <Switch on={includePaymentLink} />
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
              <Switch on={splitPayment} />
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

        {/* Send invoice — needs the invoice info above */}
        {invoiceOn && (
          <>
            <button
              type="button"
              onClick={() => setSendInvoice((v) => !v)}
              className="flex items-center gap-2 text-xs font-medium text-gray-600 hover:text-gray-900"
            >
              <Switch on={sendInvoice} />
              Send invoice
            </button>

            {sendInvoice && (
              <div className="pl-4 ml-2 border-l-2 border-indigo-100 space-y-3">
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
                    <input
                      type="radio"
                      name="invoice-timing"
                      checked={invoiceTiming === 'now'}
                      onChange={() => chooseInvoiceTiming('now')}
                      className="accent-indigo-600"
                    />
                    Issue &amp; send now
                    <span className="text-gray-400">— emailed right after the booking is created</span>
                  </label>
                  <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
                    <input
                      type="radio"
                      name="invoice-timing"
                      checked={invoiceTiming === 'schedule'}
                      onChange={() => chooseInvoiceTiming('schedule')}
                      className="accent-indigo-600"
                    />
                    Schedule for
                    <input
                      type="date"
                      value={invoiceSendDate}
                      min={addDays(todayLocal(), 1)}
                      onChange={(e) => { setInvoiceSendDate(e.target.value); setInvoiceTiming('schedule'); }}
                      className="rounded-md border border-gray-200 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-300"
                    />
                  </label>
                  {invoiceTiming === 'schedule' && (
                    <p className="text-[11px] text-gray-400 pl-5">
                      Goes out with the morning invoice run (≈ 10–11:00) on that day. Until then it shows as a Send-invoice task on the reservation.
                    </p>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => setInvoicePaymentDetails((v) => !v)}
                  className="flex items-center gap-2 text-xs font-medium text-gray-600 hover:text-gray-900"
                >
                  <Switch on={invoicePaymentDetails} />
                  Include payment details
                  <span className="font-normal text-gray-400">— bank account, VS and QR code</span>
                </button>
                {includePaymentLink && invoicePaymentDetails && (
                  <p className="text-[11px] text-amber-700">
                    The guest also gets a Stripe payment link — with bank details on the invoice they could pay twice.
                  </p>
                )}

                {invoiceProblem && (
                  <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                    {invoiceProblem}
                  </p>
                )}
              </div>
            )}
          </>
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
            disabled={submitting}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting
              ? (progress ?? "Creating…")
              : includePaymentLink
                ? "Create & Get Link"
                : delivery === 'now'
                  ? "Create & Send Invoice"
                  : "Create Booking"}
          </button>
        </div>
      </form>
    </FloatingPanel>
  );
}

// ── Availability list ────────────────────────────────────────────────────────

function AvailabilityList({
  result,
  stale,
  usedRoomIds,
  targetRow,
  noOccupancyData,
  onUse,
}: {
  result: AvailabilityResult;
  /** Dates or guests changed since the list was built. */
  stale: boolean;
  /** roomIds the unit rows currently book — highlighted. */
  usedRoomIds: Set<number>;
  /** 1-based row "Use" fills (the last one). */
  targetRow: number;
  noOccupancyData: boolean;
  onUse: (roomId: number, perUnitPrice: number | null) => void;
}) {
  const { nights, party, types } = result;
  return (
    <div className={`rounded-xl border border-gray-200 p-2.5 space-y-2 ${stale ? 'opacity-60' : ''}`}>
      <div className="flex items-center justify-between gap-2 px-1">
        <p className="text-[11px] text-gray-500">
          {nights} night{nights === 1 ? '' : 's'} · {party} guest{party === 1 ? '' : 's'} · Beds24 web rate per apartment
        </p>
        {targetRow > 1 && !stale && (
          <p className="text-[11px] text-indigo-600 shrink-0">Use fills unit row {targetRow}</p>
        )}
      </div>

      {stale && (
        <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          Dates or guests changed since this list was made — check again.
        </p>
      )}
      {result.pricingError && (
        <p className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
          Beds24 prices didn&apos;t fully load ({result.pricingError}) — type in any price that&apos;s missing. Free units come from the reservations on screen.
        </p>
      )}
      {noOccupancyData && (
        <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          No reservations loaded, so every unit reads as free — rely on the Beds24 prices only.
        </p>
      )}

      {types.map((t) => (
        <TypeCard
          key={t.roomId}
          t={t}
          nights={nights}
          party={party}
          stale={stale}
          usedRoomIds={usedRoomIds}
          onUse={onUse}
        />
      ))}
    </div>
  );
}

function TypeCard({
  t,
  nights,
  party,
  stale,
  usedRoomIds,
  onUse,
}: {
  t: QuotedType;
  nights: number;
  party: number;
  stale: boolean;
  usedRoomIds: Set<number>;
  onUse: (roomId: number, perUnitPrice: number | null) => void;
}) {
  const label = SELLING_UNIT_BY_ROOM_ID[t.roomId]?.label ?? t.label;
  const multiUnit = t.units.length > 1;
  const free = effectiveFreeUnits(t);
  // Beds24 quoting it is proof it can sell it, even when the list on screen
  // is a sync behind and still shows the unit taken.
  const bookable = free > 0 || t.source === 'offer';
  const inUse = usedRoomIds.has(t.roomId) || t.units.some((u) => usedRoomIds.has(u.roomId));
  const singleUnit = t.units[0];

  let status: string;
  if (multiUnit) {
    status = `${t.freeUnits} of ${t.units.length} free`;
    if (t.unallocated > 0) {
      status += ` · ${t.unallocated} unassigned booking${t.unallocated === 1 ? '' : 's'} will take ${t.unallocated === 1 ? 'one' : 'some'}`;
    }
  } else {
    status = singleUnit.free ? 'Free' : `Booked — ${singleUnit.heldBy ?? 'unknown'}`;
  }
  if (free === 0 && t.source === 'offer') status += ' · Beds24 still sells it — refresh Transactions';

  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        inUse
          ? 'border-indigo-300 bg-indigo-50/70'
          : bookable
            ? 'border-emerald-200 bg-emerald-50/50'
            : 'border-gray-200 bg-gray-50'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={`text-sm font-medium ${bookable ? 'text-gray-900' : 'text-gray-500'}`}>
            {label}
            <span className="ml-1.5 text-[11px] font-normal text-gray-400">sleeps {t.sleeps}</span>
          </p>
          <p className={`text-[11px] ${bookable ? 'text-gray-500' : 'text-gray-400'}`}>{status}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="text-right">
            {t.price != null && bookable ? (
              <>
                <p
                  className={`text-sm font-semibold ${t.source === 'estimate' ? 'text-amber-700' : 'text-emerald-700'}`}
                  title={t.source === 'estimate'
                    ? "Beds24 won't sell this stay on the web (min-stay, advance or check-in rule), so this is rebuilt from the daily rates. A manual booking can still take it."
                    : 'Beds24 web rate for one apartment, whole stay'}
                >
                  {t.source === 'estimate' ? '≈ ' : ''}{formatCZK(t.price)}
                </p>
                {nights > 0 && (
                  <p className="text-[10px] text-gray-400">
                    {formatCZK(t.price / nights)} / night{t.source === 'estimate' ? ' · est.' : ''}
                  </p>
                )}
              </>
            ) : (
              <p className="text-xs text-gray-400">{bookable ? 'No web rate' : 'Booked'}</p>
            )}
          </div>
          <button
            type="button"
            disabled={!bookable || stale}
            onClick={() => onUse(t.roomId, t.price)}
            title={bookable ? `Book ${label}${t.price != null ? ` at ${formatCZK(t.price)}` : ''}` : 'No free unit for these dates'}
            className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              usedRoomIds.has(t.roomId)
                ? 'bg-indigo-600 text-white'
                : 'bg-white border border-indigo-300 text-indigo-700 hover:bg-indigo-50'
            }`}
          >
            {usedRoomIds.has(t.roomId) ? '✓ Used' : 'Use'}
          </button>
        </div>
      </div>

      {/* Physical units — a free one can be forced for this booking */}
      {multiUnit && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-gray-400 mr-0.5">Force</span>
          {t.units.map((u) => (
            <UnitChip
              key={u.room}
              u={u}
              stale={stale}
              inUse={usedRoomIds.has(u.roomId)}
              onPick={() => onUse(u.roomId, t.price)}
            />
          ))}
        </div>
      )}

      {party > t.sleeps && bookable && (
        <p className="mt-1.5 text-[11px] text-amber-700">
          Sleeps {t.sleeps} — {party} guests need {Math.ceil(party / t.sleeps)} of these (add another unit). Price is per apartment.
        </p>
      )}
    </div>
  );
}

function UnitChip({
  u,
  stale,
  inUse,
  onPick,
}: {
  u: UnitAvailability;
  stale: boolean;
  inUse: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!u.free || stale}
      onClick={onPick}
      title={
        u.free
          ? `Book ${u.room} specifically (force physical room)`
          : u.heldBy?.startsWith('Blocked')
            ? `${u.heldBy} on these dates`
            : `Held by ${u.heldBy ?? 'another booking'} on these dates`
      }
      className={`px-2 py-0.5 rounded-md border text-[11px] font-medium transition-colors ${
        inUse
          ? 'border-indigo-400 bg-indigo-100 text-indigo-800'
          : u.free
            ? 'border-emerald-300 bg-white text-emerald-800 hover:bg-emerald-50'
            : 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'
      }`}
    >
      {u.room}
      {!u.free && <span className="font-normal"> · {shortHolder(u.heldBy)}</span>}
    </button>
  );
}

// ── Invoice outcome (result step) ────────────────────────────────────────────

function InvoiceOutcomeCard({ outcome }: { outcome: InvoiceOutcome }) {
  if (outcome.kind === 'error') {
    return (
      <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 space-y-1">
        <p className="font-medium">Invoice not sent</p>
        <p className="text-xs">{outcome.message}</p>
        {!outcome.saved && (
          <p className="text-xs">The booking itself is fine — add the invoice in the reservation drawer. Don&apos;t re-create the booking.</p>
        )}
      </div>
    );
  }
  if (outcome.kind === 'saved') {
    return (
      <p className="text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
        Invoice details saved — issue the invoice from the reservation drawer when you&apos;re ready.
      </p>
    );
  }
  if (outcome.kind === 'scheduled') {
    return (
      <div className="text-sm text-indigo-800 bg-indigo-50 border border-indigo-200 rounded-lg px-3 py-2 space-y-0.5">
        <p className="font-medium">Invoice scheduled for {formatDay(outcome.sendDate)}</p>
        <p className="text-xs">
          Emailed to {outcome.to} by the morning invoice run{outcome.withPaymentDetails ? ', with payment details' : ''}.
          It shows as a Send-invoice task on the reservation until then.
        </p>
      </div>
    );
  }
  const deferred = outcome.kind === 'deferred';
  return (
    <div
      className={`text-sm rounded-lg px-3 py-2 space-y-1 border ${
        deferred ? 'text-amber-800 bg-amber-50 border-amber-200' : 'text-green-800 bg-green-50 border-green-200'
      }`}
    >
      <p className="font-medium">
        {deferred ? 'Invoice handed to the mail server' : 'Invoice sent'}
        {outcome.invoiceNumber ? ` — ${outcome.invoiceNumber}` : ''}
      </p>
      <p className="text-xs">
        To {outcome.to}{outcome.withPaymentDetails ? ', with payment details' : ''}.
        {deferred && ' Gmail deferred the acknowledgement, so delivery is unconfirmed — check the Sent folder before re-sending.'}
      </p>
      {!outcome.statusSaved && (
        <p className="text-xs text-amber-800">
          It went out, but its &quot;Sent&quot; status couldn&apos;t be saved, so the drawer may still show it as not issued — don&apos;t send it again.
        </p>
      )}
      {outcome.revenueRecorded === false && (
        <p className="text-xs text-amber-800">
          The revenue record for accounting wasn&apos;t created — add it in Accounting → Revenue so the bank payment can be matched.
        </p>
      )}
    </div>
  );
}

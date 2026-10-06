'use client';
/**
 * New corporate agreement — three steps.
 *
 *   1. Form     — company, billing, contacts, default guest, suitable room
 *                 types, the night pattern, pricing. A live line shows how
 *                 many stays / nights the pattern produces as it is typed.
 *   2. Preview  — every stay the pattern implies: dates, nights, room type
 *                 (planner's pick, editable), availability verdict from the
 *                 same solver the Transactions room panel uses, price
 *                 (flat × nights, or Beds24 web price − discount, editable),
 *                 optional per-stay guest, include/exclude.
 *   3. Result   — what Beds24 said, stay by stay.
 *
 * Availability is advisory: it is computed here from the reservations on the
 * dashboard, exactly like Stay Request. The real guard is Beds24's own
 * availability check when the bookings are created — a stay that looks free
 * but is refused comes back as Failed with the reason.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Reservation } from '@/types/reservation';
import { COUNTRY_OPTIONS } from '@/utils/countries';
import { pragueToday } from '@/utils/periodUtils';
import { SELLABLE_UNITS } from '@/utils/stayRequest';
import { describeAlternatives, evaluateAvailability, type Availability } from '@/utils/corporateAvailability';
import { computeStayPrice, describeNights, generateStays, validateSchedule, type StayOccurrence } from '@/utils/corporateSchedule';
import {
  BILLING_CADENCE_LABELS,
  ISO_WEEKDAYS,
  formatCzk,
  formatStayDate,
  formatStayRange,
  type AgreementDetail,
  type BillingCadence,
  type PricingMode,
  type StayPriceSource,
} from '@/utils/corporateShared';
import { Field, RoomTypeOptions, inputCls, roomShortLabel, smallInputCls, splitGuestName } from './ui';
import { downloadOfferPdf, type OfferPayload } from './offer';

// ─── State shapes ────────────────────────────────────────────────────────────

interface FormState {
  companyName: string;
  companyAddress: string;
  ico: string;
  vatNumber: string;
  billingEmail: string;
  billingCadence: BillingCadence;
  repName: string;
  repPhone: string;
  repEmail: string;
  guestFirstName: string;
  guestLastName: string;
  guestPhone: string;
  guestEmail: string;
  adults: string;
  children: string;
  nationality: string;
  roomIds: number[];
  preferredRoomId: number;
  startDate: string;
  endDate: string;
  nightWeekdays: number[];
  pricingMode: PricingMode;
  flatNightPrice: string;
  discountPercent: string;
  notes: string;
}

const DEFAULT_FORM: FormState = {
  companyName: '',
  companyAddress: '',
  ico: '',
  vatNumber: '',
  billingEmail: '',
  billingCadence: 'per_stay',
  repName: '',
  repPhone: '',
  repEmail: '',
  guestFirstName: '',
  guestLastName: '',
  guestPhone: '',
  guestEmail: '',
  adults: '1',
  children: '0',
  nationality: 'CZ',
  // The two studio types — what a single business traveller is normally offered.
  roomIds: [679714, 648816],
  preferredRoomId: 679714,
  startDate: '',
  endDate: '',
  nightWeekdays: [1, 2],
  pricingMode: 'dynamic',
  flatNightPrice: '',
  discountPercent: '0',
  notes: '',
};


interface PreviewRow extends StayOccurrence {
  include: boolean;
  roomId: number;
  availability: Availability;
  listPriceCzk: number | null;
  quoteSource: 'offers' | 'calendar-nominal' | 'none' | null;
  quoteError: string | null;
  /** Raw input — what the operator sees and may edit. */
  price: string;
  /** The operator typed the price; re-quotes must not overwrite it. */
  priceTouched: boolean;
  guestName: string;
}

interface CreateOutcome {
  stayId: string;
  seq: number;
  arrival: string;
  departure: string;
  roomId: number;
  ok: boolean;
  reservationNumber: string | null;
  error: string | null;
}

type Step = 'form' | 'preview' | 'result';

const toInt = (s: string, fallback: number) => {
  const n = Number(s);
  return Number.isInteger(n) ? n : fallback;
};
const toNum = (s: string): number | null => {
  const t = s.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

// ─── Availability chip (logic lives in utils/corporateAvailability.ts) ──────

function AvailabilityChip({ a }: { a: Availability }) {
  switch (a.kind) {
    case 'free':
      return <span className="inline-flex rounded px-1.5 py-0.5 text-[11px] bg-green-100 text-green-800">Free · {a.unit}</span>;
    case 'shuffle':
      return (
        <div className="space-y-0.5">
          <span
            className="inline-flex rounded px-1.5 py-0.5 text-[11px] bg-amber-100 text-amber-800"
            title="Fits only if other not-yet-arrived guests are moved between units of the same type. Beds24 may leave this booking unassigned; the Transactions room panel resolves it."
          >
            Needs shuffle · {a.unit} ({a.moves} move{a.moves === 1 ? '' : 's'})
          </span>
          {a.alternatives.length > 0 && (
            <div className="text-[10px] text-green-700 max-w-[240px] whitespace-normal">
              Free without moves: {describeAlternatives(a.alternatives)}
            </div>
          )}
        </div>
      );
    case 'blocked': {
      const free = a.alternatives.filter((x) => x.moves === 0);
      const shuffled = a.alternatives.filter((x) => x.moves > 0);
      return (
        <div className="space-y-0.5">
          <span className="inline-flex rounded px-1.5 py-0.5 text-[11px] bg-red-100 text-red-700" title={a.note}>
            Blocked in agreed types
          </span>
          {free.length > 0 ? (
            <div className="text-[10px] text-green-700 max-w-[240px] whitespace-normal">Vacancy: {describeAlternatives(free)}</div>
          ) : shuffled.length > 0 ? (
            <div className="text-[10px] text-amber-700 max-w-[240px] whitespace-normal">
              Vacancy after a shuffle: {describeAlternatives(shuffled)}
            </div>
          ) : (
            <div className="text-[10px] text-red-600 max-w-[240px] whitespace-normal">No apartment is free for these dates</div>
          )}
        </div>
      );
    }
    case 'past':
      return <span className="inline-flex rounded px-1.5 py-0.5 text-[11px] bg-gray-100 text-gray-500">In the past</span>;
    default:
      return <span className="inline-flex rounded px-1.5 py-0.5 text-[11px] bg-gray-100 text-gray-500">—</span>;
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function NewAgreementModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (agreement: AgreementDetail) => void;
}) {
  const today = pragueToday();
  const [step, setStep] = useState<Step>('form');
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [formError, setFormError] = useState<string | null>(null);

  const [reservations, setReservations] = useState<Reservation[] | null>(null);
  const [reservationsError, setReservationsError] = useState<string | null>(null);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [quoting, setQuoting] = useState(false);
  const [quoteNote, setQuoteNote] = useState<string | null>(null);
  const [saving, setSaving] = useState<'draft' | 'create' | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [offerBusy, setOfferBusy] = useState(false);

  const [result, setResult] = useState<{ agreement: AgreementDetail; outcomes: CreateOutcome[]; createError: string | null } | null>(null);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((p) => ({ ...p, [k]: v }));

  const guests = toInt(form.adults, 1) + toInt(form.children, 0);
  const flatRate = toNum(form.flatNightPrice);
  const discount = toNum(form.discountPercent) ?? 0;

  // ── Live schedule line ──
  const scheduleProblem = validateSchedule({ startDate: form.startDate, endDate: form.endDate, nightWeekdays: form.nightWeekdays });
  const occurrences = useMemo<StayOccurrence[] | null>(() => {
    if (scheduleProblem) return null;
    try {
      return generateStays({ startDate: form.startDate, endDate: form.endDate, nightWeekdays: form.nightWeekdays });
    } catch {
      return null;
    }
  }, [form.startDate, form.endDate, form.nightWeekdays, scheduleProblem]);

  const liveNights = occurrences?.reduce((n, o) => n + o.nights, 0) ?? 0;

  // ── Step 1 → 2 ──
  function validateForm(): string | null {
    if (!form.companyName.trim()) return 'Company name is required';
    if (form.roomIds.length === 0) return 'Pick at least one suitable room type';
    if (scheduleProblem) return scheduleProblem;
    if (!occurrences || occurrences.length === 0) return 'This pattern produces no stays between the two dates';
    const adults = toInt(form.adults, 0);
    if (adults < 1) return 'At least one adult';
    if (form.pricingMode === 'flat' && (flatRate === null || flatRate <= 0)) return 'Flat pricing needs a nightly price above 0';
    if (form.pricingMode === 'dynamic' && (discount < 0 || discount > 100)) return 'Discount must be between 0 and 100';
    return null;
  }

  const buildRows = useCallback(
    (occs: StayOccurrence[], res: Reservation[] | null, previous: PreviewRow[] = []): PreviewRow[] => {
      const prevBySeq = new Map(previous.map((r) => [r.seq, r]));
      return occs.map((occ) => {
        const prev = prevBySeq.get(occ.seq);
        const picked = evaluateAvailability(res, occ, form.roomIds, form.preferredRoomId, guests, today);
        const roomId = prev?.roomId ?? picked.roomId;
        // Operator chose a room themselves → judge THAT room, not the planner's pick.
        const availability =
          prev && prev.roomId !== picked.roomId
            ? evaluateAvailability(res, occ, [prev.roomId], prev.roomId, guests, today).availability
            : picked.availability;
        const flatPrice = computeStayPrice({ mode: 'flat', nights: occ.nights, flatNightPriceCzk: flatRate });
        return {
          ...occ,
          include: prev?.include ?? availability.kind !== 'past',
          roomId,
          availability,
          listPriceCzk: prev?.listPriceCzk ?? null,
          quoteSource: prev?.quoteSource ?? null,
          quoteError: prev?.quoteError ?? null,
          price: prev?.price ?? (form.pricingMode === 'flat' && flatPrice !== null ? String(flatPrice) : ''),
          priceTouched: prev?.priceTouched ?? false,
          guestName: prev?.guestName ?? '',
        };
      });
    },
    [form.roomIds, form.preferredRoomId, form.pricingMode, guests, flatRate, today],
  );

  const quoteRows = useCallback(
    async (current: PreviewRow[]) => {
      const targets = current.filter((r) => r.include);
      if (targets.length === 0) return;
      setQuoting(true);
      setQuoteNote(null);
      try {
        const res = await fetch('/api/corporate/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            adults: toInt(form.adults, 1),
            children: toInt(form.children, 0),
            segments: targets.map((r) => ({ roomId: r.roomId, from: r.arrival, to: r.departure })),
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        const quoted = (json.segments ?? []) as { price: number | null; source: 'offers' | 'calendar-nominal' | 'none'; error?: string }[];
        setRows((prev) =>
          prev.map((r) => {
            const idx = targets.findIndex((t) => t.seq === r.seq);
            if (idx === -1) return r;
            const q = quoted[idx];
            if (!q) return r;
            const computed = computeStayPrice({ mode: 'dynamic', nights: r.nights, listPriceCzk: q.price, discountPercent: discount });
            return {
              ...r,
              listPriceCzk: q.price,
              quoteSource: q.source,
              quoteError: q.error ?? null,
              price: r.priceTouched ? r.price : computed === null ? '' : String(computed),
            };
          }),
        );
        const missing = quoted.filter((q) => q.price === null).length;
        const nominal = quoted.filter((q) => q.source === 'calendar-nominal').length;
        setQuoteNote(
          [
            missing > 0 ? `${missing} stay${missing === 1 ? '' : 's'} could not be priced by Beds24 — type a price or exclude them.` : null,
            nominal > 0 ? `${nominal} price${nominal === 1 ? ' is' : 's are'} nominal (no live offer for those dates).` : null,
          ]
            .filter(Boolean)
            .join(' ') || null,
        );
      } catch (e) {
        setQuoteNote(`Beds24 pricing unavailable: ${(e as Error).message}. Enter prices by hand.`);
      } finally {
        setQuoting(false);
      }
    },
    [form.adults, form.children, discount],
  );

  const reservationsRequested = useRef(false);

  async function goToPreview() {
    const problem = validateForm();
    if (problem) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    const occs = occurrences!;
    // Rows first (with whatever we know), then refine as the dashboard data lands.
    const initial = buildRows(occs, reservations);
    setRows(initial);
    setStep('preview');

    if (!reservationsRequested.current) {
      reservationsRequested.current = true;
      try {
        const res = await fetch('/api/bookings');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: Reservation[] = await res.json();
        setReservations(data);
        setRows((prev) => buildRows(occs, data, prev));
        if (form.pricingMode === 'dynamic') void quoteRows(buildRows(occs, data, initial));
      } catch (e) {
        setReservationsError(`Could not load the dashboard reservations (${(e as Error).message}) — availability unknown; Beds24 will still refuse unavailable stays.`);
        if (form.pricingMode === 'dynamic') void quoteRows(initial);
      }
    } else if (form.pricingMode === 'dynamic') {
      void quoteRows(initial);
    }
  }

  // When the room of a row changes, re-judge availability for that room.
  function setRowRoom(seq: number, roomId: number) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.seq !== seq) return r;
        const { availability } = evaluateAvailability(reservations, r, [roomId], roomId, guests, today);
        return { ...r, roomId, availability, listPriceCzk: null, quoteSource: null, quoteError: null, price: r.priceTouched ? r.price : form.pricingMode === 'flat' ? r.price : '' };
      }),
    );
  }

  // ── Summary ──
  const included = rows.filter((r) => r.include);
  const prices = included.map((r) => toNum(r.price));
  const allPriced = prices.every((p) => p !== null && p > 0);
  const total = prices.reduce<number>((s, p) => s + (p ?? 0), 0);
  const totalNights = included.reduce((n, r) => n + r.nights, 0);
  /** Average over the PRICED included stays — an unpriced row must not drag the average down. */
  const pricedNights = included.reduce((n, r, i) => n + (prices[i] !== null ? r.nights : 0), 0);
  const avgNight = pricedNights > 0 ? total / pricedNights : null;
  /** Included stays the agreed types cannot host — the operator's to-do list. */
  const blockedRows = rows.filter((r) => r.include && r.availability.kind === 'blocked');

  function offerPayload(): OfferPayload {
    return {
      companyName: form.companyName,
      companyAddress: form.companyAddress.trim() || null,
      ico: form.ico.trim() || null,
      vatNumber: form.vatNumber.trim() || null,
      contactName: form.repName.trim() || null,
      contactPhone: form.repPhone.trim() || null,
      contactEmail: form.repEmail.trim() || form.billingEmail.trim() || null,
      startDate: form.startDate,
      endDate: form.endDate,
      nightWeekdays: form.nightWeekdays,
      roomIds: form.roomIds,
      adults: toInt(form.adults, 1),
      children: toInt(form.children, 0),
      pricingMode: form.pricingMode,
      flatNightPriceCzk: flatRate,
      discountPercent: discount,
      billingCadence: form.billingCadence,
      notes: form.notes.trim() || null,
      stays: included.map((r) => ({ seq: r.seq, arrival: r.arrival, departure: r.departure, nights: r.nights, roomId: r.roomId, priceCzk: toNum(r.price) })),
    };
  }

  async function downloadOffer() {
    setOfferBusy(true);
    setSaveError(null);
    try {
      await downloadOfferPdf(offerPayload());
    } catch (e) {
      setSaveError(`Offer PDF failed: ${(e as Error).message}`);
    } finally {
      setOfferBusy(false);
    }
  }
  const distinct = Array.from(new Set(prices.filter((p): p is number => p !== null)));
  const perStayLabel =
    distinct.length === 0
      ? '—'
      : distinct.length === 1
        ? formatCzk(distinct[0])
        : `${formatCzk(Math.min(...distinct))} – ${formatCzk(Math.max(...distinct))} (avg ${formatCzk(total / (included.length || 1))})`;

  // ── Save ──
  async function save(createNow: boolean) {
    setSaving(createNow ? 'create' : 'draft');
    setSaveError(null);
    try {
      const body = {
        companyName: form.companyName,
        companyAddress: form.companyAddress,
        ico: form.ico,
        vatNumber: form.vatNumber,
        billingEmail: form.billingEmail,
        billingCadence: form.billingCadence,
        repName: form.repName,
        repPhone: form.repPhone,
        repEmail: form.repEmail,
        guestFirstName: form.guestFirstName,
        guestLastName: form.guestLastName,
        guestPhone: form.guestPhone,
        guestEmail: form.guestEmail,
        adults: toInt(form.adults, 1),
        children: toInt(form.children, 0),
        nationality: form.nationality,
        roomIds: form.roomIds,
        preferredRoomId: form.preferredRoomId,
        startDate: form.startDate,
        endDate: form.endDate,
        nightWeekdays: form.nightWeekdays,
        pricingMode: form.pricingMode,
        flatNightPriceCzk: flatRate,
        discountPercent: discount,
        notes: form.notes,
        stays: rows.map((r) => {
          const { first, last } = splitGuestName(r.guestName);
          let priceSource: StayPriceSource | null = null;
          if (r.priceTouched) priceSource = 'manual';
          else if (form.pricingMode === 'flat') priceSource = 'flat';
          else if (r.quoteSource === 'offers' || r.quoteSource === 'calendar-nominal') priceSource = r.quoteSource;
          return {
            seq: r.seq,
            roomId: r.roomId,
            priceCzk: toNum(r.price),
            listPriceCzk: r.listPriceCzk,
            priceSource,
            guestFirstName: first,
            guestLastName: last,
            include: r.include,
          };
        }),
      };
      const res = await fetch('/api/corporate/agreements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      let agreement: AgreementDetail = json.agreement;

      let outcomes: CreateOutcome[] = [];
      let createError: string | null = null;
      if (createNow) {
        const ids = agreement.stays.filter((s) => s.status === 'planned' && (s.priceCzk ?? 0) > 0).map((s) => s.id);
        if (ids.length > 0) {
          const cres = await fetch(`/api/corporate/agreements/${encodeURIComponent(agreement.id)}/create-bookings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stayIds: ids }),
          });
          const cjson = await cres.json().catch(() => ({}));
          if (!cres.ok) {
            createError = cjson.error ?? `HTTP ${cres.status}`;
          } else {
            outcomes = cjson.results ?? [];
            agreement = cjson.agreement ?? agreement;
            // Let Transactions pick the new bookings up on its next load.
            void fetch('/api/bookings?fullSync=true').catch(() => {});
          }
        }
      }
      setResult({ agreement, outcomes, createError });
      setStep('result');
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(null);
    }
  }

  // Escape closes (not while saving).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-3 sm:p-6 overflow-y-auto" onClick={() => !saving && onClose()}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-6xl my-4" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              {step === 'form' ? 'New corporate agreement' : step === 'preview' ? 'Preview the stays' : 'Bookings created'}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {step === 'form'
                ? 'Who is staying, when, in what, and at what price. Nothing is created until you confirm the preview.'
                : step === 'preview'
                  ? 'Check every stay, adjust rooms and prices, untick what should not be booked — then create them in Beds24.'
                  : 'Each stay below is now a direct booking in Beds24, or says why not.'}
            </p>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-gray-400">
            {(['form', 'preview', 'result'] as Step[]).map((s, i) => (
              <span key={s} className={`px-2 py-0.5 rounded-full ${step === s ? 'bg-indigo-600 text-white' : 'bg-gray-100'}`}>
                {i + 1}
              </span>
            ))}
            <button onClick={onClose} disabled={!!saving} className="ml-2 text-gray-400 hover:text-gray-600 text-base" title="Close">
              ✕
            </button>
          </div>
        </div>

        {/* ── Step 1: form ── */}
        {step === 'form' && (
          <div className="p-5 space-y-6">
            <Section title="Company & invoicing">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <Field label="Company name">
                  <input className={inputCls} value={form.companyName} onChange={(e) => set('companyName', e.target.value)} autoFocus />
                </Field>
                <Field label="Address" optional>
                  <input className={inputCls} value={form.companyAddress} onChange={(e) => set('companyAddress', e.target.value)} />
                </Field>
                <Field label="Invoice email" optional hint="Where invoices for these stays go.">
                  <input className={inputCls} type="email" value={form.billingEmail} onChange={(e) => set('billingEmail', e.target.value)} />
                </Field>
                <Field label="IČO" optional>
                  <input className={inputCls} value={form.ico} onChange={(e) => set('ico', e.target.value)} />
                </Field>
                <Field label="DIČ / VAT number" optional>
                  <input className={inputCls} value={form.vatNumber} onChange={(e) => set('vatNumber', e.target.value)} />
                </Field>
                <Field label="Invoicing rhythm" hint="Stored for the invoice automation; invoices are still sent by hand for now.">
                  <select className={inputCls} value={form.billingCadence} onChange={(e) => set('billingCadence', e.target.value as BillingCadence)}>
                    {Object.entries(BILLING_CADENCE_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </Section>

            <Section title="People">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <Field label="Company contact — name" optional>
                  <input className={inputCls} value={form.repName} onChange={(e) => set('repName', e.target.value)} />
                </Field>
                <Field label="Company contact — phone" optional>
                  <input className={inputCls} value={form.repPhone} onChange={(e) => set('repPhone', e.target.value)} placeholder="+420 …" />
                </Field>
                <Field label="Company contact — email" optional>
                  <input className={inputCls} type="email" value={form.repEmail} onChange={(e) => set('repEmail', e.target.value)} />
                </Field>
                <Field label="Guest first name" optional hint="Default for every stay — each stay can have its own guest, now or later.">
                  <input className={inputCls} value={form.guestFirstName} onChange={(e) => set('guestFirstName', e.target.value)} />
                </Field>
                <Field label="Guest last name" optional>
                  <input className={inputCls} value={form.guestLastName} onChange={(e) => set('guestLastName', e.target.value)} />
                </Field>
                <Field label="Guest phone" optional hint="Falls back to the company contact's phone.">
                  <input className={inputCls} value={form.guestPhone} onChange={(e) => set('guestPhone', e.target.value)} placeholder="+420 …" />
                </Field>
                <Field label="Guest email" optional hint="Receives Beds24's automatic guest messages. Leave empty to send none.">
                  <input className={inputCls} type="email" value={form.guestEmail} onChange={(e) => set('guestEmail', e.target.value)} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Adults">
                    <input className={inputCls} type="number" min={1} max={10} value={form.adults} onChange={(e) => set('adults', e.target.value)} />
                  </Field>
                  <Field label="Children">
                    <input className={inputCls} type="number" min={0} max={10} value={form.children} onChange={(e) => set('children', e.target.value)} />
                  </Field>
                </div>
                <Field label="Guest nationality" hint="Sets the language of Beds24's messages.">
                  <select className={inputCls} value={form.nationality} onChange={(e) => set('nationality', e.target.value)}>
                    {COUNTRY_OPTIONS.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </Section>

            <Section title="Suitable room types">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {SELLABLE_UNITS.map((u) => {
                  const checked = form.roomIds.includes(u.roomId);
                  const tooSmall = guests > u.sleeps;
                  return (
                    <label
                      key={u.roomId}
                      className={`flex items-start gap-3 rounded-lg border px-3 py-2 cursor-pointer ${
                        checked ? 'border-indigo-300 bg-indigo-50/40' : 'border-gray-200 hover:bg-gray-50'
                      } ${tooSmall ? 'opacity-60' : ''}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={checked}
                        onChange={(e) => {
                          const next = e.target.checked ? [...form.roomIds, u.roomId] : form.roomIds.filter((id) => id !== u.roomId);
                          // Keep the canonical order so the list reads the same everywhere.
                          const ordered = SELLABLE_UNITS.map((s) => s.roomId).filter((id) => next.includes(id));
                          setForm((p) => ({
                            ...p,
                            roomIds: ordered,
                            preferredRoomId: ordered.includes(p.preferredRoomId) ? p.preferredRoomId : (ordered[0] ?? p.preferredRoomId),
                          }));
                        }}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-gray-800">{u.label}</div>
                        <div className="text-[11px] text-gray-400">
                          sleeps {u.sleeps} · {u.units.join(', ')}
                          {tooSmall && <span className="text-amber-600"> · too small for {guests} guests</span>}
                        </div>
                      </div>
                      {checked && form.roomIds.length > 1 && (
                        <label className="flex items-center gap-1 text-[11px] text-gray-500 shrink-0" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="radio"
                            name="preferred"
                            checked={form.preferredRoomId === u.roomId}
                            onChange={() => set('preferredRoomId', u.roomId)}
                          />
                          prefer
                        </label>
                      )}
                    </label>
                  );
                })}
              </div>
              <p className="text-[11px] text-gray-400 mt-2">
                Each stay is placed in the preferred type when it is free, otherwise in another ticked type. You can change the type per stay in the preview.
              </p>
            </Section>

            <Section title="When">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Field label="First night from" hint="The pattern starts counting here (may itself be a night).">
                  <input className={inputCls} type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} />
                </Field>
                <Field label="Last night (inclusive)" hint="No night after this date is booked; checkout may be the day after.">
                  <input className={inputCls} type="date" value={form.endDate} min={form.startDate || undefined} onChange={(e) => set('endDate', e.target.value)} />
                </Field>
                <Field label="Nights of the week" hint="Consecutive nights become one stay: Mon + Tue = one Mon → Wed booking.">
                  <div className="flex flex-wrap gap-1">
                    {ISO_WEEKDAYS.map((d) => {
                      const on = form.nightWeekdays.includes(d.iso);
                      return (
                        <button
                          key={d.iso}
                          type="button"
                          onClick={() =>
                            set(
                              'nightWeekdays',
                              on ? form.nightWeekdays.filter((x) => x !== d.iso) : [...form.nightWeekdays, d.iso].sort((a, b) => a - b),
                            )
                          }
                          className={`px-2.5 py-1.5 rounded-md text-xs font-medium border ${
                            on ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          {d.short}
                        </button>
                      );
                    })}
                  </div>
                </Field>
              </div>
              <div className="mt-3 text-sm">
                {scheduleProblem ? (
                  <span className="text-gray-400">{form.startDate && form.endDate ? scheduleProblem : 'Pick the period and the nights to see how many stays this makes.'}</span>
                ) : occurrences && occurrences.length > 0 ? (
                  <span className="text-gray-700">
                    <b>{occurrences.length}</b> stay{occurrences.length === 1 ? '' : 's'} · <b>{liveNights}</b> night{liveNights === 1 ? '' : 's'} ·{' '}
                    {describeNights(form.nightWeekdays)} · first {formatStayRange(occurrences[0].arrival, occurrences[0].departure)}
                    {occurrences.length > 1 && <> · last {formatStayRange(occurrences[occurrences.length - 1].arrival, occurrences[occurrences.length - 1].departure)}</>}
                  </span>
                ) : (
                  <span className="text-amber-600">No chosen night falls between these dates.</span>
                )}
              </div>
            </Section>

            <Section title="Price">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-start">
                <div className="sm:col-span-1 space-y-2">
                  {(
                    [
                      ['dynamic', 'Dynamic — web price minus a discount', 'Each stay is priced at what the booking site would charge for those dates (a real Beds24 offer), minus the agreed percentage.'],
                      ['flat', 'Flat — fixed price per night', 'One agreed nightly rate for every stay, whatever the season.'],
                    ] as const
                  ).map(([mode, label, help]) => (
                    <label
                      key={mode}
                      className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer ${
                        form.pricingMode === mode ? 'border-indigo-300 bg-indigo-50/40' : 'border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      <input type="radio" name="pricing" className="mt-1" checked={form.pricingMode === mode} onChange={() => set('pricingMode', mode)} />
                      <span>
                        <span className="block text-sm text-gray-800">{label}</span>
                        <span className="block text-[11px] text-gray-400">{help}</span>
                      </span>
                    </label>
                  ))}
                </div>
                {form.pricingMode === 'flat' ? (
                  <Field label="Price per night (CZK)">
                    <input className={inputCls} type="number" min={0} step={1} value={form.flatNightPrice} onChange={(e) => set('flatNightPrice', e.target.value)} placeholder="e.g. 1850" />
                    {flatRate !== null && flatRate > 0 && occurrences && occurrences.length > 0 && (
                      <p className="mt-1 text-[11px] text-gray-500">
                        {formatCzk(flatRate)} × {liveNights} nights = <b>{formatCzk(flatRate * liveNights)}</b> for the whole period
                      </p>
                    )}
                  </Field>
                ) : (
                  <Field label="Discount off the web price (%)" hint="0 = the normal web price. Prices are fetched from Beds24 in the preview.">
                    <input className={inputCls} type="number" min={0} max={100} step={0.5} value={form.discountPercent} onChange={(e) => set('discountPercent', e.target.value)} />
                  </Field>
                )}
              </div>
            </Section>

            <Field label="Notes" optional hint="Internal. Also written into the Beds24 booking comments so the operator sees it there.">
              <textarea className={inputCls} rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
            </Field>

            {formError && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</div>}

            <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
              <button onClick={onClose} className="px-4 py-2 rounded-md text-sm text-gray-600 hover:bg-gray-100">
                Cancel
              </button>
              <button
                onClick={() => void goToPreview()}
                className="px-4 py-2 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium shadow-sm"
              >
                Preview {occurrences && occurrences.length > 0 ? `${occurrences.length} stay${occurrences.length === 1 ? '' : 's'}` : 'stays'} →
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2: preview ── */}
        {step === 'preview' && (
          <div className="p-5 space-y-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-700">
              <span>
                <b>{form.companyName}</b> · {describeNights(form.nightWeekdays)} · {formatStayDate(form.startDate)} → {formatStayDate(form.endDate)}
              </span>
              <span className="text-gray-400">·</span>
              <span>{form.roomIds.map(roomShortLabel).join(' / ')}</span>
              <span className="text-gray-400">·</span>
              <span>
                {form.pricingMode === 'flat' ? `flat ${formatCzk(flatRate ?? 0)}/night` : discount > 0 ? `web price −${discount}%` : 'web price'}
              </span>
              <span className="flex-1" />
              {form.pricingMode === 'dynamic' && (
                <button
                  onClick={() => void quoteRows(rows)}
                  disabled={quoting}
                  className="px-3 py-1.5 rounded-md bg-white border border-emerald-200 text-emerald-700 text-xs font-medium hover:bg-emerald-50 disabled:opacity-50"
                >
                  {quoting ? 'Asking Beds24…' : 'Refresh Beds24 prices'}
                </button>
              )}
            </div>

            {!reservations && !reservationsError && (
              <div className="text-xs text-gray-500">Checking availability against the dashboard reservations…</div>
            )}
            {reservationsError && <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{reservationsError}</div>}
            {quoteNote && <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{quoteNote}</div>}
            {blockedRows.length > 0 && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                <b>
                  {blockedRows.length} stay{blockedRows.length === 1 ? ' is' : 's are'} not possible in the agreed types.
                </b>{' '}
                Pick another type on the row, or untick it:
                <ul className="mt-1 space-y-0.5">
                  {blockedRows.map((r) => {
                    const alts = r.availability.kind === 'blocked' ? r.availability.alternatives : [];
                    const free = alts.filter((a) => a.moves === 0);
                    return (
                      <li key={r.seq}>
                        {formatStayRange(r.arrival, r.departure)} —{' '}
                        {free.length > 0
                          ? `vacancy in ${describeAlternatives(free)}`
                          : alts.length > 0
                            ? `vacancy after a shuffle in ${describeAlternatives(alts)}`
                            : 'no apartment is free'}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">
                      <input
                        type="checkbox"
                        checked={rows.length > 0 && rows.every((r) => r.include)}
                        onChange={(e) => setRows((prev) => prev.map((r) => ({ ...r, include: e.target.checked })))}
                        title="Include all / none"
                      />
                    </th>
                    <th className="px-2 py-2 text-left font-medium">#</th>
                    <th className="px-3 py-2 text-left font-medium">Dates</th>
                    <th className="px-3 py-2 text-right font-medium">Nights</th>
                    <th className="px-3 py-2 text-left font-medium">Room type</th>
                    <th className="px-3 py-2 text-left font-medium">Availability</th>
                    <th className="px-3 py-2 text-left font-medium">Guest (optional)</th>
                    <th className="px-3 py-2 text-right font-medium">Price (CZK)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((r) => (
                    <tr key={r.seq} className={r.include ? '' : 'bg-gray-50/60 text-gray-400'}>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={r.include}
                          onChange={(e) => setRows((prev) => prev.map((x) => (x.seq === r.seq ? { ...x, include: e.target.checked } : x)))}
                        />
                      </td>
                      <td className="px-2 py-2 text-xs tabular-nums">{r.seq}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{formatStayRange(r.arrival, r.departure)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.nights}</td>
                      <td className="px-3 py-2">
                        <select className={smallInputCls} value={r.roomId} onChange={(e) => setRowRoom(r.seq, Number(e.target.value))} disabled={!r.include}>
                          <RoomTypeOptions agreed={form.roomIds} />
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <AvailabilityChip a={r.availability} />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          className={smallInputCls}
                          placeholder={[form.guestFirstName, form.guestLastName].filter(Boolean).join(' ') || 'First Last'}
                          value={r.guestName}
                          disabled={!r.include}
                          onChange={(e) => setRows((prev) => prev.map((x) => (x.seq === r.seq ? { ...x, guestName: e.target.value } : x)))}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <input
                          className={`${smallInputCls} text-right w-28 ml-auto`}
                          value={r.price}
                          disabled={!r.include}
                          placeholder={quoting && form.pricingMode === 'dynamic' ? '…' : '—'}
                          onChange={(e) => setRows((prev) => prev.map((x) => (x.seq === r.seq ? { ...x, price: e.target.value, priceTouched: true } : x)))}
                        />
                        <div className="text-[10px] text-gray-400 whitespace-nowrap">
                          {form.pricingMode === 'flat'
                            ? `${r.nights} × ${formatCzk(flatRate ?? 0)}`
                            : r.listPriceCzk !== null
                              ? `web ${formatCzk(r.listPriceCzk)}${discount > 0 ? ` − ${discount}%` : ''}${r.quoteSource === 'calendar-nominal' ? ' (nominal)' : ''}`
                              : r.quoteError
                                ? 'no Beds24 price'
                                : quoting
                                  ? 'pricing…'
                                  : 'no offer — type a price'}
                          {r.priceTouched && ' · edited'}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totals */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {[
                { label: 'Reservations', value: `${included.length}${included.length !== rows.length ? ` of ${rows.length}` : ''}` },
                { label: 'Nights total', value: String(totalNights) },
                { label: 'Price per reservation', value: perStayLabel },
                { label: 'Average rate / night', value: avgNight === null ? '—' : formatCzk(avgNight) },
                { label: 'Price total', value: allPriced || total > 0 ? formatCzk(total) : '—' },
              ].map((t) => (
                <div key={t.label} className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                  <div className="text-[11px] uppercase tracking-wide text-gray-400">{t.label}</div>
                  <div className="text-base font-semibold text-gray-900 mt-0.5">{t.value}</div>
                </div>
              ))}
            </div>
            {!allPriced && included.length > 0 && (
              <p className="text-xs text-amber-700">
                Some included stays have no price yet. You can still save the agreement as a draft and create those bookings later from its page.
              </p>
            )}

            {saveError && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{saveError}</div>}

            <div className="flex flex-wrap justify-between gap-2 pt-2 border-t border-gray-100">
              <button onClick={() => setStep('form')} disabled={!!saving} className="px-4 py-2 rounded-md text-sm text-gray-600 hover:bg-gray-100">
                ← Back
              </button>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => void downloadOffer()}
                  disabled={!!saving || offerBusy || included.length === 0}
                  title="PDF offer for the company: dates, apartment types, nights, rate per night, total"
                  className="px-4 py-2 rounded-md bg-white border border-emerald-200 text-emerald-700 text-sm font-medium hover:bg-emerald-50 disabled:opacity-50"
                >
                  {offerBusy ? 'Preparing PDF…' : 'Download offer PDF'}
                </button>
                <button
                  onClick={() => void save(false)}
                  disabled={!!saving}
                  className="px-4 py-2 rounded-md bg-white border border-gray-200 text-gray-700 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
                >
                  {saving === 'draft' ? 'Saving…' : 'Save as draft only'}
                </button>
                <button
                  onClick={() => {
                    if (window.confirm(`Create ${included.length} confirmed booking${included.length === 1 ? '' : 's'} in Beds24 for ${form.companyName}?`)) void save(true);
                  }}
                  disabled={!!saving || included.length === 0 || !allPriced}
                  title={!allPriced ? 'Every included stay needs a price above 0' : undefined}
                  className="px-4 py-2 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium shadow-sm disabled:opacity-50"
                >
                  {saving === 'create' ? 'Creating in Beds24…' : `Save & create ${included.length} booking${included.length === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Step 3: result ── */}
        {step === 'result' && result && (
          <div className="p-5 space-y-4">
            {result.createError ? (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                The agreement was saved, but creating the bookings failed: {result.createError}. Open the agreement and use “Create bookings” to try again.
              </div>
            ) : result.outcomes.length === 0 ? (
              <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
                Saved as a draft — nothing was created in Beds24. Create the bookings from the agreement when you are ready.
              </div>
            ) : (
              <div
                className={`rounded-md border px-3 py-2 text-sm ${
                  result.outcomes.some((o) => !o.ok) ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-green-200 bg-green-50 text-green-800'
                }`}
              >
                {result.outcomes.filter((o) => o.ok).length} of {result.outcomes.length} bookings created in Beds24
                {result.outcomes.some((o) => !o.ok) && ' — the rest were refused; see below and retry from the agreement.'}
              </div>
            )}

            {result.outcomes.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-gray-200">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">#</th>
                      <th className="px-3 py-2 text-left font-medium">Dates</th>
                      <th className="px-3 py-2 text-left font-medium">Room type</th>
                      <th className="px-3 py-2 text-left font-medium">Result</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {result.outcomes.map((o) => (
                      <tr key={o.stayId}>
                        <td className="px-3 py-2 text-xs tabular-nums">{o.seq}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{formatStayRange(o.arrival, o.departure)}</td>
                        <td className="px-3 py-2">{roomShortLabel(o.roomId)}</td>
                        <td className="px-3 py-2">
                          {o.ok ? (
                            <span className="text-green-700">
                              ✅ <span className="font-mono text-xs">{o.reservationNumber}</span>
                            </span>
                          ) : (
                            <span className="text-red-700">❌ {o.error}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
              <button
                onClick={() => onCreated(result.agreement)}
                className="px-4 py-2 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium shadow-sm"
              >
                Open the agreement
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">{title}</h3>
      {children}
    </section>
  );
}

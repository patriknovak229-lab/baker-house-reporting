'use client';
/**
 * Parity check — calendar view.
 *
 * The operator's reading model: colored stay-blocks over the next 60 days,
 * one strip per unit — grey = booked, yellow = minor issue (a Genius/app
 * customer on Booking pays less than our site), red = major issue (Airbnb off
 * Booking by more than the tolerance, or our site above a channel), pale
 * green = checked and fine, dashed = sellable but not scraped yet. No numbers
 * on the canvas; clicking a block opens the detail panel with every specific
 * (prices, discount stacks, the derived Genius/app price, "Booking.com pays"
 * attribution, observation times).
 *
 * Blocks span their true stay length (2 or 7 columns). A stay can start every
 * day, so blocks overlap by construction — they are staggered into
 * `nights` lanes (lane = start-day mod nights), which tiles them without
 * collisions: same-lane neighbours are exactly `nights` days apart.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PARITY_UNITS, UNITS_2N, UNITS_3N, type ParityUnitConfig } from '@/data/parityConfig';
import { assessStay, type StayAssessment } from '@/utils/paritySeverity';
import type {
  BoardObservation,
  BoardRow,
  BoardUnitCell,
  ParityOffer,
  ParityResponse,
  ParitySlotView,
} from '@/utils/parityTypes';

// ── Formatting ────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];

/** "2026-09-06" → "Sept 6". */
function fmtDay(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
}

/** "2026-09-06", "2026-09-08" → "Sept 6 – Sept 8". */
function fmtRange(fromIso: string, toIso: string): string {
  return `${fmtDay(fromIso)} – ${fmtDay(toIso)}`;
}

function weekday(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function diffDays(fromIso: string, toIso: string): number {
  return Math.round(
    (new Date(`${toIso}T00:00:00Z`).getTime() - new Date(`${fromIso}T00:00:00Z`).getTime()) / 86_400_000,
  );
}

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 }).format(n);
}

function fmtNightly(total: number | null | undefined, nights: number): string {
  if (total == null) return '—';
  return fmt(Math.round(total / nights)) + '/night';
}

function discountPct(offer: ParityOffer): number | null {
  if (offer.price == null || offer.originalPrice == null || offer.originalPrice <= offer.price) return null;
  return Math.round(((offer.originalPrice - offer.price) / offer.originalPrice) * 100);
}

function formatTs(ts: string): string {
  return new Date(ts).toLocaleString('en-GB', {
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });
}

// ── Discount badge canon — same real-world discount, same badge, any channel ──

const DISCOUNT_CATEGORY = {
  weekly:   { label: 'Weekly discount',    class: 'bg-blue-100 text-blue-800 ring-1 ring-blue-200',           deviceLogin: false },
  monthly:  { label: 'Monthly discount',   class: 'bg-cyan-100 text-cyan-800 ring-1 ring-cyan-200',           deviceLogin: false },
  early:    { label: 'Early booking',      class: 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200',  deviceLogin: false },
  lastMin:  { label: 'Last-minute',        class: 'bg-orange-100 text-orange-800 ring-1 ring-orange-200',     deviceLogin: false },
  mobile:   { label: 'Mobile-only',        class: 'bg-purple-100 text-purple-800 ring-1 ring-purple-200',     deviceLogin: true  },
  longStay: { label: 'Long-stay discount', class: 'bg-sky-100 text-sky-800 ring-1 ring-sky-200',              deviceLogin: false },
  newList:  { label: 'New-listing promo',  class: 'bg-pink-100 text-pink-800 ring-1 ring-pink-200',           deviceLogin: false },
  host:     { label: 'Host discount',      class: 'bg-teal-100 text-teal-800 ring-1 ring-teal-200',           deviceLogin: false },
  genius:   { label: 'Genius',             class: 'bg-indigo-100 text-indigo-800 ring-1 ring-indigo-200',     deviceLogin: true  },
  getaway:  { label: 'Getaway/campaign',   class: 'bg-lime-100 text-lime-800 ring-1 ring-lime-200',           deviceLogin: false },
  bkPays:   { label: 'Booking.com pays',   class: 'bg-slate-200 text-slate-800 ring-1 ring-slate-300',        deviceLogin: false },
  generic:  { label: 'Discount',           class: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',           deviceLogin: false },
} as const;

type DiscountCategoryKey = keyof typeof DISCOUNT_CATEGORY;

function categorizeDiscount(name: string): DiscountCategoryKey {
  const lc = name.toLowerCase();
  if (/booking\.com pays/.test(lc))                                   return 'bkPays';
  if (/\bweekly\b|t[ýy]denn[ií]|t[ýy]dn/.test(lc))                    return 'weekly';
  if (/\bmonthly\b|m[ěe]s[ií]?[čc]n[ií]/.test(lc))                    return 'monthly';
  if (/early\s*(booker?|booking)|brzk[ou][ou]?\s*rezervaci/.test(lc)) return 'early';
  if (/last[- ]?minute|posledn[ií]\s*chv[ií]li/.test(lc))             return 'lastMin';
  if (/mobile[- ]?only|mobiln[ií]/.test(lc))                          return 'mobile';
  if (/long[- ]?stay/.test(lc))                                       return 'longStay';
  if (/new[- ]?listing|nov[áa]\s*nab[ií]dka/.test(lc))                return 'newList';
  if (/host\s*discount|owner\s*(?:discount|decreased)|hostitel/.test(lc)) return 'host';
  if (/genius/.test(lc))                                              return 'genius';
  if (/getaway|smart\s*deal|limited[- ]?time/.test(lc))               return 'getaway';
  return 'generic';
}

function DiscountBadge({ name, pp, amountKc }: { name: string; pp?: number; amountKc?: number }) {
  const key = categorizeDiscount(name);
  const cat = DISCOUNT_CATEGORY[key];
  const isBkPays = key === 'bkPays';
  const label = isBkPays || key === 'generic' ? name : cat.label;
  return (
    <span
      className={`inline-block text-[11px] leading-tight px-1.5 py-0.5 rounded font-medium ${cat.class}`}
      title={
        isBkPays
          ? 'Booking discounts this stay out of its own commission — no formula on our side, can change any time, deducted last. Out of our control.'
          : cat.deviceLogin
            ? 'Login/device-locked discount — not part of the anonymous price'
            : undefined
      }
    >
      {cat.deviceLogin && <span aria-hidden className="mr-0.5">🔒</span>}
      {label}
      {pp != null && <span className="font-bold"> −{pp}pp</span>}
      {pp == null && amountKc != null && <span className="font-bold"> −{fmt(amountKc)}</span>}
    </span>
  );
}

// ── Calendar ──────────────────────────────────────────────────────────────────

const COL_PX = 17;

const SEVERITY_STYLE: Record<StayAssessment['severity'], string> = {
  booked: 'bg-gray-200/80 hover:bg-gray-300',
  // Open calendar but a min-stay rule blocks this stay length — hatched so it
  // reads as "not sellable BY RULE", never as an occupied room.
  restricted:
    'bg-[repeating-linear-gradient(45deg,#e5e7eb_0px,#e5e7eb_3px,#ffffff_3px,#ffffff_6px)] border border-gray-200 hover:border-gray-400',
  nodata: 'bg-white border border-dashed border-gray-300 hover:border-gray-400',
  ok: 'bg-emerald-100 hover:bg-emerald-200 border border-emerald-200/60',
  minor: 'bg-amber-300 hover:bg-amber-400 border border-amber-400/50',
  major: 'bg-rose-500 hover:bg-rose-600 border border-rose-600/50',
};

interface Selection {
  row: BoardRow;
  cell: BoardUnitCell;
  assessment: StayAssessment;
}

function DateAxis({ windowStart, totalDays }: { windowStart: string; totalDays: number }) {
  const days = Array.from({ length: totalDays }, (_, i) => addDaysIso(windowStart, i));
  // Month segments for the top row
  const segments: { label: string; span: number }[] = [];
  for (const d of days) {
    const label = MONTHS[Number(d.slice(5, 7)) - 1];
    const last = segments[segments.length - 1];
    if (last && last.label === label) last.span += 1;
    else segments.push({ label, span: 1 });
  }
  return (
    <div className="sticky top-0 z-10 bg-white/95 backdrop-blur-sm">
      <div className="grid" style={{ gridTemplateColumns: `repeat(${totalDays}, ${COL_PX}px)` }}>
        {segments.map((s, i) => (
          <div key={i} className="text-[10px] font-semibold text-gray-600 border-b border-gray-200 pb-0.5" style={{ gridColumn: `span ${s.span}` }}>
            {s.span >= 3 ? s.label : ''}
          </div>
        ))}
      </div>
      <div className="grid" style={{ gridTemplateColumns: `repeat(${totalDays}, ${COL_PX}px)` }}>
        {days.map((d) => {
          const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
          const weekend = wd === 0 || wd === 6;
          return (
            <div key={d} className={`text-[9px] text-center pb-1 ${weekend ? 'text-indigo-600 font-bold' : 'text-gray-400'}`}>
              {Number(d.slice(8, 10))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StayCalendar({
  title,
  subtitle,
  rows,
  nights,
  units,
  windowStart,
  totalDays,
  onSelect,
  selected,
}: {
  title: string;
  subtitle: string;
  rows: BoardRow[];
  nights: number;
  units: ParityUnitConfig[];
  windowStart: string;
  totalDays: number;
  onSelect: (s: Selection) => void;
  selected: Selection | null;
}) {
  return (
    <section>
      <div className="mb-2">
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
        <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 flex items-center justify-center h-20 text-gray-400 text-sm">
          No observations yet — the next grid run fills this in.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 p-3 bg-white">
          <div style={{ width: totalDays * COL_PX + 1 }}>
            <DateAxis windowStart={windowStart} totalDays={totalDays} />
            {units.map((unit) => (
              <div key={unit.id} className="mt-2">
                <div className="text-[11px] font-medium text-gray-600 mb-1">{unit.label}</div>
                <div
                  className="grid gap-[2px]"
                  style={{
                    gridTemplateColumns: `repeat(${totalDays}, ${COL_PX}px)`,
                    gridTemplateRows: `repeat(${nights}, 15px)`,
                  }}
                >
                  {rows.map((row) => {
                    const cell = row.units.find((u) => u.unitId === unit.id);
                    if (!cell) return null;
                    const startIdx = diffDays(windowStart, row.checkIn);
                    if (startIdx < 0 || startIdx >= totalDays) return null;
                    const assessment = assessStay(cell);
                    const isSelected =
                      selected?.row.checkIn === row.checkIn &&
                      selected?.row.nights === row.nights &&
                      selected?.cell.unitId === unit.id;
                    return (
                      <button
                        key={row.checkIn}
                        onClick={() => onSelect({ row, cell, assessment })}
                        title={`${unit.label} · ${fmtRange(row.checkIn, row.checkOut)} — click for details`}
                        className={`rounded-[3px] transition-colors cursor-pointer ${SEVERITY_STYLE[assessment.severity]} ${isSelected ? 'ring-2 ring-indigo-600 ring-offset-1 z-10' : ''}`}
                        style={{
                          gridColumn: `${startIdx + 1} / span ${Math.min(nights, totalDays - startIdx)}`,
                          gridRow: (startIdx % nights) + 1,
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function ChannelDetail({
  name,
  obs,
  nights,
  memberFloor,
}: {
  name: string;
  obs: BoardObservation | null;
  nights: number;
  memberFloor?: number | null;
}) {
  return (
    <div className="rounded-lg border border-gray-200 p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-semibold text-gray-500 uppercase">{name}</span>
        {obs && <span className="text-[10px] text-gray-400">observed {formatTs(obs.capturedAt)}</span>}
      </div>
      {!obs ? (
        <div className="text-sm text-gray-400 italic mt-1">no observation yet</div>
      ) : obs.price === null ? (
        <div className="text-sm text-gray-400 italic mt-1">
          {obs.availability === 'error'
            ? 'scrape error'
            : obs.availability === 'restricted'
              ? `open, but ${obs.labels.find((l) => /^Min stay/.test(l))?.toLowerCase() ?? 'a min-stay rule'} blocks this stay length`
              : 'not bookable'}
        </div>
      ) : (
        <>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-xl font-semibold text-gray-900 tabular-nums">{fmt(obs.price)}</span>
            <span className="text-xs text-gray-500">{fmtNightly(obs.price, nights)}</span>
          </div>
          {obs.originalPrice != null && discountPct(obs) != null && (
            <div className="text-xs text-gray-500 mt-0.5">
              <span className="line-through">{fmt(obs.originalPrice)}</span>
              <span className="ml-1 text-emerald-700 font-semibold">−{discountPct(obs)}%</span>
              {obs.unparsedDiscount && <span className="ml-1 text-amber-600 text-[10px]">(unbreakable)</span>}
            </div>
          )}
          {(obs.discountBreakdown?.length || obs.labels.length > 0) && (
            <div className="mt-2 flex flex-wrap gap-1">
              {(obs.discountBreakdown ?? []).map((d, i) => (
                <DiscountBadge key={`b${i}`} name={d.name} pp={d.pp} amountKc={d.amountKc} />
              ))}
              {obs.labels
                .filter((l) => {
                  // A breakdown badge (with its Kč amount) beats the bare label.
                  const seen = new Set((obs.discountBreakdown ?? []).map((d) => categorizeDiscount(d.name)));
                  const cat = categorizeDiscount(l);
                  return !(seen.has(cat) && cat !== 'generic');
                })
                .map((l, i) => (
                  <DiscountBadge key={`l${i}`} name={l} />
                ))}
            </div>
          )}
          {memberFloor != null && (
            <div className="mt-2 text-xs text-gray-600">
              Genius/app customer pays <span className="font-semibold tabular-nums">≈{fmt(memberFloor)}</span>
              <span className="text-gray-400"> (derived: −10% Genius{obs.labels.some((l) => ['Getaway Deal', 'Limited-time Deal', 'Smart Deal'].includes(l)) ? '; mobile blocked by the campaign deal' : ' −10% mobile'})</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DetailPanel({ selection, onClose }: { selection: Selection; onClose: () => void }) {
  const { row, cell, assessment } = selection;
  const a = cell.airbnb?.price ?? null;
  const b = cell.booking?.price ?? null;
  const floor = assessment.memberFloor;
  const corridor = a !== null && b !== null && b > 0 && floor !== null;
  const insideCorridor = corridor && a >= floor * 0.95 && a <= b * 1.05;
  const minStayLabel = cell.web?.labels.find((l) => /^Min stay \d+$/.test(l)) ?? null;

  return (
    <aside className="fixed inset-y-0 right-0 w-full sm:w-[430px] bg-white border-l border-gray-200 shadow-2xl z-50 overflow-y-auto">
      <div className="sticky top-0 bg-white border-b border-gray-200 px-5 py-4 flex items-start justify-between">
        <div>
          <div className="text-lg font-semibold text-gray-900">{cell.unitLabel}</div>
          <div className="text-sm text-gray-500">
            {fmtRange(row.checkIn, row.checkOut)} · {row.nights} night{row.nights === 1 ? '' : 's'} ·{' '}
            {weekday(row.checkIn)} check-in
          </div>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none px-2 py-1" aria-label="Close">
          ×
        </button>
      </div>

      <div className="px-5 py-4 space-y-4">
        {assessment.severity === 'booked' && (
          <div className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">
            Not sellable online (booked or blocked) per Beds24.
          </div>
        )}
        {assessment.severity === 'restricted' && (
          <div className="rounded-lg bg-gray-50 border border-gray-300 px-3 py-2 text-sm text-gray-600">
            The calendar is <strong>open</strong> for these dates, but a{' '}
            <strong>{minStayLabel ? minStayLabel.toLowerCase() : 'min-stay'} rule</strong> blocks a{' '}
            {row.nights}-night stay — no channel will sell it. Not a booking; if this restriction is
            unintended, change it in PriceLabs/Beds24.
          </div>
        )}
        {assessment.severity === 'nodata' && (
          <div className="rounded-lg bg-gray-50 border border-dashed border-gray-300 px-3 py-2 text-sm text-gray-500">
            Sellable, but no channel observation yet — the scrape rotation reaches this date within a few days
            (or the channel was configured after the last run).
          </div>
        )}
        {assessment.issues.map((issue, i) => (
          <div
            key={i}
            className={`rounded-lg px-3 py-2 text-sm border ${
              issue.severity === 'major'
                ? 'bg-rose-50 border-rose-200 text-rose-800'
                : 'bg-amber-50 border-amber-200 text-amber-800'
            }`}
          >
            {issue.severity === 'major' ? '🔴' : '🟡'} {issue.text}
          </div>
        ))}
        {assessment.severity === 'ok' && (
          <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-800">
            ✓ All parity rules pass for this stay.
          </div>
        )}

        <ChannelDetail name="Web (our site)" obs={cell.web} nights={row.nights} />
        <ChannelDetail name="Airbnb" obs={cell.airbnb} nights={row.nights} />
        <ChannelDetail name="Booking.com" obs={cell.booking} nights={row.nights} memberFloor={assessment.memberFloor} />

        {corridor && (
          <div className="text-xs text-gray-500">
            Airbnb corridor (Booking baseline): Genius/app {fmt(floor)} ≤{' '}
            <span className={insideCorridor ? 'text-emerald-700 font-semibold' : 'text-rose-700 font-semibold'}>
              Airbnb {fmt(a)}
            </span>{' '}
            ≤ anonymous +5% {fmt(Math.round(b * 1.05))} — {insideCorridor ? 'inside' : 'outside'} (tolerance ±5% at each bound)
          </div>
        )}
        {assessment.bookingFunded && (
          <div className="text-xs text-gray-500">
            ⚠ This Booking price includes a <strong>“Booking.com pays”</strong> discount — Booking funds it from its
            own commission, the amount follows no formula we know, can change any time, and is deducted last. Out of
            our control; shown so you know it was present.
          </div>
        )}
      </div>
    </aside>
  );
}

// ── Custom check result card ──────────────────────────────────────────────────

function OfferCell({ offer, nights }: { offer: ParityOffer | null; nights: number }) {
  if (!offer || offer.price == null) {
    const label =
      offer?.availability === 'error' ? 'scrape error' :
      offer?.availability === 'not_available' ? 'Not available' : '—';
    return (
      <td className="px-4 py-2.5 text-right align-top">
        <div className={`text-xs italic ${offer?.availability === 'error' ? 'text-red-400' : 'text-gray-400'}`}>{label}</div>
      </td>
    );
  }
  const pct = discountPct(offer);
  return (
    <td className="px-4 py-2.5 text-right tabular-nums text-gray-800 align-top">
      <div className="font-semibold">{fmt(offer.price)}</div>
      <div className="text-xs text-gray-500">{fmtNightly(offer.price, nights)}</div>
      {offer.originalPrice != null && pct != null && (
        <div className="text-xs text-gray-500 mt-0.5">
          <span className="line-through">{fmt(offer.originalPrice)}</span>
          <span className="ml-1 text-emerald-700 font-semibold">−{pct}%</span>
        </div>
      )}
      {(offer.discountBreakdown?.length || offer.labels.length > 0) && (
        <div className="mt-1.5 flex flex-wrap gap-1 justify-end max-w-[240px] ml-auto">
          {(offer.discountBreakdown ?? []).map((d, i) => (
            <DiscountBadge key={`b${i}`} name={d.name} pp={d.pp} amountKc={d.amountKc} />
          ))}
          {offer.labels.slice(0, 3).map((l, i) => (
            <DiscountBadge key={`l${i}`} name={l} />
          ))}
        </div>
      )}
    </td>
  );
}

function SlotCard({ slot }: { slot: ParitySlotView }) {
  return (
    <div className="rounded-lg border border-gray-200 overflow-hidden">
      <div className="bg-gray-50 px-4 py-2 border-b border-gray-200 flex items-baseline justify-between flex-wrap gap-2">
        <div className="font-semibold text-gray-800">{fmtRange(slot.checkIn, slot.checkOut)}</div>
        <div className="text-xs text-gray-500">
          {slot.nights} night{slot.nights === 1 ? '' : 's'} · booked {slot.leadDays} day{slot.leadDays === 1 ? '' : 's'} ahead
        </div>
      </div>
      <table className="min-w-full text-sm">
        <thead className="bg-white border-b border-gray-100">
          <tr>
            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase w-44">Unit</th>
            <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Web</th>
            <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Airbnb</th>
            <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Booking.com</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {slot.units.map((cell) => (
            <tr key={cell.unitId}>
              <td className="px-4 py-2.5 align-top">
                <span className="text-sm font-medium text-gray-800">{cell.unitLabel}</span>
              </td>
              <OfferCell offer={cell.web} nights={slot.nights} />
              <OfferCell offer={cell.airbnb} nights={slot.nights} />
              <OfferCell offer={cell.booking} nights={slot.nights} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Competitors ───────────────────────────────────────────────────────────────

function CompetitorSection({ observations }: { observations: ParityResponse['competitors'] }) {
  if (observations.length === 0) return null;
  return (
    <section className="border-t border-gray-200 pt-8">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Competitors</h2>
      <p className="text-xs text-gray-500 mb-4">
        Configured competitor listings, priced alongside each grid run.
      </p>
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Competitor</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Stay</th>
              <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 uppercase">Channel</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Total</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Per night</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {observations.map((o, i) => (
              <tr key={i}>
                <td className="px-3 py-2 text-gray-800">{o.label} <span className="text-xs text-gray-400">({o.bedrooms}BR)</span></td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                  {fmtRange(o.checkIn, addDaysIso(o.checkIn, o.nights))} · {o.nights}n
                </td>
                <td className="px-3 py-2 text-center text-xs text-gray-500">{o.channel}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(o.price)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-500">{fmtNightly(o.price, o.nights)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

export default function ParityView() {
  const [data, setData] = useState<ParityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);

  const [checkIn, setCheckIn] = useState('');
  const [nights, setNights] = useState('2');
  const [queueing, setQueueing] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/pricing/parity');
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      setData(await res.json());
      setError(null);
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const hasPending = useMemo(() => data?.requests.some((r) => r.status === 'pending') ?? false, [data]);
  useEffect(() => {
    if (hasPending && !pollTimer.current) {
      pollTimer.current = setInterval(() => load(true), 20_000);
    }
    if (!hasPending && pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    return () => {
      if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
    };
  }, [hasPending, load]);

  async function queueCheck() {
    if (!checkIn) return;
    setQueueing(true);
    setQueueError(null);
    try {
      const res = await fetch('/api/pricing/parity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkIn, nights: Number(nights) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Failed (${res.status})`);
      }
      await load(true);
    } catch (e) {
      setQueueError(e instanceof Error ? e.message : 'Failed to queue');
    } finally {
      setQueueing(false);
    }
  }

  const allBoards = useMemo(
    () => [...(data?.board1n ?? []), ...(data?.board2n ?? []), ...(data?.board3n ?? []), ...(data?.board7n ?? [])],
    [data],
  );

  const windowStart = useMemo(() => {
    const starts = allBoards.map((r) => r.checkIn);
    return starts.length > 0 ? starts.sort()[0] : new Date().toISOString().slice(0, 10);
  }, [allBoards]);

  const totalDays = useMemo(() => {
    const ends = allBoards.map((r) => diffDays(windowStart, r.checkOut));
    return Math.max(10, ...ends);
  }, [allBoards, windowStart]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400 text-sm gap-2">
        <span className="w-5 h-5 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
        Loading parity data…
      </div>
    );
  }
  if (error) {
    return <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>;
  }

  const gridAgeHours = data?.latestGridAt ? (Date.now() - new Date(data.latestGridAt).getTime()) / 3_600_000 : null;

  return (
    <div className="space-y-10">
      {gridAgeHours !== null && gridAgeHours > 26 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Last grid run is {Math.round(gridAgeHours)} h old — the Mac parity runner has not reported today.
          Check the launchd job (docs/pricing-runner.md).
        </div>
      )}

      <div className="flex items-center gap-4 flex-wrap text-xs text-gray-600">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 h-3 rounded-[3px] bg-gray-200" /> booked</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 h-3 rounded-[3px] border border-gray-200 bg-[repeating-linear-gradient(45deg,#e5e7eb_0px,#e5e7eb_3px,#ffffff_3px,#ffffff_6px)]" /> open, but min-stay blocks this length</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 h-3 rounded-[3px] bg-emerald-100 border border-emerald-200" /> checked, fine</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 h-3 rounded-[3px] bg-amber-300" /> minor — Genius/app price on Booking below our site</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 h-3 rounded-[3px] bg-rose-500" /> major — Airbnb outside Booking&apos;s Genius↔anonymous corridor or our site above a channel</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 h-3 rounded-[3px] bg-white border border-dashed border-gray-300" /> not scraped yet</span>
        <span className="text-gray-400">· click any block for details</span>
      </div>

      <StayCalendar
        title="1-night stays — next 14 days"
        subtitle="All units, checked daily. Most dates are min-stay blocked by design — the interesting blocks are the gap fillers where a single night actually sells."
        rows={data?.board1n ?? []}
        nights={1}
        units={PARITY_UNITS}
        windowStart={windowStart}
        totalDays={totalDays}
        onSelect={setSelection}
        selected={selection}
      />

      <StayCalendar
        title="2-night stays — studios"
        subtitle="1KK Urban + 1KK Deluxe. Checked daily for the next 30 days, weekly for days 30–60; beyond that use a custom check."
        rows={data?.board2n ?? []}
        nights={2}
        units={UNITS_2N}
        windowStart={windowStart}
        totalDays={totalDays}
        onSelect={setSelection}
        selected={selection}
      />

      <StayCalendar
        title="3-night stays — two-bedroom units"
        subtitle="O.308 + K.201 sampled as 3-night stays (their seasonal min-stay 3 blocks 2-night bookings). Same cadence: daily to 30 days, weekly to 60."
        rows={data?.board3n ?? []}
        nights={3}
        units={UNITS_3N}
        windowStart={windowStart}
        totalDays={totalDays}
        onSelect={setSelection}
        selected={selection}
      />

      <StayCalendar
        title="7-night stays"
        subtitle="All units; coverage fills over the weekly scrape rotation."
        rows={data?.board7n ?? []}
        nights={7}
        units={PARITY_UNITS}
        windowStart={windowStart}
        totalDays={totalDays}
        onSelect={setSelection}
        selected={selection}
      />

      <CompetitorSection observations={data?.competitors ?? []} />

      <section className="border-t border-gray-200 pt-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Custom date check</h2>
        <p className="text-xs text-gray-500 mb-4">
          Queued for the Mac runner — results appear here within ~15 minutes while the Mac is awake. Use this for
          any date beyond the 60-day boards.
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Check-in</label>
            <input
              type="date"
              value={checkIn}
              onChange={(e) => setCheckIn(e.target.value)}
              className="block border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Stay length</label>
            <select
              value={nights}
              onChange={(e) => setNights(e.target.value)}
              className="block border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {['1', '2', '3', '7', '14', '28'].map((n) => (
                <option key={n} value={n}>{n} night{n === '1' ? '' : 's'}</option>
              ))}
            </select>
          </div>
          <button
            onClick={queueCheck}
            disabled={!checkIn || queueing}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-800 text-white text-sm font-medium hover:bg-gray-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {queueing ? 'Queueing…' : 'Queue check'}
          </button>
          {queueError && <span className="text-sm text-red-600">{queueError}</span>}
        </div>

        {data && data.requests.length > 0 && (
          <div className="mt-6 space-y-4">
            {data.requests.map((r) => (
              <div key={r.id}>
                <div className="flex items-center gap-2 text-sm mb-2">
                  <span className="text-gray-700 font-medium">{fmtDay(r.checkIn)} · {r.nights}n</span>
                  {r.status === 'pending' && (
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs font-medium">
                      <span className="w-2.5 h-2.5 border border-amber-600 border-t-transparent rounded-full animate-spin" />
                      queued for the runner
                    </span>
                  )}
                  {r.status === 'done' && (
                    <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-xs font-medium">done</span>
                  )}
                  {r.status === 'error' && (
                    <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-xs font-medium" title={r.error ?? undefined}>
                      {r.error ?? 'error'}
                    </span>
                  )}
                  <span className="text-xs text-gray-400 ml-auto">requested {formatTs(r.requestedAt)}</span>
                </div>
                {r.result && r.result.map((slot) => (
                  <SlotCard key={`${r.id}-${slot.checkIn}-${slot.nights}`} slot={slot} />
                ))}
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="text-xs text-gray-400">
        Prices are what an anonymous, logged-out desktop visitor pays; Booking&apos;s member prices (Genius/mobile) and
        “Booking.com pays” attribution are derived and shown in the detail panel · Booking.com is the baseline channel.
      </p>

      {selection && <DetailPanel selection={selection} onClose={() => setSelection(null)} />}
    </div>
  );
}

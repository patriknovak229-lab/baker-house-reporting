'use client';
/**
 * "Assign cleanings" for one corporate stay — mid-stay cleanings that reach
 * the cleaning app as "Úklid během pobytu". The post-stay cleaning is not part
 * of this: it still comes from the checkout as for any booking.
 *
 * Frequency → the minimum number of cleanings (utils/corporateCleaning.ts).
 * Then either:
 *   - Regular (default): pick the weekday(s), generate the dates, adjust any.
 *   - Ad hoc: one date box per expected cleaning, filled in by the operator.
 * What gets saved is the final date list; it can be reopened and changed at
 * any time (dates are agreed with the guest).
 */
import { useMemo, useState } from 'react';
import {
  CYCLE_DAYS,
  FREQUENCY_LABELS,
  expectedCleaningCount,
  isInsideStay,
  longestGapDays,
  minDaysBeforeFirstCleaning,
  regularCleaningDates,
  suggestedAdhocDates,
  weekdaysNeeded,
  type CleaningFrequency,
  type CleaningMode,
} from '@/utils/corporateCleaning';
import { addDays, isoWeekday } from '@/utils/corporateSchedule';
import { formatStayDate, formatStayRange, type CorporateStay } from '@/utils/corporateShared';
import { smallInputCls } from './ui';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface Props {
  stay: CorporateStay;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

export default function CleaningPlanModal({ stay, onClose, onSaved }: Props) {
  const plan = stay.cleaningPlan;
  const [frequency, setFrequency] = useState<CleaningFrequency>(plan?.frequency ?? 'weekly');
  const [mode, setMode] = useState<CleaningMode>(plan?.mode ?? 'regular');
  const [weekdays, setWeekdays] = useState<number[]>(plan?.weekdays ?? []);
  const [dates, setDates] = useState<string[]>(plan?.dates ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const expected = expectedCleaningCount(stay.nights, frequency);
  const filled = dates.filter(Boolean);
  const outside = filled.filter((d) => !isInsideStay(stay.arrival, stay.departure, d));
  const gap = useMemo(() => longestGapDays(stay.arrival, stay.departure, filled), [stay.arrival, stay.departure, filled]);
  // Regular plans may wait up to cycle + (min days before first − 1) for the
  // first cleaning (weekly: up to 10 days, Sat arrival + Tuesday) — by design.
  const cycle = Math.ceil(CYCLE_DAYS[frequency]);
  const maxGap = mode === 'regular' ? cycle + minDaysBeforeFirstCleaning(frequency) - 1 : cycle;
  const firstDay = addDays(stay.arrival, 1);
  const lastDay = addDays(stay.departure, -1);

  function resizeBoxes(list: string[], n: number): string[] {
    const kept = list.slice(0, Math.max(n, list.filter(Boolean).length));
    while (kept.length < n) kept.push('');
    return kept;
  }

  function pickFrequency(f: CleaningFrequency) {
    setFrequency(f);
    setWeekdays((w) => w.slice(0, weekdaysNeeded(f)));
    if (mode === 'adhoc') setDates((d) => resizeBoxes(d, expectedCleaningCount(stay.nights, f)));
  }

  function pickMode(m: CleaningMode) {
    setMode(m);
    if (m === 'adhoc') setDates((d) => resizeBoxes(d, expected));
  }

  function toggleWeekday(d: number) {
    setWeekdays((w) => {
      if (w.includes(d)) return w.filter((x) => x !== d);
      const next = [...w, d];
      return next.slice(-weekdaysNeeded(frequency)).sort();
    });
  }

  function generate() {
    setDates(regularCleaningDates(stay.arrival, stay.departure, frequency, weekdays));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/corporate/stays/${encodeURIComponent(stay.id)}/cleanings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frequency, mode, weekdays, dates: filled }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setNotice(
        json.published === null
          ? 'Saved. The booking is not in the sync cache yet — the cleanings reach the cleaning app on the next Transactions sync.'
          : `Saved — ${json.published} cleaning${json.published === 1 ? '' : 's'} published to the cleaning app.`,
      );
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function removeAll() {
    if (!window.confirm('Remove all mid-stay cleanings of this stay from the cleaning app?')) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/corporate/stays/${encodeURIComponent(stay.id)}/cleanings`, { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setDates([]);
      setWeekdays([]);
      setNotice('Removed.');
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const chip = (active: boolean) =>
    `px-3 py-1.5 rounded-lg border text-xs font-medium ${
      active ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-gray-200 text-gray-700 hover:bg-gray-50'
    }`;

  return (
    // text-left / whitespace-normal: rendered inside the row's right-aligned,
    // nowrap Actions cell — reset so the window doesn't inherit it.
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-3 sm:p-6 overflow-y-auto text-left whitespace-normal" onClick={() => !saving && onClose()}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-xl my-4" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold text-gray-900">Assign cleanings</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {stay.reservationNumber} · {formatStayRange(stay.arrival, stay.departure)} · {stay.nights} nights
            </p>
            <p className="text-[11px] text-gray-400 mt-1">
              Shown in the cleaning app as “Úklid během pobytu”. The post-stay cleaning on checkout stays as it is.
            </p>
          </div>
          <button onClick={onClose} disabled={saving} className="text-gray-400 hover:text-gray-600 text-lg leading-none">
            ×
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Frequency */}
          <div>
            <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1.5">Frequency</div>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(FREQUENCY_LABELS) as CleaningFrequency[]).map((f) => (
                <button key={f} type="button" className={chip(frequency === f)} onClick={() => pickFrequency(f)}>
                  {FREQUENCY_LABELS[f]}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-600 mt-2">
              Expected cleanings: <b className="tabular-nums">{expected}</b>{' '}
              <span className="text-gray-400">(one per {cycle}-day cycle; post-stay not counted)</span>
            </p>
          </div>

          {/* Mode */}
          <div>
            <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1.5">Schedule</div>
            <div className="flex gap-1.5">
              <button type="button" className={chip(mode === 'regular')} onClick={() => pickMode('regular')}>
                Regular cleanings
              </button>
              <button type="button" className={chip(mode === 'adhoc')} onClick={() => pickMode('adhoc')}>
                Ad hoc cleanings
              </button>
            </div>
          </div>

          {mode === 'regular' && (
            <div>
              <div className="text-xs text-gray-600 mb-1.5">
                Cleaning day{weekdaysNeeded(frequency) > 1 ? 's' : ''} — pick {weekdaysNeeded(frequency)}
              </div>
              <div className="flex flex-wrap gap-1">
                {WEEKDAYS.map((label, i) => (
                  <button key={label} type="button" className={chip(weekdays.includes(i + 1))} onClick={() => toggleWeekday(i + 1)}>
                    {label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={generate}
                disabled={weekdays.length !== weekdaysNeeded(frequency)}
                className="mt-2 px-3 py-1.5 rounded-lg border border-indigo-200 text-indigo-700 text-xs font-medium hover:bg-indigo-50 disabled:opacity-40"
              >
                {dates.length ? 'Regenerate dates' : 'Generate dates'}
              </button>
              <span className="text-[11px] text-gray-400 ml-2">
                Arrival is a {WEEKDAYS[isoWeekday(stay.arrival) - 1]} · first cleaning at least {minDaysBeforeFirstCleaning(frequency)} days after arrival
              </span>
            </div>
          )}

          {mode === 'adhoc' && (
            <button
              type="button"
              onClick={() => setDates(suggestedAdhocDates(stay.arrival, stay.departure, frequency))}
              className="px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 text-xs hover:bg-gray-50"
            >
              Prefill one per cycle
            </button>
          )}

          {/* Dates — always editable */}
          {dates.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1.5">
                Dates ({filled.length}/{expected})
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {dates.map((d, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <span className="text-[11px] text-gray-400 w-5 text-right tabular-nums">{i + 1}.</span>
                    <input
                      type="date"
                      className={`${smallInputCls} ${d && !isInsideStay(stay.arrival, stay.departure, d) ? 'border-rose-400' : ''}`}
                      value={d}
                      min={firstDay}
                      max={lastDay}
                      onChange={(e) => setDates((list) => list.map((x, j) => (j === i ? e.target.value : x)))}
                    />
                    <span className="text-[11px] text-gray-400 w-8 shrink-0">{d ? formatStayDate(d).split(' ')[0] : ''}</span>
                    <button
                      type="button"
                      onClick={() => setDates((list) => list.filter((_, j) => j !== i))}
                      className="text-gray-300 hover:text-rose-500 text-sm"
                      title="Remove this cleaning"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setDates((list) => [...list, ''])}
                className="mt-1.5 text-xs text-indigo-600 hover:underline"
              >
                + Add date
              </button>
            </div>
          )}

          {/* Checks */}
          {filled.length > 0 && (
            <div className="text-xs space-y-0.5">
              {outside.length > 0 && <p className="text-rose-600">Dates must fall after arrival day and before checkout day.</p>}
              {filled.length < expected && (
                <p className="text-amber-600">
                  {expected - filled.length} fewer than expected for {FREQUENCY_LABELS[frequency].toLowerCase()}.
                </p>
              )}
              <p className={gap > maxGap ? 'text-amber-600' : 'text-gray-500'}>
                Longest stretch without a cleaning: {gap} days{gap > maxGap ? ` (more than ${maxGap})` : ''}.
              </p>
            </div>
          )}

          {error && <p className="text-xs text-rose-600">{error}</p>}
          {notice && <p className="text-xs text-emerald-700">{notice}</p>}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between gap-2">
          {plan ? (
            <button onClick={() => void removeAll()} disabled={saving} className="text-xs text-rose-600 hover:underline disabled:opacity-40">
              Remove all cleanings
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button onClick={onClose} disabled={saving} className="px-3 py-1.5 rounded-lg text-xs text-gray-600 hover:bg-gray-100">
              Close
            </button>
            <button
              onClick={() => void save()}
              disabled={saving || filled.length === 0 || outside.length > 0}
              className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-medium disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save & send to cleaning app'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

'use client';
/**
 * One agreement, stay by stay.
 *
 * Header: who, what pattern, what price, how invoiced, with inline editing of
 * the contact/billing facts. Body: every generated stay with its Beds24
 * status, and the per-stay actions — fill in the guest (pushed to Beds24 once
 * the booking exists), re-price or change the room while still planned, skip,
 * create, retry a failure, cancel a created booking.
 *
 * Every mutation goes through the API and the agreement is re-read from the
 * server afterwards, so what is on screen is always what Postgres holds.
 */
import { useState } from 'react';
import { describeNights } from '@/utils/corporateSchedule';
import {
  BILLING_CADENCE_LABELS,
  formatCzk,
  formatStayDate,
  formatStayRange,
  type AgreementDetail as AgreementDetailDto,
  type BillingCadence,
  type CorporateStay,
} from '@/utils/corporateShared';
import {
  AgreementStatusBadge,
  CopyText,
  Field,
  PRICE_SOURCE_LABEL,
  RoomTypeOptions,
  StayStatusBadge,
  inputCls,
  joinGuestName,
  roomLabelFor,
  roomShortLabel,
  smallInputCls,
  splitGuestName,
} from './ui';
import { downloadOfferPdf, offerFromAgreement } from './offer';

interface Props {
  agreement: AgreementDetailDto;
  canEdit: boolean;
  onChanged: (agreement: AgreementDetailDto) => void;
  onDeleted: () => void;
  onClose: () => void;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

export default function AgreementDetail({ agreement, canEdit, onChanged, onDeleted, onClose }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [lastRun, setLastRun] = useState<{ created: number; failed: number } | null>(null);

  const s = agreement.summary;
  const toCreate = agreement.stays.filter((st) => st.status === 'planned' || st.status === 'failed');
  const unpriced = toCreate.filter((st) => st.priceCzk === null || st.priceCzk <= 0);
  /** Average over priced, counting stays — matches the preview's figure. */
  const pricedNights = agreement.stays
    .filter((st) => (st.status === 'planned' || st.status === 'created' || st.status === 'failed') && st.priceCzk !== null)
    .reduce((n, st) => n + st.nights, 0);
  const avgNight = pricedNights > 0 ? s.priceCzk / pricedNights : null;

  async function downloadOffer() {
    await run('offer', () => downloadOfferPdf(offerFromAgreement(agreement), agreement.id));
  }

  async function refresh() {
    const json = await api<{ agreement: AgreementDetailDto }>(`/api/corporate/agreements/${encodeURIComponent(agreement.id)}`);
    onChanged(json.agreement);
  }

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function createBookings(stayIds?: string[]) {
    const label = stayIds ? `${stayIds.length} stay${stayIds.length === 1 ? '' : 's'}` : `${toCreate.length} planned stays`;
    if (!window.confirm(`Create ${label} in Beds24 for ${agreement.companyName}? Each becomes a confirmed direct booking.`)) return;
    await run('create', async () => {
      const json = await api<{ created: number; failed: number; agreement: AgreementDetailDto }>(
        `/api/corporate/agreements/${encodeURIComponent(agreement.id)}/create-bookings`,
        { method: 'POST', body: JSON.stringify(stayIds ? { stayIds } : {}) },
      );
      setLastRun({ created: json.created, failed: json.failed });
      onChanged(json.agreement);
      // Nudge the shared bookings cache so Transactions shows the new bookings
      // on its next load instead of waiting out the sync guard.
      void fetch('/api/bookings?fullSync=true').catch(() => {});
    });
  }

  async function patchAgreement(body: Record<string, unknown>) {
    await run('agreement', async () => {
      const json = await api<{ agreement: AgreementDetailDto }>(`/api/corporate/agreements/${encodeURIComponent(agreement.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      onChanged(json.agreement);
    });
  }

  async function deleteAgreement() {
    if (!window.confirm(`Delete the agreement with ${agreement.companyName} and its ${agreement.stays.length} planned stays? Nothing exists in Beds24 yet.`)) return;
    await run('delete', async () => {
      await api(`/api/corporate/agreements/${encodeURIComponent(agreement.id)}`, { method: 'DELETE' });
      onDeleted();
    });
  }

  return (
    <div>
      {/* ── Header ── */}
      <div className="px-4 sm:px-6 py-4 border-b border-gray-100 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-lg font-semibold text-gray-900">{agreement.companyName}</h2>
            <AgreementStatusBadge status={agreement.status} />
            <span className="font-mono text-[11px] text-gray-400">{agreement.id}</span>
          </div>
          <p className="text-sm text-gray-600 mt-1">
            {describeNights(agreement.nightWeekdays)} · {formatStayDate(agreement.startDate)} → {formatStayDate(agreement.endDate)} ·{' '}
            {agreement.roomIds.map(roomShortLabel).join(' / ')}
            {agreement.roomIds.length > 1 && (
              <span className="text-gray-400"> (prefer {roomShortLabel(agreement.preferredRoomId ?? agreement.roomIds[0])})</span>
            )}
          </p>
          <p className="text-sm text-gray-600">
            {agreement.pricingMode === 'flat'
              ? `Flat ${formatCzk(agreement.flatNightPriceCzk ?? 0)} per night`
              : `Web price${agreement.discountPercent > 0 ? ` minus ${agreement.discountPercent}%` : ''}`}{' '}
            · {agreement.adults} adult{agreement.adults === 1 ? '' : 's'}
            {agreement.children > 0 ? `, ${agreement.children} child${agreement.children === 1 ? '' : 'ren'}` : ''} · invoiced{' '}
            {BILLING_CADENCE_LABELS[agreement.billingCadence].toLowerCase()}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {canEdit && toCreate.length > 0 && agreement.status !== 'cancelled' && (
            <button
              onClick={() => void createBookings()}
              disabled={busy !== null || unpriced.length > 0}
              title={unpriced.length > 0 ? `${unpriced.length} stay(s) have no price yet` : undefined}
              className="px-3 py-2 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium disabled:opacity-50 shadow-sm"
            >
              {busy === 'create' ? 'Creating…' : `Create ${toCreate.length} booking${toCreate.length === 1 ? '' : 's'} in Beds24`}
            </button>
          )}
          <button
            onClick={() => void downloadOffer()}
            disabled={busy !== null || s.stays - s.skipped - s.cancelled === 0}
            title="PDF offer for the company: dates, apartment types, nights, rate per night, total"
            className="px-3 py-2 rounded-md bg-white border border-emerald-200 text-emerald-700 text-sm font-medium hover:bg-emerald-50 disabled:opacity-50 shadow-sm"
          >
            {busy === 'offer' ? 'Preparing PDF…' : 'Offer PDF'}
          </button>
          {canEdit && (
            <button
              onClick={() => setEditing((v) => !v)}
              className="px-3 py-2 rounded-md bg-white border border-gray-200 text-gray-700 text-sm font-medium hover:bg-gray-50 shadow-sm"
            >
              {editing ? 'Close editor' : 'Edit details'}
            </button>
          )}
          <button onClick={onClose} className="px-2 py-2 text-gray-400 hover:text-gray-600 text-sm" title="Close">
            ✕
          </button>
        </div>
      </div>

      {(error || lastRun) && (
        <div className="px-4 sm:px-6 pt-3 space-y-2">
          {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          {lastRun && (
            <div
              className={`rounded-md border px-3 py-2 text-sm ${
                lastRun.failed > 0 ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-green-200 bg-green-50 text-green-800'
              }`}
            >
              {lastRun.created} booking{lastRun.created === 1 ? '' : 's'} created
              {lastRun.failed > 0 ? `, ${lastRun.failed} refused by Beds24 — see the rows marked Failed.` : '.'}
            </div>
          )}
        </div>
      )}

      {/* ── Facts + editor ── */}
      <div className="px-4 sm:px-6 py-4 grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
        <FactBlock title="Billing">
          <Fact label="Address" value={agreement.companyAddress} />
          <Fact label="IČO" value={agreement.ico} />
          <Fact label="DIČ / VAT" value={agreement.vatNumber} />
          <Fact label="Invoice email" value={agreement.billingEmail} />
        </FactBlock>
        <FactBlock title="Company contact">
          <Fact label="Name" value={agreement.repName} />
          <Fact label="Phone" value={agreement.repPhone} />
          <Fact label="Email" value={agreement.repEmail} />
        </FactBlock>
        <FactBlock title="Default guest">
          <Fact label="Name" value={joinGuestName(agreement.guestFirstName, agreement.guestLastName) || null} />
          <Fact label="Phone" value={agreement.guestPhone} />
          <Fact label="Email" value={agreement.guestEmail} />
          <Fact label="Nationality" value={agreement.nationality} />
        </FactBlock>
        {agreement.notes && (
          <div className="md:col-span-3 text-gray-600">
            <span className="text-[11px] uppercase tracking-wide text-gray-400 mr-2">Notes</span>
            {agreement.notes}
          </div>
        )}
        <div className="md:col-span-3 text-[11px] text-gray-400">
          Created {new Date(agreement.createdAt).toLocaleString('en-GB')} by {agreement.createdBy}
          {s.firstArrival && s.lastDeparture && (
            <>
              {' '}· stays {formatStayDate(s.firstArrival)} → {formatStayDate(s.lastDeparture)} · {s.nights} nights · {formatCzk(s.priceCzk)}
              {avgNight !== null && ` · avg ${formatCzk(avgNight)}/night`}
              {s.unpriced > 0 && ` (${s.unpriced} unpriced)`}
            </>
          )}
        </div>
      </div>

      {editing && canEdit && (
        <AgreementEditor
          agreement={agreement}
          busy={busy === 'agreement'}
          onSave={(body) => void patchAgreement(body).then(() => setEditing(false))}
          onDelete={s.created === 0 && s.cancelled === 0 ? () => void deleteAgreement() : undefined}
          onStatus={(status) => void patchAgreement({ status })}
        />
      )}

      {/* ── Stays ── */}
      <div className="border-t border-gray-100">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="text-left px-4 py-2 font-medium">#</th>
                <th className="text-left px-3 py-2 font-medium">Dates</th>
                <th className="text-right px-3 py-2 font-medium">Nights</th>
                <th className="text-left px-3 py-2 font-medium">Room</th>
                <th className="text-left px-3 py-2 font-medium">Guest</th>
                <th className="text-right px-3 py-2 font-medium">Price</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                {canEdit && <th className="text-right px-4 py-2 font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {agreement.stays.map((stay) => (
                <StayRow
                  key={stay.id}
                  stay={stay}
                  agreement={agreement}
                  canEdit={canEdit}
                  busy={busy}
                  onRun={run}
                  onRefresh={refresh}
                  onCreate={() => void createBookings([stay.id])}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function FactBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">{title}</div>
      <dl className="space-y-0.5">{children}</dl>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-gray-400">{label}</dt>
      <dd className={value ? 'text-gray-800 break-all' : 'text-gray-300'}>{value ?? '—'}</dd>
    </div>
  );
}

// ─── Inline agreement editor ─────────────────────────────────────────────────

function AgreementEditor({
  agreement,
  busy,
  onSave,
  onDelete,
  onStatus,
}: {
  agreement: AgreementDetailDto;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => void;
  onDelete?: () => void;
  onStatus: (status: 'active' | 'completed' | 'cancelled') => void;
}) {
  const [f, setF] = useState({
    companyName: agreement.companyName,
    companyAddress: agreement.companyAddress ?? '',
    ico: agreement.ico ?? '',
    vatNumber: agreement.vatNumber ?? '',
    billingEmail: agreement.billingEmail ?? '',
    billingCadence: agreement.billingCadence as BillingCadence,
    repName: agreement.repName ?? '',
    repPhone: agreement.repPhone ?? '',
    repEmail: agreement.repEmail ?? '',
    guestFirstName: agreement.guestFirstName ?? '',
    guestLastName: agreement.guestLastName ?? '',
    guestPhone: agreement.guestPhone ?? '',
    guestEmail: agreement.guestEmail ?? '',
    notes: agreement.notes ?? '',
  });
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));

  return (
    <div className="mx-4 sm:mx-6 mb-4 rounded-lg border border-indigo-100 bg-indigo-50/40 p-4 space-y-4">
      <p className="text-xs text-gray-500">
        Schedule, room types and pricing are fixed once an agreement is saved — they define the stays. Change contacts and billing here;
        for a new pattern create a new agreement.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Field label="Company name">
          <input className={inputCls} value={f.companyName} onChange={(e) => set('companyName', e.target.value)} />
        </Field>
        <Field label="Address" optional>
          <input className={inputCls} value={f.companyAddress} onChange={(e) => set('companyAddress', e.target.value)} />
        </Field>
        <Field label="IČO" optional>
          <input className={inputCls} value={f.ico} onChange={(e) => set('ico', e.target.value)} />
        </Field>
        <Field label="DIČ / VAT" optional>
          <input className={inputCls} value={f.vatNumber} onChange={(e) => set('vatNumber', e.target.value)} />
        </Field>
        <Field label="Invoice email" optional>
          <input className={inputCls} value={f.billingEmail} onChange={(e) => set('billingEmail', e.target.value)} />
        </Field>
        <Field label="Invoicing">
          <select className={inputCls} value={f.billingCadence} onChange={(e) => set('billingCadence', e.target.value)}>
            {Object.entries(BILLING_CADENCE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Contact name" optional>
          <input className={inputCls} value={f.repName} onChange={(e) => set('repName', e.target.value)} />
        </Field>
        <Field label="Contact phone" optional>
          <input className={inputCls} value={f.repPhone} onChange={(e) => set('repPhone', e.target.value)} />
        </Field>
        <Field label="Contact email" optional>
          <input className={inputCls} value={f.repEmail} onChange={(e) => set('repEmail', e.target.value)} />
        </Field>
        <Field label="Default guest first name" optional hint="Used for stays created from now on; existing bookings keep their guest.">
          <input className={inputCls} value={f.guestFirstName} onChange={(e) => set('guestFirstName', e.target.value)} />
        </Field>
        <Field label="Default guest last name" optional>
          <input className={inputCls} value={f.guestLastName} onChange={(e) => set('guestLastName', e.target.value)} />
        </Field>
        <Field label="Default guest phone" optional>
          <input className={inputCls} value={f.guestPhone} onChange={(e) => set('guestPhone', e.target.value)} />
        </Field>
        <Field label="Default guest email" optional>
          <input className={inputCls} value={f.guestEmail} onChange={(e) => set('guestEmail', e.target.value)} />
        </Field>
        <div className="sm:col-span-2 lg:col-span-3">
          <Field label="Notes" optional>
            <input className={inputCls} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
          </Field>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => onSave(f)}
          disabled={busy || !f.companyName.trim()}
          className="px-3 py-2 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save details'}
        </button>
        <span className="flex-1" />
        {agreement.status !== 'completed' && agreement.status !== 'draft' && (
          <button
            onClick={() => onStatus('completed')}
            disabled={busy}
            className="px-3 py-2 rounded-md bg-white border border-gray-200 text-gray-700 text-sm hover:bg-gray-50"
          >
            Mark completed
          </button>
        )}
        {agreement.status === 'cancelled' ? (
          <button
            onClick={() => onStatus('active')}
            disabled={busy}
            className="px-3 py-2 rounded-md bg-white border border-gray-200 text-gray-700 text-sm hover:bg-gray-50"
          >
            Reactivate
          </button>
        ) : (
          <button
            onClick={() => {
              if (window.confirm('Cancel this agreement? Bookings already in Beds24 stay as they are — cancel them stay by stay if needed.'))
                onStatus('cancelled');
            }}
            disabled={busy}
            className="px-3 py-2 rounded-md bg-white border border-rose-200 text-rose-700 text-sm hover:bg-rose-50"
          >
            Cancel agreement
          </button>
        )}
        {onDelete && (
          <button
            onClick={onDelete}
            disabled={busy}
            className="px-3 py-2 rounded-md bg-rose-600 hover:bg-rose-700 text-white text-sm font-medium"
            title="Only possible while nothing exists in Beds24"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

// ─── One stay row ────────────────────────────────────────────────────────────

function StayRow({
  stay,
  agreement,
  canEdit,
  busy,
  onRun,
  onRefresh,
  onCreate,
}: {
  stay: CorporateStay;
  agreement: AgreementDetailDto;
  canEdit: boolean;
  busy: string | null;
  onRun: (key: string, fn: () => Promise<void>) => Promise<void>;
  onRefresh: () => Promise<void>;
  onCreate: () => void;
}) {
  const [editGuest, setEditGuest] = useState(false);
  const [guestName, setGuestName] = useState(joinGuestName(stay.guestFirstName, stay.guestLastName));
  const [guestPhone, setGuestPhone] = useState(stay.guestPhone ?? '');
  const [guestEmail, setGuestEmail] = useState(stay.guestEmail ?? '');
  const [price, setPrice] = useState(stay.priceCzk === null ? '' : String(stay.priceCzk));

  const inheritedName = joinGuestName(agreement.guestFirstName, agreement.guestLastName);
  const ownName = joinGuestName(stay.guestFirstName, stay.guestLastName);
  const ownPhone = stay.guestPhone ?? agreement.guestPhone ?? agreement.repPhone ?? '';
  const editable = stay.status === 'planned' || stay.status === 'failed';
  const rowBusy = busy === `stay:${stay.id}`;

  async function patch(body: Record<string, unknown>) {
    await onRun(`stay:${stay.id}`, async () => {
      await api(`/api/corporate/stays/${encodeURIComponent(stay.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
      await onRefresh();
    });
  }

  async function saveGuest() {
    const { first, last } = splitGuestName(guestName);
    await patch({
      guestFirstName: first,
      guestLastName: last,
      guestPhone: guestPhone.trim() || null,
      guestEmail: guestEmail.trim() || null,
    });
    setEditGuest(false);
  }

  async function savePrice() {
    const n = Number(price.replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) return;
    if (n === (stay.priceCzk ?? -1)) return;
    await patch({ priceCzk: n });
  }

  async function cancelStay() {
    const reason = window.prompt(
      `Cancel ${stay.reservationNumber} (${formatStayRange(stay.arrival, stay.departure)}) in Beds24? The nights go back on sale.\n\nReason (optional):`,
    );
    if (reason === null) return;
    await onRun(`stay:${stay.id}`, async () => {
      await api(`/api/corporate/stays/${encodeURIComponent(stay.id)}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
      await onRefresh();
      void fetch('/api/bookings?fullSync=true').catch(() => {});
    });
  }

  const dim = stay.status === 'skipped' || stay.status === 'cancelled';

  return (
    <tr className={dim ? 'bg-gray-50/60 text-gray-400' : ''}>
      <td className="px-4 py-2 text-xs tabular-nums">{stay.seq}</td>
      <td className="px-3 py-2 whitespace-nowrap">{formatStayRange(stay.arrival, stay.departure)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{stay.nights}</td>
      <td className="px-3 py-2 whitespace-nowrap">
        {canEdit && editable ? (
          <select
            className={smallInputCls}
            value={stay.roomId}
            disabled={rowBusy}
            onChange={(e) => void patch({ roomId: Number(e.target.value) })}
            title="Room type for this stay"
          >
            <RoomTypeOptions agreed={agreement.roomIds} />
          </select>
        ) : (
          <span title={roomLabelFor(stay.roomId)}>{roomShortLabel(stay.roomId)}</span>
        )}
      </td>
      <td className="px-3 py-2 min-w-[180px]">
        {editGuest ? (
          <div className="space-y-1">
            <input
              className={smallInputCls}
              placeholder="First Last"
              value={guestName}
              onChange={(e) => setGuestName(e.target.value)}
              autoFocus
            />
            <input className={smallInputCls} placeholder="Phone" value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} />
            <input className={smallInputCls} placeholder="Email" value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} />
            <div className="flex gap-1">
              <button
                onClick={() => void saveGuest()}
                disabled={rowBusy}
                className="px-2 py-1 rounded bg-indigo-600 text-white text-[11px] font-medium disabled:opacity-50"
              >
                {rowBusy ? 'Saving…' : stay.status === 'created' ? 'Save & update Beds24' : 'Save'}
              </button>
              <button onClick={() => setEditGuest(false)} className="px-2 py-1 rounded text-[11px] text-gray-500 hover:bg-gray-100">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={!canEdit || stay.status === 'cancelled'}
            onClick={() => setEditGuest(true)}
            className="text-left group disabled:cursor-default"
            title={canEdit ? 'Edit the guest for this stay' : undefined}
          >
            {ownName ? (
              <span className="text-gray-800 group-hover:underline">{ownName}</span>
            ) : inheritedName ? (
              <span className="text-gray-600 italic group-hover:underline">{inheritedName}</span>
            ) : (
              <span className="text-amber-600 group-hover:underline">guest TBA</span>
            )}
            {ownPhone && <div className="text-[11px] text-gray-400">{ownPhone}</div>}
          </button>
        )}
      </td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        {canEdit && editable ? (
          <div>
            <input
              className={`${smallInputCls} text-right w-24 ml-auto`}
              value={price}
              disabled={rowBusy}
              onChange={(e) => setPrice(e.target.value)}
              onBlur={() => void savePrice()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              placeholder="CZK"
            />
            {stay.priceSource && <div className="text-[10px] text-gray-400">{PRICE_SOURCE_LABEL[stay.priceSource]}</div>}
          </div>
        ) : (
          <div>
            <span className={stay.priceCzk === null ? 'text-amber-600' : 'tabular-nums'}>
              {stay.priceCzk === null ? 'no price' : formatCzk(stay.priceCzk)}
            </span>
            {stay.priceSource && <div className="text-[10px] text-gray-400">{PRICE_SOURCE_LABEL[stay.priceSource]}</div>}
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <StayStatusBadge status={stay.status} />
          {stay.reservationNumber && <CopyText value={stay.reservationNumber} />}
          {stay.status === 'failed' && stay.error && (
            <span className="text-[11px] text-red-600 max-w-[260px] whitespace-normal">{stay.error}</span>
          )}
        </div>
      </td>
      {canEdit && (
        <td className="px-4 py-2 text-right whitespace-nowrap">
          <div className="inline-flex gap-1">
            {editable && (
              <>
                <button
                  onClick={onCreate}
                  disabled={busy !== null || stay.priceCzk === null || stay.priceCzk <= 0 || agreement.status === 'cancelled'}
                  title={stay.priceCzk === null ? 'Set a price first' : 'Create this booking in Beds24'}
                  className="px-2 py-1 rounded border border-indigo-200 text-indigo-700 text-[11px] font-medium hover:bg-indigo-50 disabled:opacity-40"
                >
                  {stay.status === 'failed' ? 'Retry' : 'Create'}
                </button>
                <button
                  onClick={() => void patch({ status: 'skipped' })}
                  disabled={busy !== null}
                  className="px-2 py-1 rounded border border-gray-200 text-gray-600 text-[11px] hover:bg-gray-50 disabled:opacity-40"
                >
                  Skip
                </button>
              </>
            )}
            {stay.status === 'skipped' && (
              <button
                onClick={() => void patch({ status: 'planned' })}
                disabled={busy !== null}
                className="px-2 py-1 rounded border border-gray-200 text-gray-600 text-[11px] hover:bg-gray-50 disabled:opacity-40"
              >
                Unskip
              </button>
            )}
            {stay.status === 'created' && (
              <button
                onClick={() => void cancelStay()}
                disabled={busy !== null}
                className="px-2 py-1 rounded border border-rose-200 text-rose-700 text-[11px] hover:bg-rose-50 disabled:opacity-40"
              >
                Cancel
              </button>
            )}
          </div>
        </td>
      )}
    </tr>
  );
}

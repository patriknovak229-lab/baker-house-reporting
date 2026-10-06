'use client';
/** Small shared pieces for the Corporate tab — labels, badges, inputs. */
import type { ReactNode } from 'react';
import Badge from '@/components/shared/Badge';
import { SELLABLE_UNITS } from '@/utils/stayRequest';
import {
  AGREEMENT_STATUS_LABELS,
  STAY_STATUS_LABELS,
  roomShortLabel,
  type AgreementStatus,
  type StayPriceSource,
  type StayStatus,
} from '@/utils/corporateShared';

export const inputCls =
  'w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 disabled:bg-gray-50 disabled:text-gray-400';

export const smallInputCls =
  'w-full rounded-md border border-gray-200 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-300 disabled:bg-gray-50 disabled:text-gray-400';

export function Field({
  label,
  optional,
  hint,
  children,
}: {
  label: string;
  optional?: boolean;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">
        {label} {optional && <span className="text-gray-400 font-normal">(optional)</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-gray-400">{hint}</p>}
    </div>
  );
}

export function roomLabelFor(roomId: number): string {
  return SELLABLE_UNITS.find((u) => u.roomId === roomId)?.label ?? `room ${roomId}`;
}

export { roomShortLabel };

const STAY_VARIANT: Record<StayStatus, 'gray' | 'green' | 'red' | 'amber' | 'coral'> = {
  planned: 'gray',
  created: 'green',
  failed: 'red',
  skipped: 'amber',
  cancelled: 'coral',
};

export function StayStatusBadge({ status }: { status: StayStatus }) {
  return (
    <Badge variant={STAY_VARIANT[status]} size="xs">
      {STAY_STATUS_LABELS[status]}
    </Badge>
  );
}

const AGREEMENT_VARIANT: Record<AgreementStatus, 'gray' | 'green' | 'blue' | 'coral'> = {
  draft: 'gray',
  active: 'green',
  completed: 'blue',
  cancelled: 'coral',
};

export function AgreementStatusBadge({ status }: { status: AgreementStatus }) {
  return (
    <Badge variant={AGREEMENT_VARIANT[status]} size="xs">
      {AGREEMENT_STATUS_LABELS[status]}
    </Badge>
  );
}

export const PRICE_SOURCE_LABEL: Record<StayPriceSource, string> = {
  flat: 'flat rate',
  offers: 'web price',
  'calendar-nominal': 'nominal (no live offer)',
  manual: 'typed in',
};

/** "First Last" → { first, last }; a single word is a first name. */
export function splitGuestName(full: string): { first: string | null; last: string | null } {
  const t = full.trim().replace(/\s+/g, ' ');
  if (!t) return { first: null, last: null };
  const idx = t.lastIndexOf(' ');
  if (idx === -1) return { first: t, last: null };
  return { first: t.slice(0, idx), last: t.slice(idx + 1) };
}

export function joinGuestName(first: string | null | undefined, last: string | null | undefined): string {
  return [first, last].filter(Boolean).join(' ');
}

/** Click-to-copy for a BH number. */
export function CopyText({ value, className = '' }: { value: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={() => navigator.clipboard?.writeText(value)}
      title="Copy"
      className={`font-mono text-[11px] text-indigo-700 hover:underline ${className}`}
    >
      {value}
    </button>
  );
}

/**
 * <option>s for a stay's room type: the agreement's own types first, then
 * every other sellable type — so a week the agreed types cannot host can go
 * wherever there is vacancy. Any sellable id is accepted by the API.
 */
export function RoomTypeOptions({ agreed }: { agreed: number[] }) {
  const others = SELLABLE_UNITS.map((u) => u.roomId).filter((id) => !agreed.includes(id));
  return (
    <>
      <optgroup label="Agreed types">
        {agreed.map((id) => (
          <option key={id} value={id}>
            {roomShortLabel(id)}
          </option>
        ))}
      </optgroup>
      {others.length > 0 && (
        <optgroup label="Other types">
          {others.map((id) => (
            <option key={id} value={id}>
              {roomShortLabel(id)}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
}

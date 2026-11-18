'use client';
/**
 * Scheduled payment links in the UI: a row (drawer + alerts panel) and the
 * Transactions alert pill. The daily cron does the sending —
 * utils/scheduledPaymentLinks.ts has the rules.
 */
import { useState } from 'react';
import type { ScheduledPaymentLink, ScheduledLinkStatus } from '@/types/scheduledPaymentLink';
import { SCHEDULED_LINK_ALERT_STATUSES } from '@/types/scheduledPaymentLink';

const STATUS: Record<ScheduledLinkStatus, { label: string; cls: string }> = {
  scheduled: { label: 'Scheduled', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  sent: { label: 'Sent', cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  reminded: { label: 'Reminder sent', cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  paid: { label: 'Paid', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  blocked: { label: 'Not sent', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  unpaid: { label: 'Unpaid', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  failed: { label: 'Failed', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  cancelled: { label: 'Cancelled', cls: 'bg-gray-50 text-gray-500 border-gray-200' },
};

/** Needs the operator: an alert status not yet dismissed. */
export function needsAttention(l: ScheduledPaymentLink): boolean {
  return SCHEDULED_LINK_ALERT_STATUSES.includes(l.status) && !l.dismissedAt;
}

const kc = (n: number) => `${Math.round(n).toLocaleString('cs-CZ')} Kč`;

function timeline(l: ScheduledPaymentLink): string {
  const parts = [`Send ${l.sendDate}`];
  if (l.sentAt) parts.push(`sent ${l.sentAt.slice(0, 10)}`);
  if (l.reminderSentAt) parts.push(`reminded ${l.reminderSentAt.slice(0, 10)}`);
  return parts.join(' · ');
}

export function ScheduledLinkRow({
  link,
  onChanged,
  onOpenReservation,
}: {
  link: ScheduledPaymentLink;
  onChanged: () => void;
  /** Alerts panel: clicking the booking opens its drawer. */
  onOpenReservation?: (reservationNumber: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = STATUS[link.status];
  const canCancel = link.status === 'scheduled' || link.status === 'sent' || link.status === 'reminded';
  const alert = needsAttention(link);

  async function act(action: 'cancel' | 'dismiss') {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/stripe/scheduled-links', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: link.id, action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setConfirmCancel(false);
    }
  }

  return (
    <div className="px-3 py-2.5 space-y-1">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-gray-800 truncate">
            {onOpenReservation ? (
              <button type="button" onClick={() => onOpenReservation(link.reservationNumber)} className="font-medium text-indigo-700 hover:underline mr-1">
                {link.guestName || link.guestEmail}
              </button>
            ) : null}
            {link.description}
          </p>
          <p className="text-[10px] text-gray-500">
            {link.allocations.length > 1 && (
              <span className="text-violet-700 font-medium">
                Linked stay · {link.allocations.map((a) => `${a.reservationNumber} ${kc(a.amountCzk)}`).join(' + ')} ·{' '}
              </span>
            )}
            {timeline(link)} · {link.guestEmail}
          </p>
          {alert && link.alertReason && <p className="text-[11px] text-rose-700 mt-0.5">{link.alertReason}</p>}
        </div>
        <div className="text-right shrink-0">
          <p className="text-xs font-medium text-gray-900">{kc(link.amountCzk)}</p>
          <span className={`inline-block mt-0.5 px-1.5 py-px rounded border text-[10px] font-medium ${s.cls}`}>{s.label}</span>
        </div>
      </div>
      {(canCancel || alert) && (
        <div className="flex items-center gap-2 pl-0.5">
          {canCancel && !confirmCancel && (
            <button type="button" disabled={busy} onClick={() => setConfirmCancel(true)} className="text-[11px] text-gray-500 hover:text-rose-600">
              Cancel
            </button>
          )}
          {confirmCancel && (
            <span className="text-[11px] text-gray-600">
              {link.paymentId ? 'Stop it and kill the link already sent?' : 'Stop this scheduled link?'}{' '}
              <button type="button" disabled={busy} onClick={() => act('cancel')} className="font-medium text-rose-600 hover:underline">Yes, cancel</button>{' '}
              <button type="button" onClick={() => setConfirmCancel(false)} className="text-gray-500 hover:underline">No</button>
            </span>
          )}
          {alert && (
            <button type="button" disabled={busy} onClick={() => act('dismiss')} className="text-[11px] text-gray-500 hover:text-gray-800">
              Dismiss alert
            </button>
          )}
          {error && <span className="text-[11px] text-rose-600">{error}</span>}
        </div>
      )}
    </div>
  );
}

/** Transactions pill: scheduled links that need the operator. */
export function ScheduledLinkAlertsPill({
  links,
  open,
  onToggle,
}: {
  links: ScheduledPaymentLink[];
  open: boolean;
  onToggle: () => void;
}) {
  if (links.length === 0) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      title={links.map((l) => `${l.guestName || l.guestEmail}: ${l.alertReason ?? STATUS[l.status].label}`).join('\n')}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
        open ? 'bg-rose-600 text-white border-rose-600' : 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100'
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${open ? 'bg-white' : 'bg-rose-500 animate-pulse'}`} />
      {links.length} payment link{links.length === 1 ? '' : 's'} need{links.length === 1 ? 's' : ''} you
    </button>
  );
}

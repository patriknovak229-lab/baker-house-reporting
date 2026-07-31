'use client';
import { useMemo, useState } from 'react';
import type { Reservation } from '@/types/reservation';
import {
  resolveRecipients,
  tallyRecipients,
  pragueToday,
  type Segment,
  type Delivery,
  type ResolvedRecipient,
} from '@/utils/massMessageRecipients';

interface Props {
  reservations: Reservation[];
  onClose: () => void;
}

type Step = 'compose' | 'confirm' | 'result';

interface BroadcastResult {
  reservationNumber: string;
  name: string;
  room: string;
  channel: string;
  method: 'chat' | 'email' | 'skipped';
  status: 'sent' | 'failed' | 'skipped';
  error?: string;
  reason?: string;
}

const SEGMENT_LABELS: Record<Segment, string> = {
  staying: 'Currently staying',
  arriving: 'Arriving soon',
  leaving: 'Leaving soon',
};

const SEGMENT_HINTS: Record<Segment, string> = {
  staying: 'Everyone on-property today (includes guests arriving or leaving today).',
  arriving: 'Guests whose check-in falls within the window (today counts as day 0).',
  leaving: 'Guests whose check-out falls within the window (today counts as day 0).',
};

function deliveryBadge(delivery: Delivery) {
  if (delivery === 'chat') {
    return <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-sky-100 text-sky-700">Chat</span>;
  }
  if (delivery === 'email') {
    return <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">Email</span>;
  }
  return <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">Unreachable</span>;
}

const REASON_TEXT: Record<string, string> = {
  'no-email': 'no email on file',
  'email-disabled': 'direct email turned off',
  'bad-booking-id': 'no chat channel',
};

function statusBadge(status: BroadcastResult['status']) {
  if (status === 'sent') {
    return <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">Sent</span>;
  }
  if (status === 'failed') {
    return <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-100 text-red-700">Failed</span>;
  }
  return <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">Skipped</span>;
}

export default function MassMessageModal({ reservations, onClose }: Props) {
  const [step, setStep] = useState<Step>('compose');
  const [segment, setSegment] = useState<Segment>('staying');
  const [days, setDays] = useState(3);
  const [message, setMessage] = useState('');
  const [subject, setSubject] = useState('Baker House Apartments');
  const [emailDirect, setEmailDirect] = useState(true);

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [results, setResults] = useState<BroadcastResult[] | null>(null);

  // pragueToday is stable for the life of the modal — capture once.
  const today = useMemo(() => pragueToday(), []);

  // Live preview from the in-memory list — instant, no round-trip. The server
  // re-resolves authoritatively at send time, so this is a faithful preview.
  const recipients = useMemo(
    () => resolveRecipients(reservations, { segment, days, emailDirect, today }),
    [reservations, segment, days, emailDirect, today],
  );
  const counts = useMemo(() => tallyRecipients(recipients), [recipients]);
  const sendableCount = counts.chat + counts.email;

  const canPreview = message.trim().length > 0 && sendableCount > 0;

  async function handleSend() {
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch('/api/messages/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          segment,
          days: segment === 'staying' ? undefined : days,
          message: message.trim(),
          subject: subject.trim() || undefined,
          emailDirect,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setResults(data.results ?? []);
      setStep('result');
    } catch (e) {
      setSendError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  const resultCounts = useMemo(() => {
    if (!results) return { sent: 0, failed: 0, skipped: 0 };
    return {
      sent: results.filter((r) => r.status === 'sent').length,
      failed: results.filter((r) => r.status === 'failed').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
    };
  }, [results]);

  const unreachable = recipients.filter((r) => r.delivery === 'unreachable');

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              Message Guests
              {step === 'confirm' ? ' · Confirm' : step === 'result' ? ' · Sent' : ''}
            </h2>
            <p className="text-[11px] text-gray-500 mt-0.5">
              One-way broadcast · written in English · OTA guests via chat, direct guests via email
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 flex-1 overflow-y-auto space-y-4">
          {/* ── Step 1: compose ── */}
          {step === 'compose' && (
            <>
              <div>
                <p className="text-xs font-medium text-gray-600 mb-1.5">Who should get this?</p>
                <div className="space-y-1.5">
                  {(['staying', 'arriving', 'leaving'] as Segment[]).map((s) => (
                    <label
                      key={s}
                      className={`flex items-start gap-2.5 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                        segment === s ? 'border-sky-400 bg-sky-50' : 'border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      <input
                        type="radio"
                        name="segment"
                        checked={segment === s}
                        onChange={() => setSegment(s)}
                        className="mt-0.5 accent-sky-600"
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900">{SEGMENT_LABELS[s]}</p>
                        <p className="text-[11px] text-gray-500">{SEGMENT_HINTS[s]}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {(segment === 'arriving' || segment === 'leaving') && (
                <div className="flex items-center gap-2">
                  <label className="text-xs font-medium text-gray-600">
                    {segment === 'arriving' ? 'Arriving within the next' : 'Leaving within the next'}
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={60}
                    value={days}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      setDays(Number.isFinite(n) ? Math.min(60, Math.max(0, n)) : 0);
                    }}
                    className="w-16 px-2 py-1.5 border border-gray-200 rounded-lg text-sm text-center focus:outline-none focus:ring-2 focus:ring-sky-300"
                  />
                  <span className="text-xs text-gray-600">day(s) — including today</span>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Message <span className="text-gray-400 font-normal">(English — sent exactly as written)</span>
                </label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={5}
                  placeholder="e.g. Heads up: the building will have a planned electricity outage tomorrow 09:00–12:00. Lifts and Wi-Fi will be affected. Apologies for the inconvenience."
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-300 resize-y"
                />
              </div>

              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={emailDirect}
                    onChange={(e) => setEmailDirect(e.target.checked)}
                    className="accent-sky-600"
                  />
                  <span className="text-xs text-gray-700">
                    Also email direct-booking guests (no chat channel available)
                  </span>
                </label>
                {emailDirect && (
                  <input
                    type="text"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="Email subject"
                    className="mt-2 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-300"
                  />
                )}
              </div>

              {/* Live preview */}
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-600">
                  <span className="font-semibold text-gray-800">
                    {sendableCount} guest{sendableCount === 1 ? '' : 's'} will be messaged
                  </span>
                  <span>· {counts.chat} chat</span>
                  <span>· {counts.email} email</span>
                  {counts.unreachable > 0 && (
                    <span className="text-amber-700">· {counts.unreachable} unreachable</span>
                  )}
                </div>
                {recipients.length > 0 ? (
                  <div className="mt-2 max-h-40 overflow-y-auto divide-y divide-gray-100">
                    {recipients.map((r) => (
                      <RecipientRow key={r.reservationNumber} r={r} />
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-[11px] text-gray-400">No guests match this segment right now.</p>
                )}
              </div>
            </>
          )}

          {/* ── Step 2: confirm ── */}
          {step === 'confirm' && (
            <>
              <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3">
                <p className="text-sm font-semibold text-sky-900">
                  Send to {sendableCount} guest{sendableCount === 1 ? '' : 's'}?
                </p>
                <p className="text-[11px] text-sky-800 mt-0.5">
                  {counts.chat} via chat · {counts.email} via email. This can&apos;t be undone.
                </p>
              </div>

              <div>
                <p className="text-xs font-medium text-gray-600 mb-1">Message</p>
                <p className="text-sm text-gray-800 whitespace-pre-wrap rounded-lg border border-gray-200 bg-white px-3 py-2">
                  {message.trim()}
                </p>
              </div>

              <div>
                <p className="text-xs font-medium text-gray-600 mb-1">Recipients</p>
                <div className="max-h-48 overflow-y-auto divide-y divide-gray-100 rounded-lg border border-gray-200">
                  {recipients
                    .filter((r) => r.delivery !== 'unreachable')
                    .map((r) => (
                      <RecipientRow key={r.reservationNumber} r={r} padded />
                    ))}
                </div>
              </div>

              {unreachable.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                  <p className="text-[11px] font-semibold text-amber-800">
                    {unreachable.length} guest{unreachable.length === 1 ? '' : 's'} can&apos;t be reached
                    automatically — follow up by hand:
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {unreachable.map((r) => (
                      <li key={r.reservationNumber} className="text-[11px] text-amber-700">
                        {r.name} · {r.room} ({REASON_TEXT[r.reason ?? ''] ?? 'unreachable'})
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <p className="text-[11px] text-gray-500">
                This is one-way. Guest replies appear in each guest&apos;s individual conversation.
              </p>

              {sendError && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {sendError}
                </p>
              )}
            </>
          )}

          {/* ── Step 3: result ── */}
          {step === 'result' && results && (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-semibold text-emerald-700">{resultCounts.sent} sent</span>
                {resultCounts.failed > 0 && (
                  <span className="font-semibold text-red-600">· {resultCounts.failed} failed</span>
                )}
                {resultCounts.skipped > 0 && (
                  <span className="text-gray-500">· {resultCounts.skipped} skipped</span>
                )}
              </div>

              <div className="max-h-72 overflow-y-auto divide-y divide-gray-100 rounded-lg border border-gray-200">
                {results.map((r) => (
                  <div key={r.reservationNumber} className="flex items-start gap-2 px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-900 truncate">
                        {r.name} <span className="text-gray-400">· {r.room}</span>
                      </p>
                      {r.status === 'failed' && r.error && (
                        <p className="text-[11px] text-red-600 truncate">{r.error}</p>
                      )}
                      {r.status === 'skipped' && r.reason && (
                        <p className="text-[11px] text-gray-400">{REASON_TEXT[r.reason] ?? r.reason}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-[10px] text-gray-400 uppercase">{r.method}</span>
                      {statusBadge(r.status)}
                    </div>
                  </div>
                ))}
              </div>

              {resultCounts.failed > 0 && (
                <p className="text-[11px] text-gray-500">
                  Failed sends weren&apos;t delivered. Close and re-run the broadcast to retry — already-sent
                  guests will simply receive it again unless you narrow the segment.
                </p>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-100 flex justify-between gap-2">
          <div>
            {step === 'confirm' && (
              <button
                onClick={() => {
                  setSendError(null);
                  setStep('compose');
                }}
                disabled={sending}
                className="px-3 py-2 text-sm text-gray-600 hover:text-gray-900 disabled:opacity-40"
              >
                ← Back
              </button>
            )}
          </div>
          <div className="flex gap-2">
            {step === 'result' ? (
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm bg-sky-500 text-white rounded-md hover:bg-sky-600"
              >
                Done
              </button>
            ) : (
              <button
                onClick={onClose}
                disabled={sending}
                className="px-4 py-2 text-sm text-gray-700 border border-gray-200 rounded-md hover:bg-gray-50 disabled:opacity-40"
              >
                Cancel
              </button>
            )}
            {step === 'compose' && (
              <button
                onClick={() => setStep('confirm')}
                disabled={!canPreview}
                className="px-4 py-2 text-sm bg-sky-500 text-white rounded-md hover:bg-sky-600 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Review recipients
              </button>
            )}
            {step === 'confirm' && (
              <button
                onClick={handleSend}
                disabled={sending || sendableCount === 0}
                className="px-4 py-2 text-sm bg-sky-500 text-white rounded-md hover:bg-sky-600 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {sending ? 'Sending…' : `Send to ${sendableCount}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RecipientRow({ r, padded }: { r: ResolvedRecipient; padded?: boolean }) {
  return (
    <div className={`flex items-center gap-2 ${padded ? 'px-3 py-2' : 'py-1.5'}`}>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-gray-900 truncate">
          {r.name} <span className="text-gray-400">· {r.room}</span>
        </p>
      </div>
      <span className="text-[10px] text-gray-400 shrink-0">{r.channel}</span>
      {deliveryBadge(r.delivery)}
    </div>
  );
}

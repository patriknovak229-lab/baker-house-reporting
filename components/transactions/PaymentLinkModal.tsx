'use client';
import { useState, useMemo } from 'react';
import FloatingPanel from '@/components/shared/FloatingPanel';
import { normalizeForSearch } from '@/utils/stringUtils';
import { pragueToday } from '@/utils/periodUtils';
import { isRelayEmail } from '@/utils/stayChains';

/** One booking of a linked stay (prolongation), as offered for a combined link. */
export interface LinkedStayBooking {
  reservationNumber: string;
  checkIn: string;
  checkOut: string;
  room: string;
  price: number;
  /** price − already paid (Beds24 deposit + paid links) — the prefill. */
  outstanding: number;
}

/** Prague date + n days, YYYY-MM-DD. */
function pragueDatePlus(days: number): string {
  const d = new Date(pragueToday() + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const kc = (n: number) => `${Math.round(n).toLocaleString('cs-CZ')} Kč`;

export interface ReservationSummary {
  reservationNumber: string;
  guestName: string;
  email?: string;
  phone?: string;
  checkIn: string;
  checkOut: string;
}

interface Props {
  /** Pre-filled from the reservation when opened from a drawer */
  defaultEmail?:       string;
  defaultPhone?:       string;
  defaultAmount?:      number;
  defaultDescription?: string;
  /** When set (drawer context), the payment is automatically linked to this reservation */
  reservationNumber?:  string;
  /** Guest name passed to accounting when the link is created from a reservation */
  guestName?:          string;
  /** If provided (from TransactionsPage), the "attach to reservation" toggle is shown */
  reservations?:       ReservationSummary[];
  /** Called after a payment link is successfully generated */
  onPaymentCreated?:   () => void;
  /** Drawer context, booking is part of a linked stay: offer one link for every booking. */
  linkedStay?:         LinkedStayBooking[];
  onClose: () => void;
}

type Step = 'form' | 'link' | 'scheduled';

export default function PaymentLinkModal({
  defaultEmail,
  defaultPhone,
  defaultAmount,
  defaultDescription,
  reservationNumber: fixedReservationNumber,
  guestName: fixedGuestName,
  reservations,
  onPaymentCreated,
  linkedStay,
  onClose,
}: Props) {
  const stay = linkedStay && linkedStay.length > 1 ? linkedStay : null;
  const [wholeStay, setWholeStay] = useState(!!stay);
  const [stayAmounts, setStayAmounts] = useState<Record<string, string>>(
    () => Object.fromEntries((stay ?? []).map((b) => [b.reservationNumber, b.outstanding > 0 ? String(b.outstanding) : ''])),
  );
  const stayDescription = stay
    ? `Baker House — stay ${stay[0].checkIn} – ${stay[stay.length - 1].checkOut}`
    : '';
  const stayTotal = (stay ?? []).reduce((s, b) => s + (parseFloat(stayAmounts[b.reservationNumber] ?? '') || 0), 0);

  // Send now (generate a link) or schedule an email for a later date (daily cron).
  const [when, setWhen] = useState<'now' | 'schedule'>('now');
  const [sendDate, setSendDate] = useState(pragueDatePlus(1));
  const [step, setStep]               = useState<Step>('form');
  const [description, setDescription] = useState((linkedStay && linkedStay.length > 1 ? `Baker House — stay ${linkedStay[0].checkIn} – ${linkedStay[linkedStay.length - 1].checkOut}` : defaultDescription) ?? '');
  const [amount, setAmount]           = useState(defaultAmount ? String(defaultAmount) : '');
  const [email, setEmail]             = useState(defaultEmail  ?? '');
  const [phone, setPhone]             = useState(defaultPhone  ?? '');

  // A whole-stay link pays the bookings themselves, so it starts as a main payment.
  const [isMainPayment, setIsMainPayment] = useState(!!(linkedStay && linkedStay.length > 1));

  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [paymentUrl, setPaymentUrl]   = useState('');

  const [sendingEmail, setSendingEmail]   = useState(false);
  const [emailSent, setEmailSent]         = useState(false);
  const [emailError, setEmailError]       = useState<string | null>(null);
  const [copied, setCopied]               = useState(false);

  // Reservation attachment
  const [attachToggle, setAttachToggle]       = useState(false);
  const [resSearch, setResSearch]             = useState('');
  const [selectedRes, setSelectedRes]         = useState<ReservationSummary | null>(null);

  const filteredReservations = useMemo(() => {
    if (!reservations || !resSearch.trim()) return reservations ?? [];
    const q = normalizeForSearch(resSearch);
    return reservations.filter(
      (r) =>
        normalizeForSearch(r.guestName).includes(q) ||
        r.reservationNumber.toLowerCase().includes(q),
    );
  }, [reservations, resSearch]);

  function handleSelectRes(r: ReservationSummary) {
    setSelectedRes(r);
    if (r.email && !email) setEmail(r.email);
    if (r.phone && !phone) setPhone(r.phone);
    if (!description) setDescription(`Baker House — reservation ${r.reservationNumber}`);
    setResSearch('');
  }

  function handleDetachRes() {
    setSelectedRes(null);
  }

  /** Bookings + amounts this payment is for; null = free-standing link (no booking). */
  function buildAllocations(): { reservationNumber: string; amountCzk: number }[] | null {
    if (stay && wholeStay) {
      return stay.map((b) => ({ reservationNumber: b.reservationNumber, amountCzk: parseFloat(stayAmounts[b.reservationNumber] ?? '') || 0 }));
    }
    const rn = fixedReservationNumber ?? selectedRes?.reservationNumber;
    return rn ? [{ reservationNumber: rn, amountCzk: parseFloat(amount) || 0 }] : null;
  }

  async function handleGenerate() {
    const allocations = buildAllocations();
    const amountNum = stay && wholeStay ? stayTotal : parseFloat(amount);
    if (!description.trim()) { setError('Description is required'); return; }
    if (allocations && allocations.length > 1) {
      const empty = allocations.find((a) => !(a.amountCzk >= 1));
      if (empty) { setError(`Enter an amount for ${empty.reservationNumber} (min. 1 Kč)`); return; }
    }
    if (!amountNum || amountNum < 1) { setError('Enter a valid amount (min. 1 Kč)'); return; }
    if (when === 'schedule') {
      if (!allocations) { setError('A scheduled link must be attached to a reservation'); return; }
      if (!email.trim()) { setError('A scheduled link is emailed — enter the guest email'); return; }
      if (isRelayEmail(email)) { setError("That's a Booking.com/Airbnb relay address — use the guest's own email, or send the link yourself"); return; }
      if (!sendDate || sendDate <= pragueToday()) { setError('Pick a date from tomorrow on — for today use Send now'); return; }
    }

    setLoading(true);
    setError(null);
    try {
      if (when === 'schedule') {
        const res = await fetch('/api/stripe/scheduled-links', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            allocations,
            description:   description.trim(),
            isMainPayment,
            sendDate,
            guestEmail:    email.trim(),
            guestPhone:    phone.trim() || undefined,
            guestName:     fixedGuestName ?? selectedRes?.guestName,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Failed to schedule the payment link');
        setStep('scheduled');
        onPaymentCreated?.();
        return;
      }

      const res = await fetch('/api/stripe/payment-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amountCzk:         amountNum,
          description:       description.trim(),
          guestEmail:        email.trim() || undefined,
          guestPhone:        phone.trim() || undefined,
          reservationNumber: fixedReservationNumber ?? selectedRes?.reservationNumber,
          guestName:         fixedGuestName ?? selectedRes?.guestName,
          isMainPayment:     isMainPayment || undefined,
          ...(allocations && allocations.length > 1 ? { allocations } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to create payment link');
      if (stay && wholeStay) setAmount(String(amountNum)); // the "link ready" summary shows the total
      setPaymentUrl(data.url);
      setStep('link');
      onPaymentCreated?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSendEmail() {
    if (!email.trim()) { setEmailError('Enter a guest email first'); return; }
    setSendingEmail(true);
    setEmailError(null);
    try {
      const res = await fetch('/api/stripe/send-payment-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to:          email.trim(),
          description: description.trim(),
          amountCzk:   parseFloat(amount),
          paymentUrl,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error ?? 'Failed to send email');
      }
      setEmailSent(true);
    } catch (e) {
      setEmailError((e as Error).message);
    } finally {
      setSendingEmail(false);
    }
  }

  function handleCopy() {
    navigator.clipboard.writeText(paymentUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleWhatsApp() {
    const text = encodeURIComponent(
      `Hi, here is your payment link for ${description}: ${paymentUrl}`
    );
    const num = phone.replace(/\D/g, '');
    window.open(`https://wa.me/${num}?text=${text}`, '_blank');
  }

  return (
    <FloatingPanel
      id={fixedReservationNumber ? `payment-link:${fixedReservationNumber}` : 'payment-link'}
      title={step === 'form' ? 'Request Payment' : step === 'scheduled' ? 'Payment Link Scheduled' : 'Payment Link Ready'}
      subtitle={fixedReservationNumber ? [fixedGuestName, fixedReservationNumber].filter(Boolean).join(' · ') : undefined}
      chipLabel={fixedGuestName ? `Payment · ${fixedGuestName}` : 'Request Payment'}
      onClose={onClose}
    >
      {step === 'form' && (
        <div className="px-6 py-5 space-y-4">

          {/* Attach to reservation toggle (only when reservations are passed in) */}
          {reservations && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => { setAttachToggle((v) => !v); setSelectedRes(null); setResSearch(''); }}
                className="flex items-center gap-2 text-xs font-medium text-gray-600 hover:text-gray-900"
              >
                <span
                  className={`relative inline-flex h-4 w-7 flex-shrink-0 rounded-full border-2 border-transparent transition-colors ${
                    attachToggle ? 'bg-indigo-600' : 'bg-gray-200'
                  }`}
                >
                  <span
                    className={`inline-block h-3 w-3 rounded-full bg-white shadow transform transition-transform ${
                      attachToggle ? 'translate-x-3' : 'translate-x-0'
                    }`}
                  />
                </span>
                Attach to existing reservation
              </button>

              {attachToggle && (
                selectedRes ? (
                  /* Selected reservation chip */
                  <div className="flex items-center gap-2 px-3 py-2 bg-indigo-50 border border-indigo-200 rounded-lg">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-indigo-900 truncate">{selectedRes.guestName}</p>
                      <p className="text-[10px] text-indigo-600">
                        #{selectedRes.reservationNumber} · {selectedRes.checkIn} – {selectedRes.checkOut}
                      </p>
                    </div>
                    <button
                      onClick={handleDetachRes}
                      className="text-indigo-400 hover:text-indigo-600 flex-shrink-0"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ) : (
                  /* Search input + results */
                  <div className="space-y-1">
                    <input
                      type="text"
                      value={resSearch}
                      onChange={(e) => setResSearch(e.target.value)}
                      placeholder="Search guest name or booking #"
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                      autoFocus
                    />
                    {resSearch.trim() && (
                      <div className="max-h-40 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                        {filteredReservations.length === 0 ? (
                          <p className="px-3 py-2 text-xs text-gray-400">No matches</p>
                        ) : (
                          filteredReservations.slice(0, 8).map((r) => (
                            <button
                              key={r.reservationNumber}
                              type="button"
                              onClick={() => handleSelectRes(r)}
                              className="w-full text-left px-3 py-2 hover:bg-indigo-50 transition-colors"
                            >
                              <p className="text-xs font-medium text-gray-900">{r.guestName}</p>
                              <p className="text-[10px] text-gray-500">
                                #{r.reservationNumber} · {r.checkIn} – {r.checkOut}
                              </p>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                )
              )}
            </div>
          )}

          {/* Linked stay — one link for every booking of the stay */}
          {stay && (
            <div className="rounded-lg border border-violet-200 bg-violet-50/60 px-3 py-2.5 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-violet-900">Whole stay — one link</p>
                  <p className="text-[11px] text-violet-700/80">
                    {stay.length} linked bookings · {stay[0].checkIn} – {stay[stay.length - 1].checkOut}
                  </p>
                </div>
                <button
                  type="button"
                  aria-pressed={wholeStay}
                  onClick={() => {
                    const next = !wholeStay;
                    setWholeStay(next);
                    setIsMainPayment(next);
                    setDescription(next ? stayDescription : (defaultDescription ?? ''));
                  }}
                  className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors ${wholeStay ? 'bg-violet-600' : 'bg-gray-200'}`}
                >
                  <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${wholeStay ? 'translate-x-4' : 'translate-x-0'}`} />
                </button>
              </div>
              {wholeStay && (
                <div className="space-y-1.5">
                  {stay.map((b) => (
                    <div key={b.reservationNumber} className="flex items-center gap-2">
                      <div className="flex-1 min-w-0">
                        <p className={`text-xs truncate ${b.reservationNumber === fixedReservationNumber ? 'font-semibold text-gray-900' : 'text-gray-800'}`}>
                          {b.reservationNumber} · {b.room}
                        </p>
                        <p className="text-[10px] text-gray-500">
                          {b.checkIn} – {b.checkOut} · total {kc(b.price)}
                          {b.outstanding < b.price && <span className="text-amber-700"> · {kc(b.price - b.outstanding)} already paid</span>}
                        </p>
                      </div>
                      <div className="relative w-28 shrink-0">
                        <input
                          type="number"
                          min="0"
                          step="1"
                          aria-label={`Amount for ${b.reservationNumber}`}
                          value={stayAmounts[b.reservationNumber] ?? ''}
                          onChange={(e) => setStayAmounts((m) => ({ ...m, [b.reservationNumber]: e.target.value }))}
                          className="w-full pl-2 pr-7 py-1.5 border border-gray-200 rounded-md text-xs text-right text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-violet-300"
                        />
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-gray-400">Kč</span>
                      </div>
                    </div>
                  ))}
                  <div className="flex items-center justify-between pt-1.5 border-t border-violet-200/70">
                    <span className="text-xs text-violet-900">Guest pays once</span>
                    <span className="text-sm font-semibold text-violet-900">{kc(stayTotal)}</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Payment type — only relevant when linked to a reservation */}
          {(fixedReservationNumber || selectedRes) && (
            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-xs font-medium text-gray-700">Main booking payment</p>
                <p className="text-[11px] text-gray-400">
                  {isMainPayment
                    ? 'Counts toward the booking total — shown in the Payment section'
                    : 'Extra charge — shown under Additional Payments'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsMainPayment((v) => !v)}
                className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors ${
                  isMainPayment ? 'bg-indigo-600' : 'bg-gray-200'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
                    isMainPayment ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          )}

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Description *</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Parking, Late checkout, Extension"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-300"
            />
          </div>

          {/* Amount (per booking above for a whole-stay link) */}
          {!(stay && wholeStay) && <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Amount (CZK) *</label>
            <input
              type="number"
              min="1"
              step="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="500"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-300"
            />
          </div>}

          {/* Guest email */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Guest email (optional)</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="guest@example.com"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-300"
            />
          </div>

          {/* Guest phone */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Guest phone (optional, for WhatsApp)</label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+420 123 456 789"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-300"
            />
          </div>

          {/* When — now, or emailed on a later date by the daily run (needs a booking) */}
          {(fixedReservationNumber || selectedRes) && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-1 p-1 bg-gray-100 rounded-lg">
                {(['now', 'schedule'] as const).map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setWhen(w)}
                    className={`py-1.5 text-xs font-medium rounded-md transition-colors ${when === w ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                  >
                    {w === 'now' ? 'Send now' : 'Schedule email'}
                  </button>
                ))}
              </div>
              {when === 'schedule' && (
                <div className="rounded-lg border border-blue-100 bg-blue-50/60 px-3 py-2.5 space-y-2">
                  <div className="flex items-center gap-2">
                    <label htmlFor="pl-send-date" className="text-xs font-medium text-gray-700">Email the link on</label>
                    <input
                      id="pl-send-date"
                      type="date"
                      min={pragueDatePlus(1)}
                      value={sendDate}
                      onChange={(e) => setSendDate(e.target.value)}
                      className="px-2 py-1 border border-gray-200 rounded-md text-xs text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-300"
                    />
                  </div>
                  <ul className="text-[11px] text-blue-900/80 space-y-0.5 list-disc pl-4">
                    <li>Sent by email around 10:00 on that day, to the address above.</li>
                    <li>Not sent — you get an alert instead — if the amount no longer matches the booking total (paid in part, price changed, cancelled).</li>
                    <li>Unpaid the next day → one reminder with a fresh link. Still unpaid → alert here and in the operations Telegram group.</li>
                  </ul>
                  {email.trim() && isRelayEmail(email) && (
                    <p className="text-[11px] text-rose-700">This is a Booking.com/Airbnb relay address — it needs the guest&apos;s own email.</p>
                  )}
                </div>
              )}
            </div>
          )}

          {error && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          )}

          <button
            onClick={handleGenerate}
            disabled={loading}
            className="w-full py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-40 transition-colors"
          >
            {loading
              ? (when === 'schedule' ? 'Scheduling…' : 'Generating…')
              : when === 'schedule'
                ? `Schedule email for ${sendDate}`
                : stay && wholeStay ? `Generate one link · ${kc(stayTotal)}` : 'Generate Payment Link'}
          </button>
        </div>
      )}

      {step === 'scheduled' && (
        <div className="px-6 py-5 space-y-4">
          <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 space-y-1">
            <p className="text-sm font-medium text-gray-900">{description}</p>
            <p className="text-xl font-bold text-blue-700">{kc(stay && wholeStay ? stayTotal : parseFloat(amount) || 0)}</p>
            <p className="text-xs text-gray-600">
              Will be emailed to {email.trim()} on <span className="font-medium">{sendDate}</span>.
              It shows under Scheduled payment links in the drawer, where you can cancel it.
            </p>
          </div>
          <button onClick={onClose} className="w-full py-2 text-sm text-gray-500 hover:text-gray-700">Done</button>
        </div>
      )}

      {step === 'link' && (
        <div className="px-6 py-5 space-y-4">
          {/* Summary */}
          <div className="bg-gray-50 rounded-xl px-4 py-3 space-y-1">
            <p className="text-sm font-medium text-gray-900">{description}</p>
            <p className="text-xl font-bold text-indigo-700">
              {parseFloat(amount).toLocaleString('cs-CZ')} Kč
            </p>
            {selectedRes && (
              <p className="text-xs text-gray-500">
                Reservation #{selectedRes.reservationNumber} · {selectedRes.guestName}
              </p>
            )}
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

          {/* Actions */}
          <div className="grid grid-cols-2 gap-3">
            {/* Email */}
            <div className="space-y-1">
              {!emailSent ? (
                <>
                  {!email.trim() && (
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="guest@example.com"
                      className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                    />
                  )}
                  <button
                    onClick={handleSendEmail}
                    disabled={sendingEmail}
                    className="w-full flex items-center justify-center gap-1.5 py-2 border border-indigo-200 text-indigo-700 text-xs font-medium rounded-lg hover:bg-indigo-50 disabled:opacity-40 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                    {sendingEmail ? 'Sending…' : 'Send email'}
                  </button>
                  {emailError && <p className="text-xs text-red-600">{emailError}</p>}
                </>
              ) : (
                <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-center">
                  Email sent ✓
                </p>
              )}
            </div>

            {/* WhatsApp */}
            <button
              onClick={handleWhatsApp}
              disabled={!phone.trim()}
              className="flex items-center justify-center gap-1.5 py-2 border border-green-200 text-green-700 text-xs font-medium rounded-lg hover:bg-green-50 disabled:opacity-40 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                <path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.554 4.116 1.527 5.845L0 24l6.333-1.505A11.955 11.955 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.885 0-3.647-.494-5.17-1.358l-.37-.216-3.758.893.939-3.65-.24-.384A9.96 9.96 0 012 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/>
              </svg>
              WhatsApp
            </button>
          </div>

          {!phone.trim() && (
            <div className="mt-1 space-y-1">
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Phone for WhatsApp (e.g. +420…)"
                className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-300"
              />
            </div>
          )}

          <button
            onClick={onClose}
            className="w-full py-2 text-sm text-gray-500 hover:text-gray-700"
          >
            Done
          </button>
        </div>
      )}
    </FloatingPanel>
  );
}

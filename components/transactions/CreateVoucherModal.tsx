'use client';
import { useState, useMemo } from 'react';
import { normalizeForSearch } from '@/utils/stringUtils';
import type { ReservationSummary } from './PaymentLinkModal';

interface Props {
  /** Pre-filled when opened from a drawer */
  reservationNumber?: string;
  guestName?: string;
  guestEmail?: string;
  guestPhone?: string;
  /** If provided (from TransactionsPage), reservation search is shown */
  reservations?: ReservationSummary[];
  /** Called after a voucher is successfully created */
  onVoucherCreated?: () => void;
  onClose: () => void;
}

type Step = 'form' | 'created';
type DiscountType = 'fixed' | 'percentage';

/** Strip all non-alphanumeric characters for the voucher code */
function sanitizeCode(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, '');
}

function generateCode(firstName: string, value: string): string {
  const name = sanitizeCode(firstName).replace(/\s+/g, '');
  const val = sanitizeCode(value);
  if (!name) return val;
  // Capitalize first letter
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase() + val;
}

export default function CreateVoucherModal({
  reservationNumber: fixedReservationNumber,
  guestName: fixedGuestName,
  guestEmail: defaultEmail,
  guestPhone: defaultPhone,
  reservations,
  onVoucherCreated,
  onClose,
}: Props) {
  const [step, setStep] = useState<Step>('form');
  const [discountType, setDiscountType] = useState<DiscountType>('fixed');
  const [value, setValue] = useState('');
  const [email, setEmail] = useState(defaultEmail ?? '');
  const [phone, setPhone] = useState(defaultPhone ?? '');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Created voucher data
  const [createdCode, setCreatedCode] = useState('');
  const [copied, setCopied] = useState(false);

  // Email send
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  // Reservation attachment
  const [attachToggle, setAttachToggle] = useState(!!fixedReservationNumber);
  const [resSearch, setResSearch] = useState('');
  const [selectedRes, setSelectedRes] = useState<ReservationSummary | null>(null);

  // Derive the guest first name for code generation
  const guestFirstName = fixedGuestName?.split(' ')[0]
    ?? selectedRes?.guestName.split(' ')[0]
    ?? '';

  // Auto-generated code preview
  const codePreview = generateCode(guestFirstName, value);

  const filteredReservations = useMemo(() => {
    if (!reservations || !resSearch.trim()) return reservations ?? [];
    const q = normalizeForSearch(resSearch);
    return reservations.filter((r) => {
      const nameNorm = normalizeForSearch(r.guestName);
      const resNum = r.reservationNumber.toLowerCase();
      return nameNorm.includes(q) || resNum.includes(q);
    });
  }, [reservations, resSearch]);

  function handleSelectRes(r: ReservationSummary) {
    setSelectedRes(r);
    if (r.email && !email) setEmail(r.email);
    if (r.phone && !phone) setPhone(r.phone);
    setResSearch('');
  }

  function handleDetachRes() {
    setSelectedRes(null);
  }

  async function handleCreate() {
    const numValue = parseFloat(value);
    if (!numValue || numValue <= 0) {
      setError('Enter a valid value');
      return;
    }
    if (discountType === 'percentage' && numValue > 100) {
      setError('Percentage cannot exceed 100');
      return;
    }
    if (!codePreview) {
      setError('A guest name is needed to generate the voucher code. Link a reservation or enter a name.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/vouchers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: codePreview,
          discountType,
          value: numValue,
          reservationNumber: fixedReservationNumber ?? selectedRes?.reservationNumber,
          guestName: fixedGuestName ?? selectedRes?.guestName,
          guestEmail: email.trim() || undefined,
          guestPhone: phone.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to create voucher');
      setCreatedCode(data.code);
      setStep('created');
      onVoucherCreated?.();
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
      const res = await fetch('/api/vouchers/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: email.trim(),
          guestName: fixedGuestName ?? selectedRes?.guestName ?? '',
          voucherCode: createdCode,
          discountType,
          value: parseFloat(value),
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
    navigator.clipboard.writeText(createdCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleWhatsApp() {
    const discountLabel = discountType === 'percentage'
      ? `${value}% off`
      : `${Number(value).toLocaleString('cs-CZ')} Kč discount`;
    const text = encodeURIComponent(
      `Hi! Here is your voucher for Baker House Apartments: ${createdCode} (${discountLabel}). Use it at https://www.bakerhouseapartments.cz`
    );
    const num = phone.replace(/\D/g, '');
    window.open(`https://wa.me/${num}?text=${text}`, '_blank');
  }

  const discountLabel = discountType === 'percentage'
    ? `${value || '—'}%`
    : `${value ? Number(value).toLocaleString('cs-CZ') : '—'} Kč`;

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">
            {step === 'form' ? 'Create Voucher' : 'Voucher Created'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {step === 'form' && (
          <div className="px-6 py-5 space-y-4">

            {/* Reservation link (only when reservations provided and not pre-fixed) */}
            {reservations && !fixedReservationNumber && (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => { setAttachToggle((v) => !v); setSelectedRes(null); setResSearch(''); }}
                  className="flex items-center gap-2 text-xs font-medium text-gray-600 hover:text-gray-900"
                >
                  <span
                    className={`relative inline-flex h-4 w-7 flex-shrink-0 rounded-full border-2 border-transparent transition-colors ${
                      attachToggle ? 'bg-purple-600' : 'bg-gray-200'
                    }`}
                  >
                    <span
                      className={`inline-block h-3 w-3 rounded-full bg-white shadow transform transition-transform ${
                        attachToggle ? 'translate-x-3' : 'translate-x-0'
                      }`}
                    />
                  </span>
                  Link to reservation
                </button>

                {attachToggle && (
                  selectedRes ? (
                    <div className="flex items-center gap-2 px-3 py-2 bg-purple-50 border border-purple-200 rounded-lg">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-purple-900 truncate">{selectedRes.guestName}</p>
                        <p className="text-[10px] text-purple-600">
                          #{selectedRes.reservationNumber} · {selectedRes.checkIn} – {selectedRes.checkOut}
                        </p>
                      </div>
                      <button onClick={handleDetachRes} className="text-purple-400 hover:text-purple-600 flex-shrink-0">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <input
                        type="text"
                        value={resSearch}
                        onChange={(e) => setResSearch(e.target.value)}
                        placeholder="Search guest name or booking #"
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-purple-300"
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
                                className="w-full text-left px-3 py-2 hover:bg-purple-50 transition-colors"
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

            {/* Fixed reservation chip (from drawer context) */}
            {fixedReservationNumber && fixedGuestName && (
              <div className="flex items-center gap-2 px-3 py-2 bg-purple-50 border border-purple-200 rounded-lg">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-purple-900 truncate">{fixedGuestName}</p>
                  <p className="text-[10px] text-purple-600">#{fixedReservationNumber}</p>
                </div>
              </div>
            )}

            {/* Discount type toggle */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">Discount type</label>
              <div className="flex rounded-lg border border-gray-200 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setDiscountType('fixed')}
                  className={`flex-1 py-2 text-xs font-medium transition-colors ${
                    discountType === 'fixed'
                      ? 'bg-purple-600 text-white'
                      : 'bg-white text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  Fixed (CZK)
                </button>
                <button
                  type="button"
                  onClick={() => setDiscountType('percentage')}
                  className={`flex-1 py-2 text-xs font-medium transition-colors ${
                    discountType === 'percentage'
                      ? 'bg-purple-600 text-white'
                      : 'bg-white text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  Percentage (%)
                </button>
              </div>
            </div>

            {/* Value */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                {discountType === 'fixed' ? 'Amount (CZK) *' : 'Percentage (%) *'}
              </label>
              <input
                type="number"
                min="1"
                max={discountType === 'percentage' ? 100 : undefined}
                step="1"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={discountType === 'fixed' ? '500' : '10'}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-purple-300"
              />
            </div>

            {/* Code preview */}
            {codePreview && (
              <div className="bg-purple-50 border border-purple-200 rounded-lg px-4 py-3 text-center">
                <p className="text-[10px] text-purple-600 mb-1">Voucher code</p>
                <p className="text-lg font-bold text-purple-800 tracking-wide">{codePreview}</p>
                <p className="text-[10px] text-purple-500 mt-1">
                  {discountType === 'percentage' ? `${value || '—'}% discount` : `${value ? Number(value).toLocaleString('cs-CZ') : '—'} Kč discount`}
                </p>
              </div>
            )}

            {/* Guest email */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Guest email (optional)</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="guest@example.com"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-purple-300"
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
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-purple-300"
              />
            </div>

            {error && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
            )}

            <button
              onClick={handleCreate}
              disabled={loading}
              className="w-full py-2.5 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 disabled:opacity-40 transition-colors"
            >
              {loading ? 'Creating…' : 'Create Voucher'}
            </button>
          </div>
        )}

        {step === 'created' && (
          <div className="px-6 py-5 space-y-4">
            {/* Voucher card */}
            <div className="bg-purple-50 border-2 border-dashed border-purple-300 rounded-xl px-5 py-5 text-center">
              <p className="text-xs text-purple-600 mb-1">Voucher code</p>
              <p className="text-2xl font-bold text-purple-800 tracking-wider">{createdCode}</p>
              <p className="text-sm text-purple-600 mt-2">Discount: {discountLabel}</p>
              {(fixedGuestName || selectedRes?.guestName) && (
                <p className="text-xs text-purple-500 mt-1">
                  {fixedGuestName ?? selectedRes?.guestName}
                  {(fixedReservationNumber || selectedRes?.reservationNumber) &&
                    ` · #${fixedReservationNumber ?? selectedRes?.reservationNumber}`}
                </p>
              )}
            </div>

            {/* Copy */}
            <button
              onClick={handleCopy}
              className={`w-full flex items-center justify-center gap-2 py-2.5 text-sm font-medium rounded-lg transition-colors ${
                copied ? 'bg-green-100 text-green-700 border border-green-200' : 'bg-gray-100 text-gray-700 border border-gray-200 hover:bg-gray-200'
              }`}
            >
              {copied ? 'Copied!' : 'Copy Code'}
            </button>

            {/* Send actions */}
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
                        className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-purple-300"
                      />
                    )}
                    <button
                      onClick={handleSendEmail}
                      disabled={sendingEmail}
                      className="w-full flex items-center justify-center gap-1.5 py-2 border border-purple-200 text-purple-700 text-xs font-medium rounded-lg hover:bg-purple-50 disabled:opacity-40 transition-colors"
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
              <div className="space-y-1">
                {!phone.trim() && (
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+420…"
                    className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-300"
                  />
                )}
                <button
                  onClick={handleWhatsApp}
                  disabled={!phone.trim()}
                  className="w-full flex items-center justify-center gap-1.5 py-2 border border-green-200 text-green-700 text-xs font-medium rounded-lg hover:bg-green-50 disabled:opacity-40 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                    <path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.554 4.116 1.527 5.845L0 24l6.333-1.505A11.955 11.955 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.885 0-3.647-.494-5.17-1.358l-.37-.216-3.758.893.939-3.65-.24-.384A9.96 9.96 0 012 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/>
                  </svg>
                  WhatsApp
                </button>
              </div>
            </div>

            <button
              onClick={onClose}
              className="w-full py-2 text-sm text-gray-500 hover:text-gray-700"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

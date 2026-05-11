'use client';
import { useState, useEffect, useMemo, useRef } from 'react';
import type { Reservation } from '@/types/reservation';
import { generateCode, generateSuffix } from '@/utils/voucherCode';
import {
  renderThankYouEmail,
  THANK_YOU_SUBJECT,
  DEFAULT_THANK_YOU_BODY,
} from '@/utils/emailTemplates/thankYou';

interface Props {
  reservation: Reservation;
  /** Defaults to additionalEmail → invoiceData.billingEmail → email — caller
   *  passes the resolved best email so this component doesn't duplicate logic. */
  defaultEmail: string;
  onClose: () => void;
  /** Called after a successful send so the parent can refresh / show a toast. */
  onSent?: () => void;
}

interface TemplateOption {
  id: string;
  label: string;
  description: string;
  icon: string;
  disabled?: boolean;
}

const TEMPLATES: TemplateOption[] = [
  {
    id: 'thank-you',
    label: 'Thank You',
    description: 'Thanks the guest for their stay and includes a voucher code',
    icon: '🙏',
  },
];

type Step =
  | 'template'        // pick a template tile
  | 'voucher-choice'  // Generate vs Manual
  | 'voucher-config'  // amount + type (generate path), or code input (manual path)
  | 'preview';        // preview + edit + send (Phase 5/6 — placeholder for now)

type VoucherMode = 'generate' | 'manual';
type DiscountType = 'fixed' | 'percentage';

interface ResolvedVoucher {
  code: string;
  amount: number;
  discountType: DiscountType;
  /** True when the voucher exists server-side. Manual codes are always
   *  persisted (we validated against the existing list); Generate-path
   *  vouchers stay false until the operator hits Send — that way Cancel
   *  never leaves orphan records. */
  persisted: boolean;
}

export default function EmailGuestModal({
  reservation,
  defaultEmail,
  onClose,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onSent,
}: Props) {
  const [step, setStep] = useState<Step>('template');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);

  // Voucher flow state
  const [voucherMode, setVoucherMode] = useState<VoucherMode | null>(null);
  const [voucherAmount, setVoucherAmount] = useState('');
  const [voucherType, setVoucherType] = useState<DiscountType>('fixed');
  const [manualCode, setManualCode] = useState('');
  const [voucherLoading, setVoucherLoading] = useState(false);
  const [voucherError, setVoucherError] = useState<string | null>(null);
  const [resolvedVoucher, setResolvedVoucher] = useState<ResolvedVoucher | null>(null);

  // Preview / edit state (Phase 5)
  const [subject, setSubject] = useState('');
  const [bodyText, setBodyText] = useState(DEFAULT_THANK_YOU_BODY.join('\n\n'));
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Send state (Phase 6)
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Pre-fill subject when we land on preview step
  useEffect(() => {
    if (step === 'preview' && !subject) {
      setSubject(THANK_YOU_SUBJECT(reservation.firstName));
    }
  }, [step, subject, reservation.firstName]);

  // Live HTML render — re-computed on any edit. Cheap, no debounce needed.
  const renderedHtml = useMemo(() => {
    if (!resolvedVoucher) return '';
    const paragraphs = bodyText.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    return renderThankYouEmail({
      firstName: reservation.firstName,
      voucherCode: resolvedVoucher.code,
      voucherAmount:
        resolvedVoucher.discountType === 'percentage'
          ? `${resolvedVoucher.amount}%`
          : `${resolvedVoucher.amount.toLocaleString('cs-CZ')} Kč`,
      bodyParagraphs: paragraphs,
    });
  }, [resolvedVoucher, bodyText, reservation.firstName]);

  // Push the rendered HTML into the iframe whenever it changes
  useEffect(() => {
    if (step !== 'preview') return;
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    doc.open();
    doc.write(renderedHtml);
    doc.close();
  }, [step, renderedHtml]);

  function handlePickTemplate(id: string) {
    setSelectedTemplateId(id);
  }

  function handleContinueFromTemplate() {
    if (!selectedTemplateId) return;
    if (selectedTemplateId === 'thank-you') {
      setStep('voucher-choice');
    }
  }

  function handlePickVoucherMode(mode: VoucherMode) {
    setVoucherMode(mode);
    setVoucherError(null);
    setStep('voucher-config');
  }

  function handleGenerateVoucher() {
    // No API call here — just stage a planned voucher with a locally-generated
    // code. The actual POST /api/vouchers happens in handleSend so that
    // cancelling the flow never leaves an orphan voucher in the database.
    const num = parseFloat(voucherAmount);
    if (!num || num <= 0) {
      setVoucherError('Enter a valid amount');
      return;
    }
    if (voucherType === 'percentage' && num > 100) {
      setVoucherError('Percentage cannot exceed 100');
      return;
    }
    setVoucherError(null);
    const code = generateCode(reservation.firstName, num, generateSuffix());
    setResolvedVoucher({
      code,
      amount: num,
      discountType: voucherType,
      persisted: false,
    });
    setStep('preview');
  }

  async function handleValidateManualCode() {
    const code = manualCode.trim();
    if (!code) {
      setVoucherError('Enter a voucher code');
      return;
    }
    setVoucherLoading(true);
    setVoucherError(null);
    try {
      const res = await fetch(`/api/vouchers/validate?code=${encodeURIComponent(code)}`);
      const data = await res.json();
      if (!data.valid) {
        setVoucherError(data.reason || 'Voucher is not valid');
        return;
      }
      setResolvedVoucher({
        code: data.code,
        amount: data.value,
        discountType: data.discountType,
        persisted: true, // manual code already exists in DB by definition
      });
      setStep('preview');
    } catch (e) {
      setVoucherError((e as Error).message);
    } finally {
      setVoucherLoading(false);
    }
  }

  async function handleSend() {
    if (!resolvedVoucher) return;
    if (!subject.trim()) {
      setSendError('Subject is required');
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      // ── Step 1: persist the voucher if it hasn't been saved yet
      //    (Generate path stages the code locally; this is the moment we
      //    actually commit it to the DB. Manual path is already persisted.)
      let finalCode = resolvedVoucher.code;
      if (!resolvedVoucher.persisted) {
        let attemptedCode = resolvedVoucher.code;
        let saved = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          const res = await fetch('/api/vouchers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              code: attemptedCode,
              discountType: resolvedVoucher.discountType,
              value: resolvedVoucher.amount,
              reservationNumber: reservation.reservationNumber,
              guestName: `${reservation.firstName} ${reservation.lastName}`.trim(),
              guestEmail: defaultEmail || undefined,
              guestPhone: reservation.phone || undefined,
            }),
          });
          if (res.ok) {
            const data = await res.json();
            finalCode = data.code;
            setResolvedVoucher({ ...resolvedVoucher, code: data.code, persisted: true });
            saved = true;
            break;
          }
          if (res.status === 409 && attempt < 2) {
            // Collision on planned code — regenerate suffix and retry
            attemptedCode = generateCode(
              reservation.firstName,
              resolvedVoucher.amount,
              generateSuffix(),
            );
            continue;
          }
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error ?? 'Failed to create voucher');
        }
        if (!saved) {
          throw new Error('Could not save voucher — please try again');
        }
      }

      // ── Step 2: render the email HTML using the final (server-confirmed) code.
      //    Computing it fresh here avoids any stale-closure issue from the
      //    useMemo'd renderedHtml when the code changed on a 409 retry.
      const paragraphs = bodyText.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      const html = renderThankYouEmail({
        firstName: reservation.firstName,
        voucherCode: finalCode,
        voucherAmount:
          resolvedVoucher.discountType === 'percentage'
            ? `${resolvedVoucher.amount}%`
            : `${resolvedVoucher.amount.toLocaleString('cs-CZ')} Kč`,
        bodyParagraphs: paragraphs,
      });

      // ── Step 3: send the email
      const res = await fetch('/api/send-guest-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: defaultEmail,
          subject: subject.trim(),
          html,
          reservationNumber: reservation.reservationNumber,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      onSent?.();
    } catch (e) {
      setSendError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  function handleBack() {
    setVoucherError(null);
    if (step === 'voucher-choice') {
      setStep('template');
    } else if (step === 'voucher-config') {
      setStep('voucher-choice');
    } else if (step === 'preview') {
      setStep('voucher-config');
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className={`bg-white rounded-2xl shadow-xl w-full ${step === 'preview' ? 'max-w-4xl' : 'max-w-md'} max-h-[90vh] overflow-hidden flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              Email Guest{step !== 'template' ? ' · Thank You' : ''}
            </h2>
            <p className="text-[11px] text-gray-500 mt-0.5">
              To: <span className="font-mono">{defaultEmail}</span>
              <span className="text-gray-400"> · from reservations@bakerhouseapartments.cz</span>
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body — varies per step */}
        <div className={`px-6 py-5 ${step === 'preview' ? 'flex-1 overflow-y-auto' : ''} space-y-3`}>

          {/* Step 1: template picker */}
          {step === 'template' && (
            <>
              <p className="text-xs font-medium text-gray-600">Pick a template</p>
              <div className="space-y-2">
                {TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    disabled={tpl.disabled}
                    onClick={() => handlePickTemplate(tpl.id)}
                    className={`w-full text-left px-4 py-3 rounded-lg border transition-colors ${
                      selectedTemplateId === tpl.id
                        ? 'border-indigo-400 bg-indigo-50'
                        : 'border-gray-200 hover:bg-gray-50'
                    } ${tpl.disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                  >
                    <div className="flex items-start gap-3">
                      <span className="text-xl leading-none">{tpl.icon}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900">{tpl.label}</p>
                        <p className="text-[11px] text-gray-500 mt-0.5">{tpl.description}</p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Step 2: voucher mode choice */}
          {step === 'voucher-choice' && (
            <>
              <p className="text-xs font-medium text-gray-600">
                The Thank You email includes a voucher. How should we add it?
              </p>
              <div className="space-y-2">
                <button
                  onClick={() => handlePickVoucherMode('generate')}
                  className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-start gap-3">
                    <span className="text-xl leading-none">✨</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900">Generate a new voucher</p>
                      <p className="text-[11px] text-gray-500 mt-0.5">
                        Creates a fresh code linked to {reservation.firstName}&apos;s reservation
                      </p>
                    </div>
                  </div>
                </button>
                <button
                  onClick={() => handlePickVoucherMode('manual')}
                  className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-start gap-3">
                    <span className="text-xl leading-none">⌨️</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900">Enter an existing code</p>
                      <p className="text-[11px] text-gray-500 mt-0.5">
                        Type in a voucher code you&apos;ve already created
                      </p>
                    </div>
                  </div>
                </button>
              </div>
            </>
          )}

          {/* Step 3a: generate voucher config */}
          {step === 'voucher-config' && voucherMode === 'generate' && (
            <>
              <p className="text-xs font-medium text-gray-600">New voucher details</p>
              <div className="space-y-3">
                <div className="flex rounded-lg border border-gray-200 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setVoucherType('fixed')}
                    className={`flex-1 py-2 text-xs font-medium transition-colors ${
                      voucherType === 'fixed'
                        ? 'bg-indigo-600 text-white'
                        : 'bg-white text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    Fixed (CZK)
                  </button>
                  <button
                    type="button"
                    onClick={() => setVoucherType('percentage')}
                    className={`flex-1 py-2 text-xs font-medium transition-colors ${
                      voucherType === 'percentage'
                        ? 'bg-indigo-600 text-white'
                        : 'bg-white text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    Percentage (%)
                  </button>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Amount {voucherType === 'fixed' ? '(CZK)' : '(%)'}
                  </label>
                  <input
                    type="number"
                    min="1"
                    max={voucherType === 'percentage' ? 100 : undefined}
                    value={voucherAmount}
                    onChange={(e) => setVoucherAmount(e.target.value)}
                    placeholder={voucherType === 'fixed' ? '1000' : '10'}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                  />
                </div>
              </div>
            </>
          )}

          {/* Step 3b: manual code entry */}
          {step === 'voucher-config' && voucherMode === 'manual' && (
            <>
              <p className="text-xs font-medium text-gray-600">Voucher code</p>
              <input
                type="text"
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleValidateManualCode(); }}
                placeholder="e.g. Tamara-1000-A3F9"
                autoFocus
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-300"
              />
              <p className="text-[11px] text-gray-400">
                We&apos;ll check the code is active and not expired before including it.
              </p>
            </>
          )}

          {/* Step 4: preview + manual edit */}
          {step === 'preview' && resolvedVoucher && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Left: editable fields */}
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Subject</label>
                  <input
                    type="text"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Message body
                    <span className="text-gray-400 font-normal"> (separate paragraphs with a blank line)</span>
                  </label>
                  <textarea
                    value={bodyText}
                    onChange={(e) => setBodyText(e.target.value)}
                    rows={10}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-y"
                  />
                </div>
                <div className="p-3 rounded-lg bg-gray-50 border border-gray-200 text-[11px] text-gray-600 space-y-1">
                  <p><strong>Voucher attached:</strong></p>
                  <p>
                    Code <code className="font-mono bg-white px-1 py-0.5 rounded border border-gray-200">{resolvedVoucher.code}</code>
                    {' · '}
                    Value <strong>
                      {resolvedVoucher.discountType === 'percentage'
                        ? `${resolvedVoucher.amount}%`
                        : `${resolvedVoucher.amount.toLocaleString('cs-CZ')} Kč`}
                    </strong>
                  </p>
                </div>
              </div>

              {/* Right: live HTML preview */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Live preview</label>
                <div className="rounded-lg border border-gray-200 overflow-hidden bg-gray-50" style={{ height: '500px' }}>
                  <iframe
                    ref={iframeRef}
                    title="Email preview"
                    sandbox="allow-same-origin"
                    className="w-full h-full bg-white"
                  />
                </div>
              </div>
            </div>
          )}

          {voucherError && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {voucherError}
            </p>
          )}
          {sendError && step === 'preview' && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {sendError}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-100 flex justify-between gap-2">
          <div>
            {step !== 'template' && (
              <button
                onClick={handleBack}
                className="px-3 py-2 text-sm text-gray-600 hover:text-gray-900"
              >
                ← Back
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-700 border border-gray-200 rounded-md hover:bg-gray-50"
            >
              Cancel
            </button>
            {step === 'template' && (
              <button
                onClick={handleContinueFromTemplate}
                disabled={!selectedTemplateId}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Continue
              </button>
            )}
            {step === 'voucher-config' && voucherMode === 'generate' && (
              <button
                onClick={handleGenerateVoucher}
                disabled={voucherLoading || !voucherAmount}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {voucherLoading ? 'Preparing…' : 'Continue'}
              </button>
            )}
            {step === 'voucher-config' && voucherMode === 'manual' && (
              <button
                onClick={handleValidateManualCode}
                disabled={voucherLoading || !manualCode.trim()}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {voucherLoading ? 'Validating…' : 'Use this code'}
              </button>
            )}
            {step === 'preview' && (
              <button
                onClick={handleSend}
                disabled={sending}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {sending ? 'Sending…' : 'Send email'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

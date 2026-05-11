'use client';
import { useState } from 'react';
import type { Reservation } from '@/types/reservation';
import { generateCode, generateSuffix } from '@/utils/voucherCode';

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

  async function handleGenerateVoucher() {
    const num = parseFloat(voucherAmount);
    if (!num || num <= 0) {
      setVoucherError('Enter a valid amount');
      return;
    }
    if (voucherType === 'percentage' && num > 100) {
      setVoucherError('Percentage cannot exceed 100');
      return;
    }

    setVoucherLoading(true);
    setVoucherError(null);
    try {
      // Up to 3 retries with fresh suffixes on 409 (collision) — same pattern as CreateVoucherModal.
      let suffix = generateSuffix();
      let code = generateCode(reservation.firstName, num, suffix);
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch('/api/vouchers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code,
            discountType: voucherType,
            value: num,
            reservationNumber: reservation.reservationNumber,
            guestName: `${reservation.firstName} ${reservation.lastName}`.trim(),
            guestEmail: defaultEmail || undefined,
            guestPhone: reservation.phone || undefined,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          setResolvedVoucher({
            code: data.code,
            amount: num,
            discountType: voucherType,
          });
          setStep('preview');
          return;
        }
        if (res.status === 409 && attempt < 2) {
          suffix = generateSuffix();
          code = generateCode(reservation.firstName, num, suffix);
          continue;
        }
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Failed to create voucher');
      }
    } catch (e) {
      setVoucherError((e as Error).message);
    } finally {
      setVoucherLoading(false);
    }
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
      });
      setStep('preview');
    } catch (e) {
      setVoucherError((e as Error).message);
    } finally {
      setVoucherLoading(false);
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
        className="bg-white rounded-2xl shadow-xl w-full max-w-md"
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
        <div className="px-6 py-5 space-y-3">

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

          {/* Step 4: preview placeholder */}
          {step === 'preview' && resolvedVoucher && (
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-[12px] text-amber-800 space-y-2">
              <p className="font-medium">Voucher attached ✓</p>
              <p>
                Code: <code className="font-mono bg-white px-1.5 py-0.5 rounded border border-amber-200">{resolvedVoucher.code}</code>
                <br />
                Value: <strong>{resolvedVoucher.amount}{resolvedVoucher.discountType === 'percentage' ? '%' : ' Kč'}</strong>
              </p>
              <p className="text-[11px] text-amber-700">
                Preview + manual edits + send come in the next phase.
              </p>
            </div>
          )}

          {voucherError && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {voucherError}
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
                {voucherLoading ? 'Creating…' : 'Create voucher'}
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
                disabled
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-md opacity-40 cursor-not-allowed"
                title="Preview + send wired up in the next phase"
              >
                Preview & Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

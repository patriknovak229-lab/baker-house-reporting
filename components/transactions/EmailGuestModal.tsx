'use client';
import { useState, useEffect, useMemo, useRef } from 'react';
import type { Reservation } from '@/types/reservation';
import { generateCode, generateSuffix } from '@/utils/voucherCode';
import {
  renderThankYouEmail,
  THANK_YOU_SUBJECT,
  DEFAULT_THANK_YOU_BODY,
} from '@/utils/emailTemplates/thankYou';
import {
  renderWhatsAppMessage,
  buildWhatsAppDeeplink,
  DEFAULT_WHATSAPP_BODY,
} from '@/utils/whatsAppMessage';

type Channel = 'email' | 'whatsapp';

interface Props {
  reservation: Reservation;
  /** Which delivery channel this modal is dispatching for. Defaults to 'email'
   *  for backward compat with the existing Email Guest pill. */
  channel?: Channel;
  /** Defaults to additionalEmail → invoiceData.billingEmail → email — caller
   *  passes the resolved best email so this component doesn't duplicate logic.
   *  Required when channel === 'email'. */
  defaultEmail?: string;
  /** Recipient phone for the WhatsApp deeplink. Required when channel ===
   *  'whatsapp'. Any format the operator typed — normalisation happens in
   *  buildWhatsAppDeeplink. */
  phone?: string;
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
  channel = 'email',
  defaultEmail,
  phone,
  onClose,
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

  // Preview / edit state. `bodyText` is shared across channels — same
  // paragraphs feed the HTML email template and the WhatsApp text template.
  // `whatsAppText` only exists when the operator opts to tweak the final
  // WhatsApp output directly (overrides the template-rendered version).
  const [subject, setSubject] = useState('');
  const defaultBody = (channel === 'whatsapp' ? DEFAULT_WHATSAPP_BODY : DEFAULT_THANK_YOU_BODY).join('\n\n');
  const [bodyText, setBodyText] = useState(defaultBody);
  const [whatsAppTextOverride, setWhatsAppTextOverride] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Send state
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [copiedHint, setCopiedHint] = useState(false);

  // Pre-fill subject when we land on preview step (email only — WhatsApp
  // has no subject line)
  useEffect(() => {
    if (channel !== 'email') return;
    if (step === 'preview' && !subject) {
      setSubject(THANK_YOU_SUBJECT(reservation.firstName));
    }
  }, [step, subject, reservation.firstName, channel]);

  /** Shared formatter for the voucher amount label — keeps email + WhatsApp
   *  in sync (CZK with cs-CZ separators for fixed, plain "%" for percentage). */
  function formatAmount(v: ResolvedVoucher): string {
    return v.discountType === 'percentage'
      ? `${v.amount}%`
      : `${v.amount.toLocaleString('cs-CZ')} Kč`;
  }

  // Live HTML render — re-computed on any edit. Cheap, no debounce needed.
  // Email-only; WhatsApp doesn't use this.
  const renderedHtml = useMemo(() => {
    if (channel !== 'email' || !resolvedVoucher) return '';
    const paragraphs = bodyText.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    return renderThankYouEmail({
      firstName: reservation.firstName,
      voucherCode: resolvedVoucher.code,
      voucherAmount: formatAmount(resolvedVoucher),
      bodyParagraphs: paragraphs,
    });
  }, [channel, resolvedVoucher, bodyText, reservation.firstName]);

  // Live WhatsApp text render — reflects the same `bodyText` paragraphs as
  // the email path. The operator can also override this output directly via
  // the textarea (whatsAppTextOverride wins when set). WhatsApp-only.
  const renderedWhatsApp = useMemo(() => {
    if (channel !== 'whatsapp' || !resolvedVoucher) return '';
    if (whatsAppTextOverride !== null) return whatsAppTextOverride;
    const paragraphs = bodyText.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    return renderWhatsAppMessage({
      firstName: reservation.firstName,
      voucherCode: resolvedVoucher.code,
      voucherAmount: formatAmount(resolvedVoucher),
      bodyParagraphs: paragraphs,
    });
  }, [channel, resolvedVoucher, bodyText, reservation.firstName, whatsAppTextOverride]);

  // Push the rendered HTML into the iframe whenever it changes (email only)
  useEffect(() => {
    if (step !== 'preview' || channel !== 'email') return;
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    doc.open();
    doc.write(renderedHtml);
    doc.close();
  }, [step, renderedHtml, channel]);

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

  /** Persists the staged voucher to the DB if it hasn't been saved yet.
   *  Returns the final (server-confirmed) code. Throws on failure.
   *
   *  Called by both the email-send and the WhatsApp-send paths so the
   *  voucher only ever hits the DB when the operator commits to dispatch
   *  — cancelling either flow leaves no orphan record. */
  async function ensureVoucherPersisted(): Promise<string> {
    if (!resolvedVoucher) throw new Error('No voucher staged');
    if (resolvedVoucher.persisted) return resolvedVoucher.code;

    let attemptedCode = resolvedVoucher.code;
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
        setResolvedVoucher({ ...resolvedVoucher, code: data.code, persisted: true });
        return data.code as string;
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
    throw new Error('Could not save voucher — please try again');
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
      // ── Step 1: persist the voucher (if not already)
      const finalCode = await ensureVoucherPersisted();

      // ── Step 2: render the email HTML using the final (server-confirmed) code.
      //    Computing it fresh here avoids any stale-closure issue from the
      //    useMemo'd renderedHtml when the code changed on a 409 retry.
      const paragraphs = bodyText.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      const html = renderThankYouEmail({
        firstName: reservation.firstName,
        voucherCode: finalCode,
        voucherAmount: formatAmount(resolvedVoucher),
        bodyParagraphs: paragraphs,
      });

      // ── Step 3: send the email
      const selectedTemplate = TEMPLATES.find((t) => t.id === selectedTemplateId);
      const res = await fetch('/api/send-guest-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: defaultEmail,
          subject: subject.trim(),
          html,
          reservationNumber: reservation.reservationNumber,
          templateId: selectedTemplate?.id,
          templateLabel: selectedTemplate?.label,
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

  /** WhatsApp "Open in WhatsApp" path. Persists voucher, opens wa.me deeplink
   *  in a new tab with the current message pre-filled, then writes an audit
   *  log entry. The operator still has to tap Send inside WhatsApp itself —
   *  this is the limit of public WhatsApp without Cloud-API integration. */
  async function handleSendWhatsApp() {
    if (!resolvedVoucher) return;
    if (!phone) {
      setSendError('No phone number on file for this reservation');
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      // 1. persist voucher (gets the final server-confirmed code on 409 retry)
      const finalCode = await ensureVoucherPersisted();

      // 2. rebuild the WhatsApp text with the final code. Same paragraphs
      //    the operator saw in the preview; we only swap the code in case it
      //    changed due to a collision retry. If the operator edited the
      //    final text manually (override) we ALSO patch the staged code
      //    inside that override so the recipient sees the persisted code.
      const paragraphs = bodyText.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      const freshText = renderWhatsAppMessage({
        firstName: reservation.firstName,
        voucherCode: finalCode,
        voucherAmount: formatAmount(resolvedVoucher),
        bodyParagraphs: paragraphs,
      });
      const textToSend = whatsAppTextOverride
        ? whatsAppTextOverride.replace(
            new RegExp(escapeRegex(resolvedVoucher.code), 'g'),
            finalCode,
          )
        : freshText;

      // 3. open wa.me. window.open MUST happen synchronously after user
      //    gesture, but since we awaited above some browsers may block the
      //    popup. Use an <a>-style fallback if window.open is null.
      const url = buildWhatsAppDeeplink(phone, textToSend);
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (!opened) {
        // Fallback — surface the link in the error pane so the operator can click
        setSendError(`Couldn't open WhatsApp tab (popup blocked). Open this manually: ${url}`);
        return;
      }

      // 4. log the dispatch. Best-effort — a failed log doesn't roll back
      //    the user-visible action (WhatsApp tab is already open).
      const selectedTemplate = TEMPLATES.find((t) => t.id === selectedTemplateId);
      const normalisedPhone = phone.replace(/[^\d+]/g, '').replace(/^\+/, '');
      try {
        await fetch('/api/log-guest-message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel: 'whatsapp',
            to: normalisedPhone,
            reservationNumber: reservation.reservationNumber,
            templateId: selectedTemplate?.id,
            templateLabel: selectedTemplate?.label,
          }),
        });
      } catch (logErr) {
        console.warn('[EmailGuestModal] log-guest-message failed:', logErr);
      }
      onSent?.();
    } catch (e) {
      setSendError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  /** Copy the rendered WhatsApp text to clipboard. Does NOT persist the
   *  voucher or log — the operator might just be inspecting the text or
   *  pasting it somewhere else. Vouchers persist on the actual "Open in
   *  WhatsApp" action. */
  async function handleCopyWhatsApp() {
    if (!renderedWhatsApp) return;
    try {
      await navigator.clipboard.writeText(renderedWhatsApp);
      setCopiedHint(true);
      window.setTimeout(() => setCopiedHint(false), 2500);
    } catch {
      setSendError('Clipboard access denied. Select the text and copy manually.');
    }
  }

  function handleBack() {
    setVoucherError(null);
    setSendError(null);
    if (step === 'voucher-choice') {
      setStep('template');
    } else if (step === 'voucher-config') {
      setStep('voucher-choice');
    } else if (step === 'preview') {
      setStep('voucher-config');
    }
  }

  /** Escape user-supplied text for safe inclusion in a RegExp source. */
  function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Channel-aware copy for the recipient line in the modal header
  const recipientDisplay =
    channel === 'whatsapp'
      ? `WhatsApp ${phone || '(no phone on file)'}`
      : (defaultEmail || '(no email on file)');
  const senderHint =
    channel === 'whatsapp'
      ? ' · opens in your WhatsApp account'
      : ' · from reservations@bakerhouseapartments.cz';

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className={`bg-white rounded-2xl shadow-xl w-full ${
          step === 'preview'
            ? channel === 'whatsapp' ? 'max-w-xl' : 'max-w-4xl'
            : 'max-w-md'
        } max-h-[90vh] overflow-hidden flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              {channel === 'whatsapp' ? 'WhatsApp Guest' : 'Email Guest'}
              {step !== 'template' ? ' · Thank You' : ''}
            </h2>
            <p className="text-[11px] text-gray-500 mt-0.5">
              To: <span className="font-mono">{recipientDisplay}</span>
              <span className="text-gray-400">{senderHint}</span>
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

          {/* Step 4a: EMAIL preview + manual edit */}
          {step === 'preview' && resolvedVoucher && channel === 'email' && (
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
                    Value <strong>{formatAmount(resolvedVoucher)}</strong>
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

          {/* Step 4b: WHATSAPP preview — single editable textarea representing
              the message that will be passed to wa.me (or copied). The
              operator can tweak it freely; on Open we patch the staged
              voucher code in case it changed on a 409 retry. */}
          {step === 'preview' && resolvedVoucher && channel === 'whatsapp' && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  WhatsApp message
                  <span className="text-gray-400 font-normal"> (edit freely — exactly what will be sent)</span>
                </label>
                <textarea
                  value={renderedWhatsApp}
                  onChange={(e) => setWhatsAppTextOverride(e.target.value)}
                  rows={16}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm font-mono leading-snug focus:outline-none focus:ring-2 focus:ring-green-300 resize-y"
                />
                {whatsAppTextOverride !== null && (
                  <button
                    type="button"
                    onClick={() => setWhatsAppTextOverride(null)}
                    className="mt-1 text-[11px] text-indigo-600 hover:text-indigo-800"
                  >
                    Reset to template
                  </button>
                )}
              </div>

              <div className="p-3 rounded-lg bg-gray-50 border border-gray-200 text-[11px] text-gray-600 space-y-1">
                <p>
                  <strong>Voucher attached:</strong>{' '}
                  Code <code className="font-mono bg-white px-1 py-0.5 rounded border border-gray-200">{resolvedVoucher.code}</code>
                  {' · '}
                  Value <strong>{formatAmount(resolvedVoucher)}</strong>
                </p>
                <p className="text-[10.5px] text-gray-500">
                  &ldquo;Open in WhatsApp&rdquo; launches your WhatsApp Web/app with this text pre-filled.
                  You still confirm send inside WhatsApp itself.
                </p>
              </div>

              {copiedHint && (
                <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                  Text copied — paste it into WhatsApp or any other channel.
                </p>
              )}
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
            {step === 'preview' && channel === 'email' && (
              <button
                onClick={handleSend}
                disabled={sending}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {sending ? 'Sending…' : 'Send email'}
              </button>
            )}
            {step === 'preview' && channel === 'whatsapp' && (
              <>
                <button
                  onClick={handleCopyWhatsApp}
                  disabled={sending}
                  className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Copy the message text to clipboard"
                >
                  Copy text
                </button>
                <button
                  onClick={handleSendWhatsApp}
                  disabled={sending || !phone}
                  className="px-4 py-2 text-sm bg-green-500 text-white rounded-md hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                  title={phone ? 'Open WhatsApp with this message pre-filled' : 'No phone on file'}
                >
                  <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" xmlns="http://www.w3.org/2000/svg">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                  </svg>
                  {sending ? 'Opening…' : 'Open in WhatsApp'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

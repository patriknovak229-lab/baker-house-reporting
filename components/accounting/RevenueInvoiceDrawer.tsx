'use client';
import { useState, useRef } from 'react';
import type { RevenueInvoice, RevenueInvoiceCategory } from '@/types/revenueInvoice';
import type { BankTransaction } from '@/types/bankTransaction';
import type { ExtractedRevenueData } from '@/app/api/revenue-invoices/extract/route';
import { formatCurrency, formatDate } from '@/utils/formatters';

interface Props {
  /** null = add manual mode */
  invoice: RevenueInvoice | null;
  transactions: BankTransaction[];
  onClose: () => void;
  onUpdate: (inv: RevenueInvoice) => void;
  onBankTxUpdate: (tx: BankTransaction) => void;
}

const CATEGORY_OPTIONS: { value: RevenueInvoiceCategory; label: string; description: string }[] = [
  { value: 'accommodation_direct', label: 'Accommodation',    description: 'Direct guest payment (QR invoice)' },
  { value: 'other_services',       label: 'Other services',   description: 'External invoices, additional services' },
  { value: 'mistake',              label: 'Mistake',          description: 'Issued in error, cancelled' },
];

const CATEGORY_BADGE: Record<RevenueInvoiceCategory, { label: string; className: string }> = {
  accommodation_direct: { label: 'Accommodation',  className: 'bg-teal-100 text-teal-700'    },
  other_services:       { label: 'Other services', className: 'bg-purple-100 text-purple-700' },
  mistake:              { label: 'Mistake',         className: 'bg-rose-100 text-rose-600'    },
};

type UploadStep = 'upload' | 'extracting' | 'review';

interface ReviewForm {
  clientName:    string;
  invoiceNumber: string;
  invoiceDate:   string;
  dueDate:       string;
  amountCZK:     string;
  currency:      string;
  description:   string;
  category:      RevenueInvoiceCategory;
}

export default function RevenueInvoiceDrawer({ invoice, transactions, onClose, onUpdate, onBankTxUpdate }: Props) {
  const today = new Date().toISOString().slice(0, 10);

  // ── Add-manual state ──────────────────────────────────────────────────────
  const [uploadStep, setUploadStep] = useState<UploadStep>('upload');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [extractError, setExtractError] = useState('');
  const [reviewForm, setReviewForm] = useState<ReviewForm>({
    clientName:    '',
    invoiceNumber: '',
    invoiceDate:   today,
    dueDate:       today,
    amountCZK:     '',
    currency:      'CZK',
    description:   '',
    category:      'other_services',
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── View-mode state ───────────────────────────────────────────────────────
  const [txSearch, setTxSearch] = useState('');
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  const isAddMode = invoice === null;

  // Candidate bank transactions: credits with state 'revenue' and no revenueInvoiceId (or already linked to this invoice)
  const creditCandidates = transactions.filter(
    (t) => t.direction === 'credit' && t.state === 'revenue' &&
           (!t.revenueInvoiceId || t.revenueInvoiceId === invoice?.id),
  );

  const filteredCandidates = txSearch.trim()
    ? creditCandidates.filter((t) =>
        (t.counterpartyName ?? '').toLowerCase().includes(txSearch.toLowerCase()) ||
        formatDate(t.date).includes(txSearch) ||
        formatCurrency(t.amount).includes(txSearch),
      )
    : creditCandidates;

  function handleReviewChange(field: keyof ReviewForm, value: string) {
    setReviewForm((f) => ({ ...f, [field]: value }));
    setSaveError('');
  }

  function handleFileSelect(file: File) {
    setUploadFile(file);
    setExtractError('');
  }

  async function handleExtract() {
    if (!uploadFile) return;
    setExtractError('');
    setUploadStep('extracting');
    try {
      const fd = new FormData();
      fd.append('file', uploadFile);
      const res = await fetch('/api/revenue-invoices/extract', { method: 'POST', body: fd });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        setExtractError(j.error ?? `Failed to extract data (HTTP ${res.status})`);
        setUploadStep('upload');
        return;
      }
      const data = await res.json() as ExtractedRevenueData;
      const fallbackDate = data.invoiceDate ?? today;
      setReviewForm({
        clientName:    data.clientName    ?? '',
        invoiceNumber: data.invoiceNumber ?? '',
        invoiceDate:   data.invoiceDate   ?? today,
        dueDate:       data.dueDate       ?? fallbackDate,
        amountCZK:     data.amountCZK != null ? String(data.amountCZK) : '',
        currency:      data.currency      ?? 'CZK',
        description:   data.description   ?? '',
        category:      'other_services',
      });
      setUploadStep('review');
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : 'Network error — please try again');
      setUploadStep('upload');
    }
  }

  async function handleSaveManual() {
    if (!reviewForm.clientName.trim())    { setSaveError('Client name is required'); return; }
    if (!reviewForm.invoiceNumber.trim()) { setSaveError('Invoice number is required'); return; }
    const amount = parseFloat(reviewForm.amountCZK);
    if (!amount || amount <= 0)           { setSaveError('Amount must be a positive number'); return; }

    setSaving(true);
    setSaveError('');
    try {
      const id = crypto.randomUUID();
      const body = {
        id,
        sourceType: 'manual' as const,
        category:      reviewForm.category,
        invoiceNumber: reviewForm.invoiceNumber.trim(),
        invoiceDate:   reviewForm.invoiceDate,
        dueDate:       reviewForm.dueDate || reviewForm.invoiceDate,
        amountCZK:     amount,
        clientName:    reviewForm.clientName.trim(),
        description:   reviewForm.description.trim() || undefined,
      };

      // 1. Save invoice record
      const saveRes = await fetch('/api/revenue-invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!saveRes.ok) {
        setSaveError('Failed to save invoice — please try again');
        return;
      }
      let saved = await saveRes.json() as RevenueInvoice;

      // 2. Upload file to Drive (non-fatal — invoice is already saved)
      if (uploadFile) {
        try {
          const fd = new FormData();
          fd.append('file', uploadFile);
          fd.append('invoiceId', id);
          fd.append('clientName', body.clientName);
          fd.append('invoiceNumber', body.invoiceNumber);
          fd.append('amountCZK', String(Math.round(amount)));
          fd.append('invoiceDate', body.invoiceDate);
          const driveRes = await fetch('/api/revenue-invoices/drive-upload', { method: 'POST', body: fd });
          if (driveRes.ok) {
            const d = await driveRes.json() as { invoice?: RevenueInvoice };
            if (d.invoice) saved = d.invoice;
          }
        } catch { /* non-fatal */ }
      }

      onUpdate(saved);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function handleCategoryChange(category: RevenueInvoiceCategory) {
    if (!invoice) return;
    const res = await fetch(`/api/revenue-invoices/${invoice.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update_category', category }),
    });
    if (res.ok) {
      const updated = await res.json() as RevenueInvoice;
      onUpdate(updated);
    }
  }

  async function handleLinkBank(txId: string) {
    if (!invoice) return;
    setLinking(true);
    try {
      const res = await fetch(`/api/revenue-invoices/${invoice.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'link_bank', bankTransactionId: txId }),
      });
      if (res.ok) {
        const data = await res.json() as { invoice: RevenueInvoice; transaction: BankTransaction };
        onUpdate(data.invoice);
        onBankTxUpdate(data.transaction);
        onClose();
      }
    } finally {
      setLinking(false);
    }
  }

  async function handleUnlink() {
    if (!invoice) return;
    setUnlinking(true);
    try {
      const res = await fetch(`/api/revenue-invoices/${invoice.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unlink' }),
      });
      if (res.ok) {
        const data = await res.json() as { invoice: RevenueInvoice; transaction?: BankTransaction };
        onUpdate(data.invoice);
        if (data.transaction) {
          onBankTxUpdate(data.transaction);
        } else if (invoice.bankTransactionId) {
          const oldTx = transactions.find((t) => t.id === invoice.bankTransactionId);
          if (oldTx) onBankTxUpdate({ ...oldTx, revenueInvoiceId: undefined });
        }
        onClose();
      }
    } finally {
      setUnlinking(false);
    }
  }

  const linkedTx = invoice?.bankTransactionId
    ? transactions.find((t) => t.id === invoice.bankTransactionId)
    : undefined;

  const inputClass = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400';

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/20" onClick={onClose} />

      {/* Panel */}
      <div className="w-full max-w-md bg-white shadow-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">
            {isAddMode ? 'Add manual invoice' : 'Revenue invoice'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">

          {/* ── Add manual mode ─────────────────────────────────────────── */}
          {isAddMode && (
            <>
              {/* Step: upload */}
              {uploadStep === 'upload' && (
                <div className="space-y-4">
                  <p className="text-xs text-gray-500">
                    Upload the invoice PDF and we'll extract the details automatically.
                  </p>

                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,image/*,.heic,.heif"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleFileSelect(f);
                    }}
                  />

                  {uploadFile ? (
                    <div className="flex items-center justify-between px-4 py-3 bg-indigo-50 border border-indigo-200 rounded-xl">
                      <div className="flex items-center gap-2 min-w-0">
                        <svg className="w-5 h-5 text-indigo-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <span className="text-xs text-indigo-700 font-medium truncate">{uploadFile.name}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => { setUploadFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                        className="text-xs text-gray-400 hover:text-gray-600 ml-2 shrink-0"
                      >
                        Remove
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full flex flex-col items-center justify-center gap-2 px-4 py-8 border-2 border-dashed border-gray-300 rounded-xl text-sm text-gray-500 hover:border-indigo-300 hover:text-indigo-600 hover:bg-indigo-50/30 transition-colors"
                    >
                      <svg className="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      <span className="font-medium">Click to upload invoice PDF</span>
                      <span className="text-xs text-gray-400">PDF or image</span>
                    </button>
                  )}

                  {extractError && (
                    <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                      {extractError}
                    </p>
                  )}
                </div>
              )}

              {/* Step: extracting */}
              {uploadStep === 'extracting' && (
                <div className="flex flex-col items-center justify-center py-16 gap-4">
                  <svg className="w-10 h-10 text-indigo-500 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <p className="text-sm text-gray-600 font-medium">Extracting invoice data…</p>
                  <p className="text-xs text-gray-400">This takes a few seconds</p>
                </div>
              )}

              {/* Step: review */}
              {uploadStep === 'review' && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 mb-1">
                    <svg className="w-4 h-4 text-green-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    <p className="text-xs text-green-700 font-medium">Data extracted — review and confirm</p>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Client name *</label>
                    <input
                      type="text"
                      value={reviewForm.clientName}
                      onChange={(e) => handleReviewChange('clientName', e.target.value)}
                      placeholder="Client or company name"
                      className={inputClass}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Invoice number *</label>
                      <input
                        type="text"
                        value={reviewForm.invoiceNumber}
                        onChange={(e) => handleReviewChange('invoiceNumber', e.target.value)}
                        placeholder="INV-2026-001"
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Amount (CZK) *</label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={reviewForm.amountCZK}
                        onChange={(e) => handleReviewChange('amountCZK', e.target.value)}
                        placeholder="0"
                        className={inputClass}
                      />
                    </div>
                  </div>

                  {reviewForm.currency && reviewForm.currency !== 'CZK' && (
                    <p className="text-xs text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                      Invoice currency detected: <strong>{reviewForm.currency}</strong>. Please enter the CZK equivalent in the Amount field.
                    </p>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Invoice date</label>
                      <input
                        type="date"
                        value={reviewForm.invoiceDate}
                        onChange={(e) => handleReviewChange('invoiceDate', e.target.value)}
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Due date</label>
                      <input
                        type="date"
                        value={reviewForm.dueDate}
                        onChange={(e) => handleReviewChange('dueDate', e.target.value)}
                        className={inputClass}
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
                    <select
                      value={reviewForm.category}
                      onChange={(e) => handleReviewChange('category', e.target.value)}
                      className={`${inputClass} bg-white`}
                    >
                      {CATEGORY_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Description (optional)</label>
                    <input
                      type="text"
                      value={reviewForm.description}
                      onChange={(e) => handleReviewChange('description', e.target.value)}
                      placeholder="Short note"
                      className={inputClass}
                    />
                  </div>

                  {uploadFile && (
                    <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg">
                      <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      <span className="text-xs text-gray-500 truncate flex-1">{uploadFile.name}</span>
                      <span className="text-xs text-indigo-600 shrink-0">→ Drive</span>
                    </div>
                  )}

                  {saveError && (
                    <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                      {saveError}
                    </p>
                  )}
                </div>
              )}
            </>
          )}

          {/* ── View / edit mode ────────────────────────────────────────── */}
          {!isAddMode && invoice && (
            <>
              {/* Invoice details */}
              <div className="bg-gray-50 rounded-xl p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-base font-semibold text-gray-900">
                      {invoice.guestName ?? invoice.clientName ?? '—'}
                    </p>
                    {invoice.reservationNumber && (
                      <p className="text-xs text-gray-400">Reservation #{invoice.reservationNumber}</p>
                    )}
                  </div>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${CATEGORY_BADGE[invoice.category].className}`}>
                    {CATEGORY_BADGE[invoice.category].label}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <p className="text-xs text-gray-400">Invoice #</p>
                    <p className="font-mono text-gray-700">{invoice.invoiceNumber}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Invoice date</p>
                    <p className="text-gray-700">{formatDate(invoice.invoiceDate)}</p>
                  </div>
                  {invoice.dueDate && invoice.dueDate !== invoice.invoiceDate && (
                    <div>
                      <p className="text-xs text-gray-400">Due date</p>
                      <p className="text-gray-700">{formatDate(invoice.dueDate)}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-xs text-gray-400">Amount</p>
                    <p className="font-semibold text-gray-900">{formatCurrency(invoice.amountCZK)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Source</p>
                    <p className="text-gray-600 capitalize">{invoice.sourceType}</p>
                  </div>
                  {invoice.description && (
                    <div className="col-span-2">
                      <p className="text-xs text-gray-400">Description</p>
                      <p className="text-gray-600 text-xs">{invoice.description}</p>
                    </div>
                  )}
                  {invoice.driveUrl && (
                    <div className="col-span-2">
                      <p className="text-xs text-gray-400">Document</p>
                      <a
                        href={invoice.driveUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-indigo-600 hover:underline truncate block"
                        onClick={(e) => e.stopPropagation()}
                      >
                        📄 {invoice.driveFileName ?? 'View in Drive'}
                      </a>
                    </div>
                  )}
                </div>
              </div>

              {/* Category selector */}
              <div>
                <p className="text-xs font-medium text-gray-600 mb-2">Category</p>
                <div className="space-y-2">
                  {CATEGORY_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => handleCategoryChange(opt.value)}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-lg border text-left text-sm transition-colors ${
                        invoice.category === opt.value
                          ? 'border-indigo-400 bg-indigo-50 text-indigo-700'
                          : 'border-gray-200 hover:border-gray-300 text-gray-700'
                      }`}
                    >
                      <span className="font-medium">{opt.label}</span>
                      <span className="text-xs text-gray-400">{opt.description}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Linked bank transaction */}
              <div>
                <p className="text-xs font-medium text-gray-600 mb-2">Linked bank transaction</p>

                {linkedTx ? (
                  <div className="bg-green-50 border border-green-200 rounded-xl p-3 space-y-2">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-sm font-medium text-green-800">
                          {linkedTx.counterpartyName ?? '—'}
                        </p>
                        <p className="text-xs text-green-600">
                          {formatDate(linkedTx.date)} · +{formatCurrency(linkedTx.amount)}
                        </p>
                      </div>
                      <button
                        onClick={handleUnlink}
                        disabled={unlinking}
                        className="text-xs text-red-500 hover:text-red-700 underline flex-shrink-0"
                      >
                        {unlinking ? 'Unlinking…' : 'Unlink'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <input
                      type="text"
                      placeholder="Search credit transactions…"
                      value={txSearch}
                      onChange={(e) => setTxSearch(e.target.value)}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />

                    {filteredCandidates.length === 0 ? (
                      <p className="text-xs text-gray-400 text-center py-4">
                        No unlinked revenue transactions found
                      </p>
                    ) : (
                      <div className="space-y-1.5 max-h-48 overflow-y-auto">
                        {filteredCandidates.map((tx) => (
                          <button
                            key={tx.id}
                            onClick={() => handleLinkBank(tx.id)}
                            disabled={linking}
                            className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-gray-200 hover:border-indigo-300 hover:bg-indigo-50 transition-colors text-left text-sm"
                          >
                            <div>
                              <p className="text-gray-800 font-medium">{tx.counterpartyName ?? '—'}</p>
                              <p className="text-xs text-gray-400">{formatDate(tx.date)}</p>
                            </div>
                            <p className="text-green-600 font-medium">+{formatCurrency(tx.amount)}</p>
                          </button>
                        ))}
                      </div>
                    )}
                    <p className="text-xs text-gray-400 mt-2">
                      Only unlinked revenue credit transactions are shown.
                    </p>
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        {isAddMode && (
          <div className="px-6 py-4 border-t border-gray-100 flex gap-3">
            {uploadStep === 'upload' && (
              <>
                <button
                  onClick={onClose}
                  className="flex-1 px-4 py-2 text-sm border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleExtract}
                  disabled={!uploadFile}
                  className="flex-1 px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Extract data
                </button>
              </>
            )}

            {uploadStep === 'extracting' && (
              <button disabled className="flex-1 px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg opacity-60 cursor-not-allowed">
                Extracting…
              </button>
            )}

            {uploadStep === 'review' && (
              <>
                <button
                  onClick={() => setUploadStep('upload')}
                  disabled={saving}
                  className="px-4 py-2 text-sm border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                >
                  ← Back
                </button>
                <button
                  onClick={handleSaveManual}
                  disabled={saving}
                  className="flex-1 px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                >
                  {saving ? 'Saving…' : uploadFile ? 'Save & push to Drive' : 'Save invoice'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

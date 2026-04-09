'use client';
import { useState, useEffect } from 'react';
import type { RevenueInvoice, RevenueInvoiceCategory } from '@/types/revenueInvoice';
import type { BankTransaction } from '@/types/bankTransaction';
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

export default function RevenueInvoiceDrawer({ invoice, transactions, onClose, onUpdate, onBankTxUpdate }: Props) {
  // ── Add-manual form state ─────────────────────────────────────────────────
  const [form, setForm] = useState({
    clientName:    '',
    invoiceNumber: '',
    invoiceDate:   new Date().toISOString().slice(0, 10),
    amountCZK:     '',
    description:   '',
    category:      'other_services' as RevenueInvoiceCategory,
  });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  // ── View-mode state ───────────────────────────────────────────────────────
  const [txSearch, setTxSearch] = useState('');
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

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

  const isAddMode = invoice === null;

  function handleFormChange(field: string, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
    setFormError('');
  }

  async function handleAddManual() {
    if (!form.clientName.trim()) { setFormError('Client name is required'); return; }
    if (!form.invoiceNumber.trim()) { setFormError('Invoice number is required'); return; }
    if (!form.invoiceDate) { setFormError('Invoice date is required'); return; }
    const amount = parseFloat(form.amountCZK);
    if (!amount || amount <= 0) { setFormError('Amount must be a positive number'); return; }

    setSaving(true);
    try {
      const body = {
        id: crypto.randomUUID(),
        sourceType: 'manual' as const,
        category: form.category,
        invoiceNumber: form.invoiceNumber.trim(),
        invoiceDate: form.invoiceDate,
        amountCZK: amount,
        clientName: form.clientName.trim(),
        description: form.description.trim() || undefined,
      };
      const res = await fetch('/api/revenue-invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setFormError('Failed to save — please try again');
        return;
      }
      const saved = await res.json() as RevenueInvoice;
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
          // Manually clear revenueInvoiceId from the old tx in parent state
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

  const CATEGORY_BADGE: Record<RevenueInvoiceCategory, { label: string; className: string }> = {
    accommodation_direct: { label: 'Accommodation',  className: 'bg-teal-100 text-teal-700'    },
    other_services:       { label: 'Other services', className: 'bg-purple-100 text-purple-700' },
    mistake:              { label: 'Mistake',         className: 'bg-rose-100 text-rose-600'    },
  };

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
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Client name *</label>
                  <input
                    type="text"
                    value={form.clientName}
                    onChange={(e) => handleFormChange('clientName', e.target.value)}
                    placeholder="Client or company name"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Invoice number *</label>
                    <input
                      type="text"
                      value={form.invoiceNumber}
                      onChange={(e) => handleFormChange('invoiceNumber', e.target.value)}
                      placeholder="INV-2026-001"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Date *</label>
                    <input
                      type="date"
                      value={form.invoiceDate}
                      onChange={(e) => handleFormChange('invoiceDate', e.target.value)}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Amount (CZK) *</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.amountCZK}
                    onChange={(e) => handleFormChange('amountCZK', e.target.value)}
                    placeholder="0"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
                  <select
                    value={form.category}
                    onChange={(e) => handleFormChange('category', e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
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
                    value={form.description}
                    onChange={(e) => handleFormChange('description', e.target.value)}
                    placeholder="Short note"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
                  />
                </div>
              </div>

              {formError && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                  {formError}
                </p>
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
                    <p className="text-xs text-gray-400">Date</p>
                    <p className="text-gray-700">{formatDate(invoice.invoiceDate)}</p>
                  </div>
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
                    {/* Search candidates */}
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
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 text-sm border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleAddManual}
              disabled={saving}
              className="flex-1 px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save invoice'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

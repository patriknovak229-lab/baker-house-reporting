'use client';
import { useState, useMemo } from 'react';
import type { BankTransaction, IgnoreCategoryId } from '@/types/bankTransaction';
import { IGNORE_CATEGORIES } from '@/types/bankTransaction';
import type { SupplierInvoice } from '@/types/supplierInvoice';
import { formatCurrency, formatDate } from '@/utils/formatters';

interface Props {
  transaction: BankTransaction;
  invoices: SupplierInvoice[];
  onSave: (tx: BankTransaction) => void;
  onClose: () => void;
}

/** Find the best-match invoice suggestion (same logic as server auto-reconcile) */
function findSuggestion(tx: BankTransaction, invoices: SupplierInvoice[]): SupplierInvoice | null {
  const pending = invoices.filter(
    (inv) => inv.status === 'pending' && !inv.bankTransactionId,
  );
  const norm = (s: string) => s.toLowerCase().trim();
  const matches = pending.filter((inv) => {
    if (Math.abs(tx.amount - inv.amountCZK) >= 1) return false;
    const nameMatch = tx.counterpartyName &&
      norm(tx.counterpartyName).includes(norm(inv.supplierName));
    const vsMatch = tx.variableSymbol &&
      norm(tx.variableSymbol) === norm(inv.invoiceNumber);
    return !!(nameMatch || vsMatch);
  });
  return matches.length === 1 ? matches[0] : null;
}

export default function ReconcileDrawer({ transaction: tx, invoices, onSave, onClose }: Props) {
  const suggestion = useMemo(() => findSuggestion(tx, invoices), [tx, invoices]);

  const [mode, setMode] = useState<'match' | 'ignore'>('match');
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string>(
    tx.invoiceId ?? suggestion?.id ?? '',
  );
  const [search, setSearch] = useState('');
  const [ignoreCategory, setIgnoreCategory] = useState<IgnoreCategoryId>(
    (tx.ignoreCategory as IgnoreCategoryId) ?? 'other',
  );
  const [ignoreNote, setIgnoreNote] = useState(tx.ignoreNote ?? '');
  const [saving, setSaving] = useState(false);

  // Unreconciled invoices only (plus the currently linked one)
  const candidateInvoices = useMemo(() => {
    return invoices
      .filter((inv) =>
        inv.status === 'pending' ||
        inv.id === tx.invoiceId,
      )
      .filter((inv) => {
        if (!search) return true;
        const q = search.toLowerCase();
        return (
          inv.supplierName.toLowerCase().includes(q) ||
          inv.invoiceNumber.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate));
  }, [invoices, tx.invoiceId, search]);

  async function handleSave() {
    setSaving(true);
    try {
      let body: object;
      if (mode === 'match') {
        if (!selectedInvoiceId) return;
        body = { action: 'reconcile', invoiceId: selectedInvoiceId };
      } else {
        body = { action: 'ignore', ignoreCategory, ignoreNote: ignoreNote || undefined };
      }

      const res = await fetch(`/api/bank-transactions/${tx.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const updated = await res.json() as BankTransaction;
        onSave(updated);
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleUnmatch() {
    setSaving(true);
    try {
      const res = await fetch(`/api/bank-transactions/${tx.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unmatch' }),
      });
      if (res.ok) {
        const updated = await res.json() as BankTransaction;
        onSave(updated);
      }
    } finally {
      setSaving(false);
    }
  }

  const canSave = mode === 'match' ? !!selectedInvoiceId : !!ignoreCategory;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white shadow-xl flex flex-col h-full overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0">
          <h2 className="text-base font-semibold text-gray-800">Reconcile Payment</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        {/* Transaction summary */}
        <div className="px-5 py-4 bg-gray-50 border-b border-gray-100 flex-shrink-0">
          <div className="flex items-start justify-between">
            <div>
              <p className="font-medium text-gray-900">{tx.counterpartyName ?? '—'}</p>
              {tx.counterpartyAccount && (
                <p className="text-xs text-gray-400 mt-0.5">{tx.counterpartyAccount}</p>
              )}
              {tx.variableSymbol && (
                <p className="text-xs text-gray-500 mt-0.5">VS: {tx.variableSymbol}</p>
              )}
              {tx.description && (
                <p className="text-xs text-gray-400 mt-1 max-w-xs truncate">{tx.description}</p>
              )}
            </div>
            <div className="text-right flex-shrink-0">
              <p className="text-lg font-semibold text-gray-900">−{formatCurrency(tx.amount)}</p>
              <p className="text-xs text-gray-400">{formatDate(tx.date)}</p>
            </div>
          </div>
        </div>

        {/* Mode tabs */}
        <div className="flex border-b border-gray-100 flex-shrink-0">
          <button
            onClick={() => setMode('match')}
            className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
              mode === 'match' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Match invoice
          </button>
          <button
            onClick={() => setMode('ignore')}
            className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
              mode === 'ignore' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Not an invoice
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {mode === 'match' && (
            <div className="space-y-3">
              {/* Auto-suggestion */}
              {suggestion && !tx.invoiceId && (
                <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-3">
                  <p className="text-xs font-semibold text-indigo-700 mb-2">Suggested match</p>
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="radio"
                      name="invoice"
                      value={suggestion.id}
                      checked={selectedInvoiceId === suggestion.id}
                      onChange={() => setSelectedInvoiceId(suggestion.id)}
                      className="mt-0.5 text-indigo-600"
                    />
                    <div>
                      <p className="text-sm font-medium text-gray-800">{suggestion.supplierName}</p>
                      <p className="text-xs text-gray-500">{suggestion.invoiceNumber} · {formatDate(suggestion.invoiceDate)}</p>
                      <p className="text-sm font-semibold text-gray-800 mt-0.5">{formatCurrency(suggestion.amountCZK)}</p>
                    </div>
                  </label>
                </div>
              )}

              {/* Search */}
              <input
                type="text"
                placeholder="Search supplier or invoice #…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
              />

              {/* Invoice list */}
              <div className="space-y-1.5 max-h-80 overflow-y-auto">
                {candidateInvoices.length === 0 ? (
                  <p className="text-xs text-gray-400 text-center py-4">No pending invoices found.</p>
                ) : (
                  candidateInvoices.map((inv) => (
                    <label
                      key={inv.id}
                      className={`flex items-start gap-3 border rounded-lg px-3 py-2.5 cursor-pointer transition-colors ${
                        selectedInvoiceId === inv.id
                          ? 'border-indigo-300 bg-indigo-50'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <input
                        type="radio"
                        name="invoice"
                        value={inv.id}
                        checked={selectedInvoiceId === inv.id}
                        onChange={() => setSelectedInvoiceId(inv.id)}
                        className="mt-0.5 text-indigo-600 flex-shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-800 truncate">{inv.supplierName}</p>
                        <p className="text-xs text-gray-500">{inv.invoiceNumber} · {formatDate(inv.invoiceDate)}</p>
                      </div>
                      <p className="text-sm font-medium text-gray-800 whitespace-nowrap flex-shrink-0">
                        {formatCurrency(inv.amountCZK)}
                      </p>
                    </label>
                  ))
                )}
              </div>
            </div>
          )}

          {mode === 'ignore' && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">Category</label>
                <select
                  value={ignoreCategory}
                  onChange={(e) => setIgnoreCategory(e.target.value as IgnoreCategoryId)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
                >
                  {IGNORE_CATEGORIES.map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">Note (optional)</label>
                <input
                  type="text"
                  value={ignoreNote}
                  onChange={(e) => setIgnoreNote(e.target.value)}
                  placeholder="e.g. Jana Nováková — March salary"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-100 flex items-center justify-between flex-shrink-0">
          <div>
            {(tx.state === 'reconciled' || tx.state === 'ignored') && (
              <button
                onClick={handleUnmatch}
                disabled={saving}
                className="text-xs text-gray-400 hover:text-red-500"
              >
                Reset to unmatched
              </button>
            )}
          </div>
          <div className="flex gap-3">
            <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
            <button
              onClick={handleSave}
              disabled={!canSave || saving}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2"
            >
              {saving && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

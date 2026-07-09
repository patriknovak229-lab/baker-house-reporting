'use client';
import { useState, useMemo } from 'react';
import type { BankTransaction } from '@/types/bankTransaction';
import { formatCurrency, formatDate } from '@/utils/formatters';

interface Props {
  transactions: BankTransaction[];
  /** Book this credit as a direct accommodation revenue record + reconcile it */
  onBook: (tx: BankTransaction) => Promise<void>;
  onClose: () => void;
}

/**
 * Quick-label incoming bank credits as DIRECT accommodation revenue (no invoice/doc).
 * For guest payments that didn't come through the QR/Stripe flow (e.g. a plain bank
 * transfer). OTA payouts should be linked to their settlement instead, not booked here.
 */
export default function DirectPaymentModal({ transactions, onBook, onClose }: Props) {
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const candidates = useMemo(() => {
    const q = search.toLowerCase();
    return transactions
      .filter((t) => t.direction === 'credit' && t.state === 'revenue' && !t.revenueInvoiceId)
      .filter((t) => !q || (t.counterpartyName ?? '').toLowerCase().includes(q) || formatDate(t.date).includes(search) || String(t.amount).includes(search))
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [transactions, search]);

  async function book(tx: BankTransaction) {
    setBusy(tx.id);
    try { await onBook(tx); } finally { setBusy(null); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 flex flex-col max-h-[90vh] overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <h2 className="text-base font-semibold text-gray-800">Label direct accommodation payment</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-3">
          <p className="text-xs text-gray-500">
            Books the selected credit as accommodation revenue (no invoice) and reconciles it.
            Use for direct guest payments only — link OTA payouts to their settlement instead.
          </p>
          <input
            type="text"
            placeholder="Search incoming credits…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
          />
          {candidates.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-6">No unlinked incoming credits found.</p>
          ) : (
            <div className="space-y-1.5">
              {candidates.map((tx) => (
                <div key={tx.id} className="flex items-center gap-2 border border-gray-100 rounded-lg px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-800 truncate">{tx.counterpartyName ?? '—'}</p>
                    <p className="text-xs text-gray-400">{formatDate(tx.date)}</p>
                  </div>
                  <p className="text-sm font-semibold text-green-700 whitespace-nowrap">+{formatCurrency(tx.amount)}</p>
                  <button
                    onClick={() => { void book(tx); }}
                    disabled={busy === tx.id}
                    className="px-3 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex-shrink-0"
                  >
                    {busy === tx.id ? 'Booking…' : 'Book as accommodation'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex justify-end flex-shrink-0">
          <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">Done</button>
        </div>
      </div>
    </div>
  );
}

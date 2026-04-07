'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import type { BankTransaction, BankTransactionState } from '@/types/bankTransaction';
import type { SupplierInvoice } from '@/types/supplierInvoice';
import { formatCurrency } from '@/utils/formatters';
import BankImportModal from './BankImportModal';
import BankTransactionList from './BankTransactionList';
import ReconcileDrawer from './ReconcileDrawer';

interface ImportResult {
  imported: number;
  duplicates: number;
  autoReconciled: number;
  transactions: BankTransaction[];
}

interface Props {
  invoices: SupplierInvoice[];
  onInvoiceUpdate: (inv: SupplierInvoice) => void;
}

type FilterState = 'all' | BankTransactionState;

const FILTERS: { value: FilterState; label: string }[] = [
  { value: 'all',        label: 'All' },
  { value: 'unmatched',  label: 'Unmatched' },
  { value: 'reconciled', label: 'Reconciled' },
  { value: 'ignored',    label: 'Ignored' },
  { value: 'revenue',    label: 'Revenue' },
];

export default function BankPage({ invoices, onInvoiceUpdate }: Props) {
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterState>('all');
  const [drawerTx, setDrawerTx] = useState<BankTransaction | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [importBanner, setImportBanner] = useState<ImportResult | null>(null);

  const loadTransactions = useCallback(async () => {
    try {
      const res = await fetch('/api/bank-transactions');
      if (res.ok) setTransactions(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadTransactions(); }, [loadTransactions]);

  function handleImported(result: ImportResult) {
    setTransactions(result.transactions);
    setShowImport(false);
    setImportBanner(result);
    // Bubble up any auto-reconciled invoice changes
    for (const tx of result.transactions) {
      if (tx.state === 'reconciled' && tx.invoiceId) {
        const inv = invoices.find((i) => i.id === tx.invoiceId);
        if (inv && inv.status !== 'reconciled') {
          onInvoiceUpdate({ ...inv, status: 'reconciled', bankTransactionId: tx.id, reconciledAt: tx.reconciledAt });
        }
      }
    }
  }

  function handleDrawerSave(updated: BankTransaction) {
    setTransactions((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    setDrawerTx(updated);

    // Reflect reconciliation change in the supplier invoice list
    if (updated.state === 'reconciled' && updated.invoiceId) {
      const inv = invoices.find((i) => i.id === updated.invoiceId);
      if (inv) {
        onInvoiceUpdate({
          ...inv,
          status: 'reconciled',
          bankTransactionId: updated.id,
          reconciledAt: updated.reconciledAt,
        });
      }
    } else if ((updated.state === 'unmatched' || updated.state === 'ignored')) {
      // Find previously linked invoice and revert it
      const prev = transactions.find((t) => t.id === updated.id);
      if (prev?.invoiceId) {
        const inv = invoices.find((i) => i.id === prev.invoiceId);
        if (inv) {
          onInvoiceUpdate({
            ...inv,
            status: 'pending',
            bankTransactionId: undefined,
            reconciledAt: undefined,
          });
        }
      }
    }

    setDrawerTx(null);
  }

  const filtered = useMemo(
    () => filter === 'all' ? transactions : transactions.filter((t) => t.state === filter),
    [transactions, filter],
  );

  // Summary stats
  const now = new Date();
  const thisMonthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const yearStart = `${now.getFullYear()}-01-01`;

  const debits = transactions.filter((t) => t.direction === 'debit');
  const monthSpend   = debits.filter((t) => t.date.startsWith(thisMonthPrefix)).reduce((s, t) => s + t.amount, 0);
  const yearSpend    = debits.filter((t) => t.date >= yearStart).reduce((s, t) => s + t.amount, 0);
  const unmatched    = debits.filter((t) => t.state === 'unmatched').length;
  const revenueCount = transactions.filter((t) => t.state === 'revenue').length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Bank Reconciliation</h2>
          <p className="text-sm text-gray-500 mt-0.5">Match bank payments to supplier invoices</p>
        </div>
        <button
          onClick={() => setShowImport(true)}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
          Import CSV
        </button>
      </div>

      {/* Import result banner */}
      {importBanner && (
        <div className="flex items-start justify-between bg-green-50 border border-green-200 rounded-xl px-4 py-3 gap-3">
          <div className="flex items-start gap-2.5">
            <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0 mt-1.5" />
            <div>
              <p className="text-sm font-medium text-green-800">Import complete</p>
              <p className="text-xs text-green-600 mt-0.5">
                {importBanner.imported} imported · {importBanner.duplicates} duplicates skipped · {importBanner.autoReconciled} auto-reconciled
              </p>
            </div>
          </div>
          <button onClick={() => setImportBanner(null)} className="text-green-400 hover:text-green-600 flex-shrink-0">×</button>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">This month</p>
          <p className="text-xl font-semibold text-gray-800">{formatCurrency(monthSpend)}</p>
          <p className="text-xs text-gray-400 mt-0.5">outgoing</p>
        </div>
        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">This year</p>
          <p className="text-xl font-semibold text-gray-800">{formatCurrency(yearSpend)}</p>
          <p className="text-xs text-gray-400 mt-0.5">outgoing</p>
        </div>
        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Unreconciled</p>
          <p className={`text-xl font-semibold ${unmatched > 0 ? 'text-amber-600' : 'text-gray-800'}`}>{unmatched}</p>
          <p className="text-xs text-gray-400 mt-0.5">payments to match</p>
        </div>
        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Revenue</p>
          <p className="text-xl font-semibold text-indigo-400">{revenueCount}</p>
          <p className="text-xs text-gray-400 mt-0.5">incoming · Phase 3</p>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 p-1 bg-gray-100 rounded-xl w-fit">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
              filter === f.value
                ? 'bg-white shadow-sm text-indigo-700 font-medium'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {f.label}
            {f.value === 'unmatched' && unmatched > 0 && (
              <span className="ml-1.5 text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">{unmatched}</span>
            )}
          </button>
        ))}
      </div>

      {/* Transaction list */}
      <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <BankTransactionList
            transactions={filtered}
            invoices={invoices}
            onSelect={setDrawerTx}
          />
        )}
      </div>

      {/* Modals */}
      {showImport && (
        <BankImportModal onImported={handleImported} onClose={() => setShowImport(false)} />
      )}

      {drawerTx && (
        <ReconcileDrawer
          transaction={drawerTx}
          invoices={invoices}
          onSave={handleDrawerSave}
          onClose={() => setDrawerTx(null)}
        />
      )}
    </div>
  );
}

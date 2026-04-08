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
type PeriodPreset = 'all' | 'this_month' | 'last_month' | 'this_quarter' | 'this_year';

const FILTERS: { value: FilterState; label: string }[] = [
  { value: 'all',           label: 'All' },
  { value: 'unmatched',     label: 'Unmatched costs' },
  { value: 'revenue',       label: 'Unmatched revenue' },
  { value: 'reconciled',    label: 'Reconciled' },
  { value: 'net_settlement',label: 'Net settlements' },
  { value: 'refund',        label: 'Refunds' },
  { value: 'partial_refund',label: 'Partial refunds' },
  { value: 'ignored',       label: 'Ignored' },
  { value: 'non_deductible',label: 'Non-deductible' },
];

const PERIOD_PRESETS: { value: PeriodPreset; label: string }[] = [
  { value: 'all',          label: 'All time' },
  { value: 'this_month',   label: 'This month' },
  { value: 'last_month',   label: 'Last month' },
  { value: 'this_quarter', label: 'This quarter' },
  { value: 'this_year',    label: 'This year' },
];

function getPeriodRange(preset: PeriodPreset): { from: string; to: string } | null {
  if (preset === 'all') return null;
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-indexed

  if (preset === 'this_month') {
    const mm = String(m + 1).padStart(2, '0');
    return { from: `${y}-${mm}-01`, to: `${y}-${mm}-31` };
  }
  if (preset === 'last_month') {
    const lm = m === 0 ? 11 : m - 1;
    const ly = m === 0 ? y - 1 : y;
    const mm = String(lm + 1).padStart(2, '0');
    return { from: `${ly}-${mm}-01`, to: `${ly}-${mm}-31` };
  }
  if (preset === 'this_quarter') {
    const q = Math.floor(m / 3);
    const qm = String(q * 3 + 1).padStart(2, '0');
    const qe = String(q * 3 + 3).padStart(2, '0');
    return { from: `${y}-${qm}-01`, to: `${y}-${qe}-31` };
  }
  if (preset === 'this_year') {
    return { from: `${y}-01-01`, to: `${y}-12-31` };
  }
  return null;
}

export default function BankPage({ invoices, onInvoiceUpdate }: Props) {
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterState>('all');
  const [period, setPeriod] = useState<PeriodPreset>('all');
  const [search, setSearch] = useState('');
  const [drawerTx, setDrawerTx] = useState<BankTransaction | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [importBanner, setImportBanner] = useState<ImportResult | null>(null);
  const [matching, setMatching] = useState(false);
  const [matchBanner, setMatchBanner] = useState<number | null>(null);

  const loadTransactions = useCallback(async () => {
    try {
      const res = await fetch('/api/bank-transactions');
      if (res.ok) setTransactions(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadTransactions(); }, [loadTransactions]);

  async function handleAutoMatch() {
    setMatching(true);
    setMatchBanner(null);
    try {
      const res = await fetch('/api/bank-transactions/reconcile', { method: 'POST' });
      if (res.ok) {
        const data = await res.json() as { matched: number; transactions: BankTransaction[] };
        setTransactions(data.transactions);
        setMatchBanner(data.matched);
        for (const tx of data.transactions) {
          if (tx.state === 'reconciled' && tx.invoiceId) {
            const inv = invoices.find((i) => i.id === tx.invoiceId);
            if (inv && inv.status !== 'reconciled') {
              onInvoiceUpdate({ ...inv, status: 'reconciled', bankTransactionId: tx.id, reconciledAt: tx.reconciledAt });
            }
          }
        }
      }
    } finally {
      setMatching(false);
    }
  }

  function handleImported(result: ImportResult) {
    setTransactions(result.transactions);
    setShowImport(false);
    setImportBanner(result);
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
    setTransactions((prev) => {
      const next = prev.map((t) => (t.id === updated.id ? updated : t));

      // When a refund links to a debit, also update that debit in local state
      if ((updated.state === 'refund' || updated.state === 'partial_refund') && updated.linkedTransactionId) {
        return next.map((t) =>
          t.id === updated.linkedTransactionId
            ? { ...t, linkedTransactionId: updated.id, state: 'reconciled' as const, reconciledAt: updated.reconciledAt }
            : t,
        );
      }
      // When resetting a refund, restore the previously linked debit to unmatched
      const prev_ = prev.find((t) => t.id === updated.id);
      if (
        (updated.state === 'revenue' || updated.state === 'unmatched') &&
        prev_?.linkedTransactionId &&
        (prev_?.state === 'refund' || prev_?.state === 'partial_refund')
      ) {
        return next.map((t) =>
          t.id === prev_.linkedTransactionId
            ? { ...t, linkedTransactionId: undefined, state: 'unmatched' as const, reconciledAt: undefined }
            : t,
        );
      }

      return next;
    });

    // Helper: is a given invoice still covered by another net_settlement tx (other than `updatedId`)?
    const isStillSettledElsewhere = (invId: string, updatedId: string) =>
      transactions.some((t) => t.id !== updatedId && (t.deductedInvoiceIds ?? []).includes(invId));

    if (updated.state === 'reconciled' && updated.invoiceId) {
      const inv = invoices.find((i) => i.id === updated.invoiceId);
      if (inv) onInvoiceUpdate({ ...inv, status: 'reconciled', bankTransactionId: updated.id, reconciledAt: updated.reconciledAt });
    } else if (updated.state === 'net_settlement') {
      // Mark each deducted invoice as reconciled in parent state
      for (const invId of updated.deductedInvoiceIds ?? []) {
        const inv = invoices.find((i) => i.id === invId);
        if (inv) onInvoiceUpdate({ ...inv, status: 'reconciled', bankTransactionId: updated.id, reconciledAt: updated.reconciledAt });
      }
      // Un-reconcile invoices that were previously deducted but are no longer in the list
      const prev = transactions.find((t) => t.id === updated.id);
      for (const prevId of prev?.deductedInvoiceIds ?? []) {
        if (!(updated.deductedInvoiceIds ?? []).includes(prevId) && !isStillSettledElsewhere(prevId, updated.id)) {
          const inv = invoices.find((i) => i.id === prevId);
          if (inv) onInvoiceUpdate({ ...inv, status: 'pending', bankTransactionId: undefined, reconciledAt: undefined });
        }
      }
    } else if (updated.state === 'unmatched' || updated.state === 'ignored' || updated.state === 'non_deductible' || updated.state === 'revenue') {
      const prev = transactions.find((t) => t.id === updated.id);
      if (prev?.invoiceId) {
        const inv = invoices.find((i) => i.id === prev.invoiceId);
        if (inv) onInvoiceUpdate({ ...inv, status: 'pending', bankTransactionId: undefined, reconciledAt: undefined });
      }
      // Un-reconcile previously deducted invoices — but only if no other settlement still covers them
      for (const prevId of prev?.deductedInvoiceIds ?? []) {
        if (!isStillSettledElsewhere(prevId, updated.id)) {
          const inv = invoices.find((i) => i.id === prevId);
          if (inv) onInvoiceUpdate({ ...inv, status: 'pending', bankTransactionId: undefined, reconciledAt: undefined });
        }
      }
    }

    setDrawerTx(null);
  }

  const periodRange = useMemo(() => getPeriodRange(period), [period]);

  const filtered = useMemo(() => {
    let result = filter === 'all' ? transactions : transactions.filter((t) => t.state === filter);

    if (periodRange) {
      result = result.filter((t) => t.date >= periodRange.from && t.date <= periodRange.to);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((t) =>
        (t.counterpartyName ?? '').toLowerCase().includes(q) ||
        (t.counterpartyAccount ?? '').toLowerCase().includes(q) ||
        (t.variableSymbol ?? '').toLowerCase().includes(q) ||
        (t.description ?? '').toLowerCase().includes(q) ||
        (t.myDescription ?? '').toLowerCase().includes(q) ||
        (t.ignoreNote ?? '').toLowerCase().includes(q),
      );
    }
    return result;
  }, [transactions, filter, periodRange, search]);

  // ── Summary stats ──────────────────────────────────────────────────────────
  const now = new Date();
  const thisMonthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const yearStart = `${now.getFullYear()}-01-01`;

  const debits  = transactions.filter((t) => t.direction === 'debit');
  const credits = transactions.filter((t) => t.direction === 'credit');

  const monthOut  = debits .filter((t) => t.date.startsWith(thisMonthPrefix)).reduce((s, t) => s + t.amount, 0);
  const yearOut   = debits .filter((t) => t.date >= yearStart).reduce((s, t) => s + t.amount, 0);
  const monthIn   = credits.filter((t) => t.date.startsWith(thisMonthPrefix)).reduce((s, t) => s + t.amount, 0);
  const yearIn    = credits.filter((t) => t.date >= yearStart).reduce((s, t) => s + t.amount, 0);

  const unmatchedCosts   = debits .filter((t) => t.state === 'unmatched').length;
  const unmatchedRevenue = credits.filter((t) => t.state === 'revenue').length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Bank Reconciliation</h2>
          <p className="text-sm text-gray-500 mt-0.5">Match bank payments to supplier invoices and incoming revenue</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleAutoMatch}
            disabled={matching || unmatchedCosts === 0}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-50"
            title={unmatchedCosts === 0 ? 'No unmatched costs to process' : 'Re-run auto-matching against pending invoices'}
          >
            {matching
              ? <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
              : <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            }
            Auto-match
          </button>
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

      {/* Auto-match result banner */}
      {matchBanner !== null && (
        <div className="flex items-start justify-between bg-indigo-50 border border-indigo-200 rounded-xl px-4 py-3 gap-3">
          <div className="flex items-start gap-2.5">
            <span className="w-2 h-2 rounded-full bg-indigo-500 flex-shrink-0 mt-1.5" />
            <div>
              <p className="text-sm font-medium text-indigo-800">Auto-match complete</p>
              <p className="text-xs text-indigo-600 mt-0.5">
                {matchBanner > 0 ? `${matchBanner} transaction${matchBanner !== 1 ? 's' : ''} matched` : 'No confident matches found'}
              </p>
            </div>
          </div>
          <button onClick={() => setMatchBanner(null)} className="text-indigo-400 hover:text-indigo-600 flex-shrink-0">×</button>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Out · this month</p>
          <p className="text-lg font-semibold text-gray-800">{formatCurrency(monthOut)}</p>
        </div>
        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Out · this year</p>
          <p className="text-lg font-semibold text-gray-800">{formatCurrency(yearOut)}</p>
        </div>
        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">In · this month</p>
          <p className="text-lg font-semibold text-green-700">{formatCurrency(monthIn)}</p>
        </div>
        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">In · this year</p>
          <p className="text-lg font-semibold text-green-700">{formatCurrency(yearIn)}</p>
        </div>
        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Unmatched costs</p>
          <p className={`text-lg font-semibold ${unmatchedCosts > 0 ? 'text-amber-600' : 'text-gray-800'}`}>{unmatchedCosts}</p>
          <p className="text-xs text-gray-400 mt-0.5">payments</p>
        </div>
        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Unmatched revenue</p>
          <p className={`text-lg font-semibold ${unmatchedRevenue > 0 ? 'text-indigo-500' : 'text-gray-800'}`}>{unmatchedRevenue}</p>
          <p className="text-xs text-gray-400 mt-0.5">receipts</p>
        </div>
      </div>

      {/* Period presets */}
      <div className="flex gap-1 p-1 bg-gray-100 rounded-xl w-fit">
        {PERIOD_PRESETS.map((p) => (
          <button
            key={p.value}
            onClick={() => setPeriod(p.value)}
            className={`px-3 py-1.5 rounded-lg text-sm transition-colors whitespace-nowrap ${
              period === p.value
                ? 'bg-white shadow-sm text-gray-900 font-medium'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Filter tabs + search */}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
        <div className="flex gap-1 p-1 bg-gray-100 rounded-xl w-fit flex-shrink-0 flex-wrap">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`px-3 py-1.5 rounded-lg text-sm transition-colors whitespace-nowrap ${
                filter === f.value
                  ? 'bg-white shadow-sm text-indigo-700 font-medium'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {f.label}
              {f.value === 'unmatched' && unmatchedCosts > 0 && (
                <span className="ml-1.5 text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">{unmatchedCosts}</span>
              )}
              {f.value === 'revenue' && unmatchedRevenue > 0 && (
                <span className="ml-1.5 text-xs bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded-full">{unmatchedRevenue}</span>
              )}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Search counterparty, VS, description…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
        />
        {search && (
          <button onClick={() => setSearch('')} className="text-xs text-gray-400 hover:text-gray-600 whitespace-nowrap">
            Clear
          </button>
        )}
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
            allTransactions={transactions}
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
          transactions={transactions}
          invoices={invoices}
          onSave={handleDrawerSave}
          onClose={() => setDrawerTx(null)}
        />
      )}
    </div>
  );
}

'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import type { RevenueInvoice } from '@/types/revenueInvoice';
import type { BankTransaction } from '@/types/bankTransaction';
import { formatCurrency } from '@/utils/formatters';
import RevenueInvoiceList from './RevenueInvoiceList';
import RevenueInvoiceDrawer from './RevenueInvoiceDrawer';

type FilterState = 'all' | 'pending' | 'reconciled' | 'issued' | 'manual';
type PeriodPreset = 'all' | 'this_month' | 'last_month' | 'this_quarter' | 'this_year';

const FILTERS: { value: FilterState; label: string }[] = [
  { value: 'all',        label: 'All' },
  { value: 'pending',    label: 'Pending' },
  { value: 'reconciled', label: 'Reconciled' },
  { value: 'issued',     label: 'QR issued' },
  { value: 'manual',     label: 'Manual' },
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
  const m = now.getMonth();
  const pad = (v: number) => String(v).padStart(2, '0');

  if (preset === 'this_month')   return { from: `${y}-${pad(m+1)}-01`, to: `${y}-${pad(m+1)}-31` };
  if (preset === 'last_month')   { const lm = m === 0 ? 11 : m-1; const ly = m === 0 ? y-1 : y; return { from: `${ly}-${pad(lm+1)}-01`, to: `${ly}-${pad(lm+1)}-31` }; }
  if (preset === 'this_quarter') { const q = Math.floor(m/3); return { from: `${y}-${pad(q*3+1)}-01`, to: `${y}-${pad(q*3+3)}-31` }; }
  if (preset === 'this_year')    return { from: `${y}-01-01`, to: `${y}-12-31` };
  return null;
}

interface Props {
  /** Pass-through from AccountingPage so the drawer can show credit tx candidates */
  bankTransactions: BankTransaction[];
  onBankTxUpdate: (tx: BankTransaction) => void;
}

export default function RevenuePage({ bankTransactions, onBankTxUpdate }: Props) {
  const [invoices, setInvoices] = useState<RevenueInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterState>('all');
  const [period, setPeriod] = useState<PeriodPreset>('all');
  const [search, setSearch] = useState('');
  const [drawerInvoice, setDrawerInvoice] = useState<RevenueInvoice | 'add' | null>(null);

  const loadInvoices = useCallback(async () => {
    try {
      const res = await fetch('/api/revenue-invoices');
      if (res.ok) setInvoices(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadInvoices(); }, [loadInvoices]);

  function handleUpdate(updated: RevenueInvoice) {
    setInvoices((prev) => {
      const idx = prev.findIndex((i) => i.id === updated.id);
      if (idx >= 0) return prev.map((i) => (i.id === updated.id ? updated : i));
      return [updated, ...prev];
    });
  }

  const periodRange = useMemo(() => getPeriodRange(period), [period]);

  const filtered = useMemo(() => {
    let result = invoices;

    if (filter === 'pending')    result = result.filter((i) => i.status === 'pending');
    if (filter === 'reconciled') result = result.filter((i) => i.status === 'reconciled');
    if (filter === 'issued')     result = result.filter((i) => i.sourceType === 'issued');
    if (filter === 'manual')     result = result.filter((i) => i.sourceType === 'manual');

    if (periodRange) {
      result = result.filter((i) => i.invoiceDate >= periodRange.from && i.invoiceDate <= periodRange.to);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((i) =>
        i.invoiceNumber.toLowerCase().includes(q) ||
        (i.guestName ?? '').toLowerCase().includes(q) ||
        (i.clientName ?? '').toLowerCase().includes(q) ||
        (i.reservationNumber ?? '').toLowerCase().includes(q) ||
        (i.description ?? '').toLowerCase().includes(q),
      );
    }

    return result;
  }, [invoices, filter, periodRange, search]);

  // Summary stats (always computed over all invoices — not filtered, for the summary cards)
  const now = new Date();
  const thisMonthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const totalInvoiced   = invoices.reduce((s, i) => s + i.amountCZK, 0);
  const totalReconciled = invoices.filter((i) => i.status === 'reconciled').reduce((s, i) => s + i.amountCZK, 0);
  const totalPending    = invoices.filter((i) => i.status === 'pending').reduce((s, i) => s + i.amountCZK, 0);
  const thisMonthTotal  = invoices.filter((i) => i.invoiceDate.startsWith(thisMonthPrefix)).reduce((s, i) => s + i.amountCZK, 0);

  const pendingCount    = invoices.filter((i) => i.status === 'pending').length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Revenue Invoices</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Guest payments · QR invoices from Transactions tab · Manual uploads
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Total invoiced</p>
          <p className="text-xl font-semibold text-gray-800">{formatCurrency(totalInvoiced)}</p>
          <p className="text-xs text-gray-400 mt-0.5">{invoices.length} invoice{invoices.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Reconciled</p>
          <p className="text-xl font-semibold text-green-600">{formatCurrency(totalReconciled)}</p>
          <p className="text-xs text-gray-400 mt-0.5">payment confirmed</p>
        </div>
        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Pending</p>
          <p className="text-xl font-semibold text-amber-600">{formatCurrency(totalPending)}</p>
          <p className="text-xs text-gray-400 mt-0.5">{pendingCount} awaiting payment</p>
        </div>
        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">This month</p>
          <p className="text-xl font-semibold text-indigo-600">{formatCurrency(thisMonthTotal)}</p>
          <p className="text-xs text-gray-400 mt-0.5">
            {invoices.filter((i) => i.invoiceDate.startsWith(thisMonthPrefix)).length} invoices
          </p>
        </div>
      </div>

      {/* Period presets */}
      <div className="flex gap-1 p-1 bg-gray-100 rounded-xl w-fit">
        {PERIOD_PRESETS.map((p) => (
          <button
            key={p.value}
            onClick={() => setPeriod(p.value)}
            className={`px-3 py-1.5 rounded-lg text-sm transition-colors whitespace-nowrap ${
              period === p.value ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-white border border-gray-100 rounded-xl p-4">
        <div className="flex flex-wrap gap-3">
          <input
            type="text"
            placeholder="Search invoice #, guest, client…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm flex-1 min-w-40 focus:outline-none focus:ring-1 focus:ring-indigo-400"
          />
          <div className="flex gap-1 p-1 bg-gray-100 rounded-lg">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={`px-3 py-1 rounded text-sm transition-colors whitespace-nowrap ${
                  filter === f.value ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Invoice list */}
      <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <RevenueInvoiceList
            invoices={filtered}
            transactions={bankTransactions}
            onSelect={(inv) => setDrawerInvoice(inv)}
            onAddManual={() => setDrawerInvoice('add')}
          />
        )}
      </div>

      {/* Drawer */}
      {drawerInvoice !== null && (
        <RevenueInvoiceDrawer
          invoice={drawerInvoice === 'add' ? null : drawerInvoice}
          transactions={bankTransactions}
          onClose={() => setDrawerInvoice(null)}
          onUpdate={handleUpdate}
          onBankTxUpdate={onBankTxUpdate}
        />
      )}
    </div>
  );
}

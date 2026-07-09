'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import type { RevenueInvoice } from '@/types/revenueInvoice';
import type { BankTransaction } from '@/types/bankTransaction';
import { formatCurrency } from '@/utils/formatters';
import RevenueInvoiceList from './RevenueInvoiceList';
import RevenueInvoiceDrawer from './RevenueInvoiceDrawer';
import OtaSettlementImportModal from './OtaSettlementImportModal';
import OtaSettlementDrawer from './OtaSettlementDrawer';
import DirectPaymentModal from './DirectPaymentModal';
import type { SettlementGroup } from '@/types/settlementGroup';
import { isReportSettlement } from '@/types/settlementGroup';
import type { ExtractedSettlementData } from '@/app/api/revenue-invoices/extract-settlement/route';

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
  /** Reload the Costs-tab supplier invoices (a settlement auto-creates a fee cost record there) */
  onCostRecordsChanged?: () => void;
}

export default function RevenuePage({ bankTransactions, onBankTxUpdate, onCostRecordsChanged }: Props) {
  const [invoices, setInvoices] = useState<RevenueInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterState>('all');
  const [period, setPeriod] = useState<PeriodPreset>('all');
  const [search, setSearch] = useState('');
  const [drawerInvoice, setDrawerInvoice] = useState<RevenueInvoice | 'add' | null>(null);

  // OTA settlements (Airbnb earnings reports → SettlementGroup with report data)
  const [settlements, setSettlements] = useState<SettlementGroup[]>([]);
  const [showSettlementImport, setShowSettlementImport] = useState(false);
  const [settlementQueue, setSettlementQueue] = useState<File[]>([]);
  const [extractingSettlement, setExtractingSettlement] = useState(false);
  const [settlementDrawer, setSettlementDrawer] = useState<
    | { mode: 'view'; group: SettlementGroup }
    | { mode: 'create'; extracted: ExtractedSettlementData | null; file: File | null }
    | null
  >(null);
  const [showDirectModal, setShowDirectModal] = useState(false);

  const loadInvoices = useCallback(async () => {
    try {
      const res = await fetch('/api/revenue-invoices');
      if (res.ok) setInvoices(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSettlements = useCallback(async () => {
    try {
      const res = await fetch('/api/settlement-groups');
      if (res.ok) {
        const all = await res.json() as SettlementGroup[];
        setSettlements(all.filter(isReportSettlement));
      }
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { loadInvoices(); loadSettlements(); }, [loadInvoices, loadSettlements]);

  // Process uploaded report files one at a time: extract → open review drawer.
  const processNextSettlement = useCallback(async (files: File[]) => {
    if (files.length === 0) { setExtractingSettlement(false); return; }
    const [next, ...rest] = files;
    setSettlementQueue(rest);
    setExtractingSettlement(true);
    try {
      const fd = new FormData();
      fd.append('file', next);
      const res = await fetch('/api/revenue-invoices/extract-settlement', { method: 'POST', body: fd });
      const extracted = res.ok ? (await res.json() as ExtractedSettlementData) : null;
      setSettlementDrawer({ mode: 'create', extracted, file: next });
    } catch {
      setSettlementDrawer({ mode: 'create', extracted: null, file: next });
    } finally {
      setExtractingSettlement(false);
    }
  }, []);

  function handleSettlementBatch(files: File[]) {
    setShowSettlementImport(false);
    void processNextSettlement(files);
  }

  function handleSettlementDrawerClose() {
    setSettlementDrawer(null);
    // A settlement creates/updates/deletes its gross revenue record + fee cost record,
    // so refresh the settlements list, the revenue invoice list, and the Costs tab.
    void loadSettlements();
    void loadInvoices();
    onCostRecordsChanged?.();
    if (settlementQueue.length > 0) void processNextSettlement(settlementQueue);
  }

  function handleSettlementUpdate(group: SettlementGroup | null) {
    if (!group) return; // deletion: lists refresh on drawer close
    setSettlements((prev) => {
      const idx = prev.findIndex((g) => g.id === group.id);
      return idx >= 0 ? prev.map((g) => (g.id === group.id ? group : g)) : [group, ...prev];
    });
  }

  // Book an incoming credit as a direct accommodation revenue record (no invoice) + reconcile it
  async function handleBookDirect(tx: BankTransaction) {
    const invoiceNumber = `DIRECT-${tx.date}-${tx.id.slice(-6)}`;
    const res = await fetch('/api/revenue-invoices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceType: 'direct',
        category: 'accommodation_direct',
        status: 'pending',
        invoiceNumber,
        invoiceDate: tx.date,
        amountCZK: tx.amount,
        clientName: tx.counterpartyName ?? 'Direct payment',
        description: 'Direct accommodation payment',
      }),
    });
    if (!res.ok) return;
    const inv = await res.json() as RevenueInvoice;
    const linkRes = await fetch(`/api/revenue-invoices/${inv.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'link_bank', bankTransactionId: tx.id }),
    });
    if (linkRes.ok) {
      const data = await linkRes.json() as { invoice: RevenueInvoice; transaction: BankTransaction };
      handleUpdate(data.invoice);
      onBankTxUpdate(data.transaction);
    } else {
      handleUpdate(inv);
    }
  }

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

      {/* OTA settlements (Airbnb earnings reports) */}
      <div className="bg-white border border-gray-100 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-sm font-semibold text-gray-800">OTA settlements</p>
            <p className="text-xs text-gray-400">Airbnb earnings reports · gross recognised by period, net linked to payouts</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowDirectModal(true)}
              className="px-3 py-2 border border-gray-200 text-gray-600 text-sm font-medium rounded-lg hover:bg-gray-50"
            >
              Label direct payment
            </button>
            <button
              onClick={() => setShowSettlementImport(true)}
              className="flex items-center gap-2 px-3 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Import report
            </button>
          </div>
        </div>

        {settlements.length === 0 ? (
          <p className="text-xs text-gray-400 py-4 text-center">No OTA settlements yet. Import an earnings report to start.</p>
        ) : (
          <div className="space-y-1.5">
            {settlements.map((g) => {
              const net = g.netAmount ?? ((g.grossAmount ?? 0) - (g.commissionAmount ?? 0));
              const linkedSum = bankTransactions
                .filter((t) => g.transactionIds.includes(t.id))
                .reduce((s, t) => s + t.amount, 0);
              const tolerance = Math.max(1, g.transactionIds.length);
              const reconciled = g.transactionIds.length > 0 && Math.abs(linkedSum - net) <= tolerance;
              return (
                <button
                  key={g.id}
                  onClick={() => setSettlementDrawer({ mode: 'view', group: g })}
                  className="w-full flex items-center gap-3 border border-gray-100 rounded-lg px-3 py-2.5 hover:border-indigo-300 hover:bg-indigo-50/40 text-left transition-colors"
                >
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-rose-100 text-rose-700 capitalize flex-shrink-0">{g.source ?? 'ota'}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-800 truncate">{g.name}</p>
                    <p className="text-xs text-gray-400">
                      Gross {formatCurrency(g.grossAmount ?? 0)} · fee {formatCurrency(g.commissionAmount ?? 0)} · net {formatCurrency(net)}
                    </p>
                  </div>
                  <span className={`text-xs font-medium flex-shrink-0 px-2 py-0.5 rounded-full ${
                    reconciled ? 'bg-green-100 text-green-700'
                      : g.transactionIds.length > 0 ? 'bg-amber-100 text-amber-700'
                      : 'bg-gray-100 text-gray-500'
                  }`}>
                    {reconciled ? '✓ reconciled' : `${g.transactionIds.length} payout${g.transactionIds.length !== 1 ? 's' : ''}`}
                  </span>
                </button>
              );
            })}
          </div>
        )}
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

      {/* OTA settlement import modal */}
      {showSettlementImport && (
        <OtaSettlementImportModal
          onProcessBatch={handleSettlementBatch}
          onClose={() => setShowSettlementImport(false)}
        />
      )}

      {/* Direct-payment quick-label modal */}
      {showDirectModal && (
        <DirectPaymentModal
          transactions={bankTransactions}
          onBook={handleBookDirect}
          onClose={() => setShowDirectModal(false)}
        />
      )}

      {/* Extracting overlay */}
      {extractingSettlement && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20">
          <div className="bg-white rounded-xl shadow-lg px-8 py-6 flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm font-medium text-gray-700">Extracting report with Claude…</p>
            {settlementQueue.length > 0 && <p className="text-xs text-gray-400">{settlementQueue.length} more queued</p>}
          </div>
        </div>
      )}

      {/* Settlement drawer (review/create or view/link) */}
      {settlementDrawer && (
        <OtaSettlementDrawer
          extracted={settlementDrawer.mode === 'create' ? settlementDrawer.extracted : undefined}
          file={settlementDrawer.mode === 'create' ? settlementDrawer.file : undefined}
          group={settlementDrawer.mode === 'view' ? settlementDrawer.group : undefined}
          transactions={bankTransactions}
          queueRemaining={settlementQueue.length}
          onClose={handleSettlementDrawerClose}
          onGroupUpdate={handleSettlementUpdate}
          onTxUpdate={onBankTxUpdate}
        />
      )}
    </div>
  );
}

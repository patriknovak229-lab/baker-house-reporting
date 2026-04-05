'use client';
import { useState, useEffect, useCallback } from 'react';
import type {
  SupplierInvoice,
  SupplierInvoiceCategory,
  SupplierInvoiceStatus,
  ExtractedInvoiceData,
  SupplierInvoiceSource,
} from '@/types/supplierInvoice';
import SupplierInvoiceList from './SupplierInvoiceList';
import InvoiceImportModal from './InvoiceImportModal';
import InvoiceReviewDrawer from './InvoiceReviewDrawer';
import { formatCurrency } from '@/utils/formatters';

const PHASES = [
  { id: 1, label: 'Costs', description: 'Supplier invoices' },
  { id: 2, label: 'Bank', description: 'Reconciliation' },
  { id: 3, label: 'Revenue', description: 'Guest invoices' },
  { id: 4, label: 'Statements', description: 'P&L · Balance Sheet' },
];

interface DrawerState {
  extracted: ExtractedInvoiceData | null;
  file: File | null;
  existing: SupplierInvoice | null;
  sourceType: SupplierInvoiceSource;
  gmailMessageId?: string;
  extractionFailed?: boolean;
}

interface GmailStatus {
  connected: boolean;
  email?: string;
  connectedAt?: string;
}

function GmailConnectionBanner({ status, onDisconnect }: { status: GmailStatus | null; onDisconnect: () => void }) {
  if (status === null) return null; // still loading

  if (!status.connected) {
    return (
      <div className="flex items-center justify-between bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-800">Invoice Gmail not connected</p>
            <p className="text-xs text-amber-600">Connect truthseeker.sro@gmail.com to enable Gmail sync</p>
          </div>
        </div>
        <a
          href="/api/accounting/connect-gmail"
          className="px-3 py-1.5 bg-amber-600 text-white text-xs font-medium rounded-lg hover:bg-amber-700 whitespace-nowrap"
        >
          Connect Gmail
        </a>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between bg-green-50 border border-green-200 rounded-xl px-4 py-3">
      <div className="flex items-center gap-2.5">
        <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
        <div>
          <p className="text-sm font-medium text-green-800">Invoice Gmail connected</p>
          <p className="text-xs text-green-600">{status.email}</p>
        </div>
      </div>
      <button
        onClick={onDisconnect}
        className="text-xs text-green-700 hover:text-red-600 underline"
      >
        Disconnect
      </button>
    </div>
  );
}

interface QueueItem {
  file: File;
  gmailMessageId: string;
}

export default function AccountingPage() {
  const [invoices, setInvoices] = useState<SupplierInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [showImportModal, setShowImportModal] = useState(false);
  const [drawerState, setDrawerState] = useState<DrawerState | null>(null);
  const [gmailStatus, setGmailStatus] = useState<GmailStatus | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [filters, setFilters] = useState({
    status: 'all' as 'all' | SupplierInvoiceStatus,
    category: 'all' as 'all' | SupplierInvoiceCategory,
    search: '',
    dateFrom: '',
    dateTo: '',
  });

  const loadInvoices = useCallback(async () => {
    try {
      const res = await fetch('/api/supplier-invoices');
      if (res.ok) setInvoices(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  const loadGmailStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/accounting/connect-gmail/status');
      if (res.ok) setGmailStatus(await res.json());
    } catch {
      setGmailStatus({ connected: false });
    }
  }, []);

  useEffect(() => {
    loadInvoices();
    loadGmailStatus();
    // Show a toast if returning from a successful OAuth connection
    const params = new URLSearchParams(window.location.search);
    if (params.get('gmailConnected')) {
      window.history.replaceState({}, '', window.location.pathname);
      loadGmailStatus();
    }
  }, [loadInvoices, loadGmailStatus]);

  async function handleDisconnectGmail() {
    if (!confirm('Disconnect the invoice Gmail account?')) return;
    await fetch('/api/accounting/connect-gmail/status', { method: 'DELETE' });
    setGmailStatus({ connected: false });
  }

  // Extract the next item in the queue and open the drawer for it
  async function processNextInQueue(remaining: QueueItem[]) {
    if (remaining.length === 0) { setExtracting(false); return; }
    const [next, ...rest] = remaining;
    setQueue(rest);
    setExtracting(true);
    try {
      const fd = new FormData();
      fd.append('file', next.file);
      const res = await fetch('/api/supplier-invoices/extract', { method: 'POST', body: fd });
      if (res.ok) {
        const extracted = await res.json() as ExtractedInvoiceData;
        setDrawerState({ extracted, file: next.file, existing: null, sourceType: 'email', gmailMessageId: next.gmailMessageId });
      } else {
        // Extraction failed — open drawer so user can fill in manually
        setDrawerState({ extracted: null, file: next.file, existing: null, sourceType: 'email', gmailMessageId: next.gmailMessageId, extractionFailed: true });
      }
    } catch {
      // Network / parse error — open drawer so user can fill in manually
      setDrawerState({ extracted: null, file: next.file, existing: null, sourceType: 'email', gmailMessageId: next.gmailMessageId, extractionFailed: true });
    } finally {
      setExtracting(false);
    }
  }

  // Called when user clicks "Process N invoices" in the modal
  function handleProcessBatch(items: QueueItem[]) {
    setShowImportModal(false);
    const [first, ...rest] = items;
    setQueue(rest);
    processNextInQueue([first, ...rest]);
  }

  // Called when user picks a single file from upload tab
  async function handleFileSelected(file: File) {
    setShowImportModal(false);
    setExtracting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/supplier-invoices/extract', { method: 'POST', body: fd });
      if (res.ok) {
        const extracted = await res.json() as ExtractedInvoiceData;
        setDrawerState({ extracted, file, existing: null, sourceType: 'upload' });
      } else {
        setDrawerState({ extracted: null, file, existing: null, sourceType: 'upload', extractionFailed: true });
      }
    } catch {
      setDrawerState({ extracted: null, file, existing: null, sourceType: 'upload', extractionFailed: true });
    } finally {
      setExtracting(false);
    }
  }

  async function handleSave(inv: SupplierInvoice) {
    const isNew = !invoices.some((e) => e.id === inv.id);
    const method = isNew ? 'POST' : 'PUT';
    const url = isNew ? '/api/supplier-invoices' : `/api/supplier-invoices/${inv.id}`;

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inv),
    });

    if (res.ok) {
      const saved = await res.json() as SupplierInvoice;
      setInvoices((prev) =>
        isNew ? [saved, ...prev] : prev.map((e) => (e.id === saved.id ? saved : e))
      );
    }
    setDrawerState(null);
    // Process next in queue if any
    if (queue.length > 0) processNextInQueue(queue);
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this invoice?')) return;
    const res = await fetch(`/api/supplier-invoices/${id}`, { method: 'DELETE' });
    if (res.ok) {
      setInvoices((prev) => prev.filter((inv) => inv.id !== id));
    }
  }

  function handleManualEntry() {
    setShowImportModal(false);
    setDrawerState({ extracted: null, file: null, existing: null, sourceType: 'manual' });
  }

  function handleEdit(inv: SupplierInvoice) {
    setDrawerState({ extracted: null, file: null, existing: inv, sourceType: inv.sourceType });
  }

  function handleDrawerClose() {
    setDrawerState(null);
    // Skip current item, move to next in queue
    if (queue.length > 0) processNextInQueue(queue);
  }

  // Summary stats for the current month
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthInvoices = invoices.filter((inv) => inv.invoiceDate.startsWith(thisMonth));
  const monthTotal = monthInvoices.reduce((s, inv) => s + inv.amountCZK, 0);
  const pendingCount = invoices.filter((inv) => inv.status === 'pending').length;

  return (
    <div className="max-w-screen-xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      {/* Phase navigation */}
      <div className="flex items-center gap-1 p-1 bg-gray-100 rounded-xl w-fit">
        {PHASES.map((phase) => (
          <div
            key={phase.id}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors ${
              phase.id === 1
                ? 'bg-white shadow-sm text-indigo-700 font-medium'
                : 'text-gray-400 cursor-not-allowed'
            }`}
            title={phase.id !== 1 ? 'Coming soon' : undefined}
          >
            <span className={`w-5 h-5 rounded-full text-xs font-bold flex items-center justify-center ${
              phase.id === 1 ? 'bg-indigo-600 text-white' : 'bg-gray-300 text-gray-500'
            }`}>
              {phase.id}
            </span>
            <span className="hidden sm:inline">{phase.label}</span>
          </div>
        ))}
      </div>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Supplier Invoices</h1>
          <p className="text-sm text-gray-500 mt-0.5">Track and manage costs — cleaning, utilities, services</p>
        </div>
        <button
          onClick={() => setShowImportModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Invoice
        </button>
      </div>

      {/* Gmail connection banner */}
      <GmailConnectionBanner status={gmailStatus} onDisconnect={handleDisconnectGmail} />

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">This month</p>
          <p className="text-xl font-semibold text-gray-800">{formatCurrency(monthTotal)}</p>
          <p className="text-xs text-gray-400 mt-0.5">{monthInvoices.length} invoice{monthInvoices.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Pending reconciliation</p>
          <p className="text-xl font-semibold text-amber-600">{pendingCount}</p>
          <p className="text-xs text-gray-400 mt-0.5">invoice{pendingCount !== 1 ? 's' : ''} to match</p>
        </div>
        <div className="bg-white border border-gray-100 rounded-xl p-4 col-span-2 sm:col-span-1">
          <p className="text-xs text-gray-500 mb-1">Total invoices</p>
          <p className="text-xl font-semibold text-gray-800">{invoices.length}</p>
          <p className="text-xs text-gray-400 mt-0.5">all time</p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white border border-gray-100 rounded-xl p-4">
        <div className="flex flex-wrap gap-3">
          <input
            type="text"
            placeholder="Search supplier, invoice #…"
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm flex-1 min-w-40 focus:outline-none focus:ring-1 focus:ring-indigo-400"
          />
          <select
            value={filters.status}
            onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as typeof filters.status }))}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
          >
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="reconciled">Reconciled</option>
          </select>
          <select
            value={filters.category}
            onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value as typeof filters.category }))}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
          >
            <option value="all">All categories</option>
            <option value="cleaning">Cleaning</option>
            <option value="laundry">Laundry</option>
            <option value="consumables">Consumables</option>
            <option value="utilities">Utilities</option>
            <option value="software">Software</option>
            <option value="maintenance">Maintenance</option>
            <option value="other">Other</option>
          </select>
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={filters.dateFrom}
              onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))}
              className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
            <span className="text-gray-400 text-sm">–</span>
            <input
              type="date"
              value={filters.dateTo}
              onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))}
              className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
          </div>
          {(filters.status !== 'all' || filters.category !== 'all' || filters.search || filters.dateFrom || filters.dateTo) && (
            <button
              onClick={() => setFilters({ status: 'all', category: 'all', search: '', dateFrom: '', dateTo: '' })}
              className="text-xs text-gray-400 hover:text-gray-600 px-2"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* Invoice list */}
      <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <SupplierInvoiceList
            invoices={invoices}
            filters={filters}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        )}
      </div>

      {/* Modals / Drawers */}
      {showImportModal && (
        <InvoiceImportModal
          onProcessBatch={handleProcessBatch}
          onFileSelected={handleFileSelected}
          onManual={handleManualEntry}
          onClose={() => setShowImportModal(false)}
        />
      )}

      {/* Extraction loading overlay */}
      {extracting && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20">
          <div className="bg-white rounded-xl shadow-lg px-8 py-6 flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm font-medium text-gray-700">Extracting with Claude…</p>
            {queue.length > 0 && (
              <p className="text-xs text-gray-400">{queue.length} more remaining</p>
            )}
          </div>
        </div>
      )}

      {drawerState && (
        <InvoiceReviewDrawer
          extracted={drawerState.extracted}
          file={drawerState.file}
          existing={drawerState.existing}
          sourceType={drawerState.sourceType}
          gmailMessageId={drawerState.gmailMessageId}
          extractionFailed={drawerState.extractionFailed}
          onSave={handleSave}
          onClose={handleDrawerClose}
          queueRemaining={queue.length}
        />
      )}
    </div>
  );
}

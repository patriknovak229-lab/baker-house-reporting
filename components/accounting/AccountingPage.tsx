'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  SupplierInvoice,
  SupplierInvoiceStatus,
  ExtractedInvoiceData,
  SupplierInvoiceSource,
  WhitelistedSupplier,
} from '@/types/supplierInvoice';
import SupplierInvoiceList from './SupplierInvoiceList';
import InvoiceImportModal from './InvoiceImportModal';
import InvoiceReviewDrawer from './InvoiceReviewDrawer';
import CategoryManager from './CategoryManager';
import WhitelistManager from './WhitelistManager';
import { useCategories } from './useCategories';
import { formatCurrency } from '@/utils/formatters';
import { compressImageIfNeeded } from '@/utils/imageCompressor';

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

interface QueueItem {
  file: File;
  gmailMessageId?: string;
}

interface AutoSavedEntry {
  supplierName: string;
  invoiceNumber: string;
  amountCZK: number;
}

function GmailConnectionBanner({ status, onDisconnect }: { status: GmailStatus | null; onDisconnect: () => void }) {
  if (status === null) return null;
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
        <a href="/api/accounting/connect-gmail" className="px-3 py-1.5 bg-amber-600 text-white text-xs font-medium rounded-lg hover:bg-amber-700 whitespace-nowrap">
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
      <button onClick={onDisconnect} className="text-xs text-green-700 hover:text-red-600 underline">Disconnect</button>
    </div>
  );
}

function AutoSavedBanner({ entries, onDismiss }: { entries: AutoSavedEntry[]; onDismiss: () => void }) {
  if (entries.length === 0) return null;
  return (
    <div className="flex items-start justify-between bg-indigo-50 border border-indigo-200 rounded-xl px-4 py-3 gap-3">
      <div className="flex items-start gap-2.5">
        <span className="w-2 h-2 rounded-full bg-indigo-500 flex-shrink-0 mt-1.5" />
        <div>
          <p className="text-sm font-medium text-indigo-800">
            {entries.length} invoice{entries.length !== 1 ? 's' : ''} auto-processed
          </p>
          <div className="text-xs text-indigo-600 mt-0.5 space-y-0.5">
            {entries.map((e, i) => (
              <p key={i}>{e.supplierName} · {e.invoiceNumber} · {formatCurrency(e.amountCZK)}</p>
            ))}
          </div>
        </div>
      </div>
      <button onClick={onDismiss} className="text-indigo-400 hover:text-indigo-600 flex-shrink-0">×</button>
    </div>
  );
}

/** Match extracted supplier name against whitelist (case-insensitive, trimmed) */
function matchWhitelist(supplierName: string | null, whitelist: WhitelistedSupplier[]): WhitelistedSupplier | null {
  if (!supplierName) return null;
  const norm = supplierName.trim().toLowerCase();
  return whitelist.find((w) => w.supplierName.trim().toLowerCase() === norm) ?? null;
}

/** Check all required fields are present for auto-save */
function canAutoSave(extracted: ExtractedInvoiceData): boolean {
  return !!(
    extracted.supplierName &&
    extracted.invoiceNumber &&
    extracted.invoiceDate &&
    extracted.amountCZK != null &&
    extracted.amountCZK > 0
  );
}

export default function AccountingPage() {
  const [invoices, setInvoices] = useState<SupplierInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [showImportModal, setShowImportModal] = useState(false);
  const [drawerState, setDrawerState] = useState<DrawerState | null>(null);
  const [gmailStatus, setGmailStatus] = useState<GmailStatus | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [showCategoryManager, setShowCategoryManager] = useState(false);
  const [showWhitelistManager, setShowWhitelistManager] = useState(false);
  const [whitelist, setWhitelist] = useState<WhitelistedSupplier[]>([]);
  const [autoSavedEntries, setAutoSavedEntries] = useState<AutoSavedEntry[]>([]);
  const { categories } = useCategories();
  const [filters, setFilters] = useState({
    status: 'all' as 'all' | SupplierInvoiceStatus,
    category: 'all' as string,
    search: '',
    dateFrom: '',
    dateTo: '',
  });

  // Use a ref so processNextInQueue always sees the latest whitelist
  const whitelistRef = useRef<WhitelistedSupplier[]>([]);
  whitelistRef.current = whitelist;

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

  const loadWhitelist = useCallback(async () => {
    try {
      const res = await fetch('/api/supplier-invoices/whitelist');
      if (res.ok) setWhitelist(await res.json());
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => {
    loadInvoices();
    loadGmailStatus();
    loadWhitelist();
    const params = new URLSearchParams(window.location.search);
    if (params.get('gmailConnected')) {
      window.history.replaceState({}, '', window.location.pathname);
      loadGmailStatus();
    }
  }, [loadInvoices, loadGmailStatus, loadWhitelist]);

  async function handleDisconnectGmail() {
    if (!confirm('Disconnect the invoice Gmail account?')) return;
    await fetch('/api/accounting/connect-gmail/status', { method: 'DELETE' });
    setGmailStatus({ connected: false });
  }

  /** Save an invoice directly (no drawer) — used for whitelisted auto-processing */
  async function autoSaveInvoice(
    extracted: ExtractedInvoiceData,
    matched: WhitelistedSupplier,
    file: File,
    gmailMessageId?: string,
  ): Promise<void> {
    // Drive upload first
    let driveFileId: string | undefined;
    let driveFileName: string | undefined;
    let driveUrl: string | undefined;
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('supplierName', extracted.supplierName!);
      fd.append('invoiceNumber', extracted.invoiceNumber!);
      fd.append('amountCZK', String(Math.round(extracted.amountCZK!)));
      fd.append('invoiceDate', extracted.invoiceDate!);
      const driveRes = await fetch('/api/supplier-invoices/drive-upload', { method: 'POST', body: fd });
      if (driveRes.ok) {
        const d = await driveRes.json() as { fileId: string; fileName: string; driveUrl: string };
        driveFileId = d.fileId;
        driveFileName = d.fileName;
        driveUrl = d.driveUrl;
      }
    } catch { /* non-fatal */ }

    const invoice: SupplierInvoice = {
      id: crypto.randomUUID(),
      supplierName: extracted.supplierName!,
      supplierICO: extracted.supplierICO ?? undefined,
      invoiceNumber: extracted.invoiceNumber!,
      invoiceDate: extracted.invoiceDate!,
      dueDate: extracted.dueDate ?? undefined,
      amountCZK: extracted.amountCZK!,
      vatAmountCZK: extracted.vatAmountCZK ?? undefined,
      category: matched.category,
      status: 'pending',
      sourceType: 'email',
      gmailMessageId,
      driveFileId,
      driveFileName,
      driveUrl,
      autoProcessed: true,
      createdAt: new Date().toISOString(),
    };

    const res = await fetch('/api/supplier-invoices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(invoice),
    });

    if (res.ok) {
      const saved = await res.json() as SupplierInvoice;
      setInvoices((prev) => [saved, ...prev]);
      setAutoSavedEntries((prev) => [...prev, {
        supplierName: saved.supplierName,
        invoiceNumber: saved.invoiceNumber,
        amountCZK: saved.amountCZK,
      }]);
    }
  }

  async function processNextInQueue(remaining: QueueItem[]) {
    if (remaining.length === 0) { setExtracting(false); return; }
    const [next, ...rest] = remaining;
    setQueue(rest);
    setExtracting(true);
    try {
      const compressed = await compressImageIfNeeded(next.file);
      const fd = new FormData();
      fd.append('file', compressed);
      const res = await fetch('/api/supplier-invoices/extract', { method: 'POST', body: fd });
      if (res.ok) {
        const extracted = await res.json() as ExtractedInvoiceData;
        // Check whitelist
        const matched = matchWhitelist(extracted.supplierName, whitelistRef.current);
        if (matched && canAutoSave(extracted)) {
          setExtracting(false);
          await autoSaveInvoice(extracted, matched, compressed, next.gmailMessageId);
          // Continue with next item
          processNextInQueue(rest);
          return;
        }
        setDrawerState({ extracted, file: compressed, existing: null, sourceType: 'email', gmailMessageId: next.gmailMessageId });
      } else {
        setDrawerState({ extracted: null, file: compressed, existing: null, sourceType: 'email', gmailMessageId: next.gmailMessageId, extractionFailed: true });
      }
    } catch {
      setDrawerState({ extracted: null, file: next.file, existing: null, sourceType: 'email', gmailMessageId: next.gmailMessageId, extractionFailed: true });
    } finally {
      setExtracting(false);
    }
  }

  function handleProcessBatch(items: QueueItem[]) {
    setShowImportModal(false);
    setAutoSavedEntries([]);
    processNextInQueue(items);
  }

  async function handleFileSelected(file: File) {
    setShowImportModal(false);
    setExtracting(true);
    let compressed = file;
    try {
      compressed = await compressImageIfNeeded(file);
      const fd = new FormData();
      fd.append('file', compressed);
      const res = await fetch('/api/supplier-invoices/extract', { method: 'POST', body: fd });
      if (res.ok) {
        const extracted = await res.json() as ExtractedInvoiceData;
        setDrawerState({ extracted, file: compressed, existing: null, sourceType: 'upload' });
      } else {
        setDrawerState({ extracted: null, file: compressed, existing: null, sourceType: 'upload', extractionFailed: true });
      }
    } catch {
      setDrawerState({ extracted: null, file: compressed, existing: null, sourceType: 'upload', extractionFailed: true });
    } finally {
      setExtracting(false);
    }
  }

  async function persistInvoice(inv: SupplierInvoice): Promise<void> {
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
      setInvoices((prev) => isNew ? [saved, ...prev] : prev.map((e) => (e.id === saved.id ? saved : e)));
    }
  }

  async function handleSave(inv: SupplierInvoice) {
    await persistInvoice(inv);
    setDrawerState(null);
    if (queue.length > 0) processNextInQueue(queue);
  }

  async function handleSaveAndWhitelist(inv: SupplierInvoice) {
    await persistInvoice(inv);
    // Add supplier to whitelist
    try {
      const res = await fetch('/api/supplier-invoices/whitelist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplierName: inv.supplierName, category: inv.category }),
      });
      if (res.ok) {
        const entry = await res.json() as WhitelistedSupplier;
        setWhitelist((prev) => [...prev, entry]);
      }
    } catch { /* non-fatal */ }
    setDrawerState(null);
    if (queue.length > 0) processNextInQueue(queue);
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this invoice?')) return;
    const res = await fetch(`/api/supplier-invoices/${id}`, { method: 'DELETE' });
    if (res.ok) setInvoices((prev) => prev.filter((inv) => inv.id !== id));
  }

  function handleManualEntry() {
    setShowImportModal(false);
    setDrawerState({ extracted: null, file: null, existing: null, sourceType: 'manual' });
  }

  async function handleReuploadDrive(inv: SupplierInvoice, file: File) {
    const compressed = await compressImageIfNeeded(file);
    const fd = new FormData();
    fd.append('file', compressed);
    fd.append('supplierName', inv.supplierName);
    fd.append('invoiceNumber', inv.invoiceNumber);
    fd.append('amountCZK', String(Math.round(inv.amountCZK)));
    fd.append('invoiceDate', inv.invoiceDate);
    const driveRes = await fetch('/api/supplier-invoices/drive-upload', { method: 'POST', body: fd });
    if (!driveRes.ok) return;
    const d = await driveRes.json() as { fileId: string; fileName: string; driveUrl: string };
    const updated: SupplierInvoice = {
      ...inv,
      driveFileId: d.fileId,
      driveFileName: d.fileName,
      driveUrl: d.driveUrl,
    };
    const res = await fetch(`/api/supplier-invoices/${inv.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    });
    if (res.ok) {
      const saved = await res.json() as SupplierInvoice;
      setInvoices((prev) => prev.map((e) => (e.id === saved.id ? saved : e)));
    }
  }

  function handleEdit(inv: SupplierInvoice) {
    setDrawerState({ extracted: null, file: null, existing: inv, sourceType: inv.sourceType });
  }

  function handleDrawerClose() {
    setDrawerState(null);
    if (queue.length > 0) processNextInQueue(queue);
  }

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
          <div key={phase.id}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors ${phase.id === 1 ? 'bg-white shadow-sm text-indigo-700 font-medium' : 'text-gray-400 cursor-not-allowed'}`}
            title={phase.id !== 1 ? 'Coming soon' : undefined}
          >
            <span className={`w-5 h-5 rounded-full text-xs font-bold flex items-center justify-center ${phase.id === 1 ? 'bg-indigo-600 text-white' : 'bg-gray-300 text-gray-500'}`}>
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
        <div className="flex items-center gap-2">
          <button onClick={() => setShowWhitelistManager(true)} className="px-3 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50">
            Whitelist
          </button>
          <button onClick={() => setShowCategoryManager(true)} className="px-3 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50">
            Categories
          </button>
          <button onClick={() => setShowImportModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Invoice
          </button>
        </div>
      </div>

      {/* Gmail connection banner */}
      <GmailConnectionBanner status={gmailStatus} onDisconnect={handleDisconnectGmail} />

      {/* Auto-saved notification */}
      <AutoSavedBanner entries={autoSavedEntries} onDismiss={() => setAutoSavedEntries([])} />

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
          <input type="text" placeholder="Search supplier, invoice #…" value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm flex-1 min-w-40 focus:outline-none focus:ring-1 focus:ring-indigo-400"
          />
          <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as typeof filters.status }))}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
          >
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="reconciled">Reconciled</option>
          </select>
          <select value={filters.category} onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
          >
            <option value="all">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
          <div className="flex items-center gap-1.5">
            <input type="date" value={filters.dateFrom} onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))}
              className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400" />
            <span className="text-gray-400 text-sm">–</span>
            <input type="date" value={filters.dateTo} onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))}
              className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400" />
          </div>
          {(filters.status !== 'all' || filters.category !== 'all' || filters.search || filters.dateFrom || filters.dateTo) && (
            <button onClick={() => setFilters({ status: 'all', category: 'all', search: '', dateFrom: '', dateTo: '' })}
              className="text-xs text-gray-400 hover:text-gray-600 px-2">
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
          <SupplierInvoiceList invoices={invoices} filters={filters} onEdit={handleEdit} onDelete={handleDelete} onReuploadDrive={handleReuploadDrive} />
        )}
      </div>

      {/* Modals / Drawers */}
      {showCategoryManager && <CategoryManager onClose={() => setShowCategoryManager(false)} />}
      {showWhitelistManager && (
        <WhitelistManager
          onClose={() => { setShowWhitelistManager(false); loadWhitelist(); }}
        />
      )}

      {showImportModal && (
        <InvoiceImportModal
          onProcessBatch={handleProcessBatch}
          onFileSelected={handleFileSelected}
          onManual={handleManualEntry}
          onClose={() => setShowImportModal(false)}
        />
      )}

      {extracting && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20">
          <div className="bg-white rounded-xl shadow-lg px-8 py-6 flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm font-medium text-gray-700">Extracting with Claude…</p>
            {queue.length > 0 && <p className="text-xs text-gray-400">{queue.length} more remaining</p>}
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
          onSaveAndWhitelist={drawerState.existing ? undefined : handleSaveAndWhitelist}
          onClose={handleDrawerClose}
          queueRemaining={queue.length}
        />
      )}
    </div>
  );
}

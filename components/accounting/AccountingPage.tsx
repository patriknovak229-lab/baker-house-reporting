'use client';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type {
  SupplierInvoice,
  SupplierInvoiceStatus,
  ExtractedInvoiceData,
  SupplierInvoiceSource,
  WhitelistedSupplier,
} from '@/types/supplierInvoice';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import SupplierInvoiceList from './SupplierInvoiceList';
import InvoiceImportModal from './InvoiceImportModal';
import InvoiceReviewDrawer from './InvoiceReviewDrawer';
import CategoryManager from './CategoryManager';
import WhitelistManager from './WhitelistManager';
import { useCategories } from './useCategories';
import { formatCurrency } from '@/utils/formatters';
import { prepareImageFile } from '@/utils/imageCompressor';
import { textColorFor } from '@/utils/categoryColors';
import BankPage from './BankPage';
import RevenuePage from './RevenuePage';
import type { BankTransaction } from '@/types/bankTransaction';

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
  duplicateOf?: SupplierInvoice;   // set when API returned 409 Conflict
}

interface GmailStatus {
  connected: boolean;
  email?: string;
  connectedAt?: string;
}

interface QueueItem {
  file: File;
  gmailMessageId?: string;
  sourceType?: SupplierInvoiceSource;
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

/**
 * Enrich extracted data with ICO / category pulled from the most recent
 * invoice for the same supplier (case-insensitive name match).
 * Only fills fields that extraction left as null.
 */
function enrichFromHistory(
  extracted: ExtractedInvoiceData,
  invoices: SupplierInvoice[],
): ExtractedInvoiceData {
  if (!extracted.supplierName) return extracted;
  const norm = extracted.supplierName.trim().toLowerCase();
  // Most-recent first (invoices are prepended on save)
  const match = invoices.find((inv) => inv.supplierName.trim().toLowerCase() === norm);
  if (!match) return extracted;
  return {
    ...extracted,
    supplierICO: extracted.supplierICO ?? match.supplierICO ?? null,
    suggestedCategory: extracted.suggestedCategory ?? match.category ?? null,
  };
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
  const [activePhase, setActivePhase] = useState(1);
  const [invoices, setInvoices] = useState<SupplierInvoice[]>([]);
  const [bankTransactions, setBankTransactions] = useState<BankTransaction[]>([]);
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
  const [queueRunning, setQueueRunning] = useState(false);
  const abortQueueRef = useRef(false);
  const { categories } = useCategories();
  const [filters, setFilters] = useState({
    status: 'all' as 'all' | SupplierInvoiceStatus,
    category: 'all' as string,
    search: '',
    dateFrom: '',
    dateTo: '',
  });

  const isFiltered = filters.status !== 'all' || filters.category !== 'all' ||
    !!filters.search || !!filters.dateFrom || !!filters.dateTo;

  const filteredInvoices = useMemo(() => invoices.filter((inv) => {
    if (filters.status !== 'all' && inv.status !== filters.status) return false;
    if (filters.category !== 'all' && inv.category !== filters.category) return false;
    if (filters.dateFrom && inv.invoiceDate < filters.dateFrom) return false;
    if (filters.dateTo && inv.invoiceDate > filters.dateTo) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      if (!inv.supplierName.toLowerCase().includes(q) &&
          !inv.invoiceNumber.toLowerCase().includes(q) &&
          !(inv.description ?? '').toLowerCase().includes(q)) return false;
    }
    return true;
  }), [invoices, filters]);

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

  const loadBankTransactions = useCallback(async () => {
    try {
      const res = await fetch('/api/bank-transactions');
      if (res.ok) setBankTransactions(await res.json());
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => {
    loadInvoices();
    loadGmailStatus();
    loadWhitelist();
    loadBankTransactions();
    const params = new URLSearchParams(window.location.search);
    if (params.get('gmailConnected')) {
      window.history.replaceState({}, '', window.location.pathname);
      loadGmailStatus();
    }
  }, [loadInvoices, loadGmailStatus, loadWhitelist, loadBankTransactions]);

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
    invoiceSourceType: SupplierInvoiceSource = 'email',
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
      invoiceCurrency: extracted.invoiceCurrency && extracted.invoiceCurrency !== 'CZK' ? extracted.invoiceCurrency : undefined,
      category: matched.category,
      status: 'pending',
      sourceType: invoiceSourceType,
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

    if (res.status === 409) {
      // Duplicate detected — open drawer so user can review
      const data = await res.json() as { code: string; existing: SupplierInvoice };
      setDrawerState({
        extracted,
        file,
        existing: null,
        sourceType: invoiceSourceType,
        gmailMessageId,
        duplicateOf: data.existing,
      });
      return;
    }

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
    if (remaining.length === 0) { setExtracting(false); setQueueRunning(false); return; }
    // Abort requested: clear queue and stop
    if (abortQueueRef.current) {
      abortQueueRef.current = false;
      setQueueRunning(false);
      setQueue([]);
      setExtracting(false);
      return;
    }
    const [next, ...rest] = remaining;
    setQueue(rest);
    setExtracting(true);
    try {
      const compressed = await prepareImageFile(next.file);
      const fd = new FormData();
      fd.append('file', compressed);
      const res = await fetch('/api/supplier-invoices/extract', { method: 'POST', body: fd });
      if (res.ok) {
        const extracted = enrichFromHistory(await res.json() as ExtractedInvoiceData, invoices);
        // Check whitelist
        const matched = matchWhitelist(extracted.supplierName, whitelistRef.current);
        if (matched && canAutoSave(extracted)) {
          setExtracting(false);
          await autoSaveInvoice(extracted, matched, compressed, next.gmailMessageId, next.sourceType ?? 'email');
          // Continue with next item
          processNextInQueue(rest);
          return;
        }
        setDrawerState({ extracted, file: compressed, existing: null, sourceType: next.sourceType ?? 'email', gmailMessageId: next.gmailMessageId });
      } else {
        setDrawerState({ extracted: null, file: compressed, existing: null, sourceType: next.sourceType ?? 'email', gmailMessageId: next.gmailMessageId, extractionFailed: true });
      }
    } catch {
      setDrawerState({ extracted: null, file: next.file, existing: null, sourceType: next.sourceType ?? 'email', gmailMessageId: next.gmailMessageId, extractionFailed: true });
    } finally {
      setExtracting(false);
    }
  }

  function handleProcessBatch(items: QueueItem[]) {
    setShowImportModal(false);
    setAutoSavedEntries([]);
    abortQueueRef.current = false;
    setQueueRunning(true);
    processNextInQueue(items);
  }

  async function handleFileSelected(file: File, sourceType: SupplierInvoiceSource = 'upload') {
    setShowImportModal(false);
    setExtracting(true);
    let compressed = file;
    try {
      compressed = await prepareImageFile(file);
      const fd = new FormData();
      fd.append('file', compressed);
      const res = await fetch('/api/supplier-invoices/extract', { method: 'POST', body: fd });
      if (res.ok) {
        const extracted = enrichFromHistory(await res.json() as ExtractedInvoiceData, invoices);
        setDrawerState({ extracted, file: compressed, existing: null, sourceType });
      } else {
        setDrawerState({ extracted: null, file: compressed, existing: null, sourceType, extractionFailed: true });
      }
    } catch {
      setDrawerState({ extracted: null, file: compressed, existing: null, sourceType, extractionFailed: true });
    } finally {
      setExtracting(false);
    }
  }

  async function persistInvoice(inv: SupplierInvoice, force = false): Promise<{ ok: boolean; dupOf?: SupplierInvoice }> {
    const isNew = !invoices.some((e) => e.id === inv.id);
    const method = isNew ? 'POST' : 'PUT';
    const url = isNew ? '/api/supplier-invoices' : `/api/supplier-invoices/${inv.id}`;
    const body = force ? { ...inv, force: true } : inv;
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 409) {
      const data = await res.json() as { code: string; existing: SupplierInvoice };
      return { ok: false, dupOf: data.existing };
    }
    if (res.ok) {
      const saved = await res.json() as SupplierInvoice;
      setInvoices((prev) => isNew ? [saved, ...prev] : prev.map((e) => (e.id === saved.id ? saved : e)));
    }
    return { ok: res.ok };
  }

  async function handleSave(inv: SupplierInvoice, force = false) {
    const result = await persistInvoice(inv, force);
    if (!result.ok && result.dupOf) {
      // Keep drawer open, show duplicate warning
      setDrawerState((prev) => prev ? { ...prev, duplicateOf: result.dupOf } : prev);
      return;
    }
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
    const compressed = await prepareImageFile(file);
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

  function handleInvoiceUpdate(updated: SupplierInvoice) {
    setInvoices((prev) => prev.map((inv) => (inv.id === updated.id ? updated : inv)));
  }

  function handleBankTxUpdate(updated: BankTransaction) {
    setBankTransactions((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
  }

  const now = new Date();

  // Time-period helpers (applied to filteredInvoices so category/status/search filters are respected)
  const thisMonthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const quarterMonth = Math.floor(now.getMonth() / 3) * 3;
  const quarterStart = new Date(now.getFullYear(), quarterMonth, 1).toISOString().slice(0, 10);
  const yearStart = `${now.getFullYear()}-01-01`;

  const monthInvoices   = filteredInvoices.filter((inv) => inv.invoiceDate.startsWith(thisMonthPrefix));
  const quarterInvoices = filteredInvoices.filter((inv) => inv.invoiceDate >= quarterStart);
  const yearInvoices    = filteredInvoices.filter((inv) => inv.invoiceDate >= yearStart);

  const monthTotal   = monthInvoices.reduce((s, inv)   => s + inv.amountCZK, 0);
  const quarterTotal = quarterInvoices.reduce((s, inv) => s + inv.amountCZK, 0);
  const yearTotal    = yearInvoices.reduce((s, inv)    => s + inv.amountCZK, 0);
  const pendingCount = filteredInvoices.filter((inv) => inv.status === 'pending').length;

  // Category pie data (by amount, filtered)
  const categoryPieData = categories
    .map((cat) => ({
      name: cat.label,
      value: filteredInvoices.filter((inv) => inv.category === cat.id).reduce((s, inv) => s + inv.amountCZK, 0),
      color: cat.color,
    }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value);

  return (
    <div className="max-w-screen-xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      {/* Phase navigation */}
      <div className="flex items-center gap-1 p-1 bg-gray-100 rounded-xl w-fit">
        {PHASES.map((phase) => {
          const enabled = phase.id <= 3;
          const active = activePhase === phase.id;
          return (
            <div key={phase.id}
              onClick={() => enabled && setActivePhase(phase.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors ${
                active ? 'bg-white shadow-sm text-indigo-700 font-medium' :
                enabled ? 'text-gray-500 hover:text-gray-700 cursor-pointer' :
                'text-gray-400 cursor-not-allowed'
              }`}
              title={!enabled ? 'Coming soon' : undefined}
            >
              <span className={`w-5 h-5 rounded-full text-xs font-bold flex items-center justify-center ${
                active ? 'bg-indigo-600 text-white' :
                enabled ? 'bg-gray-400 text-white' :
                'bg-gray-300 text-gray-500'
              }`}>
                {phase.id}
              </span>
              <span className="hidden sm:inline">{phase.label}</span>
            </div>
          );
        })}
      </div>

      {/* Phase 2 — Bank */}
      {activePhase === 2 && (
        <BankPage
          invoices={invoices}
          onInvoiceUpdate={handleInvoiceUpdate}
          transactions={bankTransactions}
          onTransactionsChange={setBankTransactions}
        />
      )}

      {/* Phase 3 — Revenue */}
      {activePhase === 3 && (
        <RevenuePage bankTransactions={bankTransactions} onBankTxUpdate={handleBankTxUpdate} />
      )}

      {/* Phase 1 — Costs */}
      {activePhase === 1 && (<>

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
      {isFiltered && (
        <p className="text-xs text-indigo-600 font-medium -mb-2">
          ⚡ Filters active — dashboard reflects filtered results
        </p>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">This month</p>
          <p className="text-xl font-semibold text-gray-800">{formatCurrency(monthTotal)}</p>
          <p className="text-xs text-gray-400 mt-0.5">{monthInvoices.length} invoice{monthInvoices.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">This quarter</p>
          <p className="text-xl font-semibold text-gray-800">{formatCurrency(quarterTotal)}</p>
          <p className="text-xs text-gray-400 mt-0.5">{quarterInvoices.length} invoice{quarterInvoices.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">This year</p>
          <p className="text-xl font-semibold text-gray-800">{formatCurrency(yearTotal)}</p>
          <p className="text-xs text-gray-400 mt-0.5">{yearInvoices.length} invoice{yearInvoices.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Pending reconciliation</p>
          <p className="text-xl font-semibold text-amber-600">{pendingCount}</p>
          <p className="text-xs text-gray-400 mt-0.5">invoice{pendingCount !== 1 ? 's' : ''} to match</p>
        </div>
      </div>

      {/* Category breakdown */}
      {categoryPieData.length > 0 && (
        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Spend by category{isFiltered ? ' · filtered' : ''}
          </p>
          <div className="flex flex-col sm:flex-row gap-4 items-center">
            <div className="w-full sm:w-64 h-48 flex-shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={categoryPieData} dataKey="value" nameKey="name"
                    cx="50%" cy="50%" innerRadius="55%" outerRadius="80%"
                    paddingAngle={2}>
                    {categoryPieData.map((entry) => (
                      <Cell key={entry.name} fill={entry.color} stroke={textColorFor(entry.color)} strokeWidth={0.5} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v) => typeof v === 'number' ? formatCurrency(v) : v} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-y-2 gap-x-6 w-full">
              {(() => {
              const pieTotal = categoryPieData.reduce((s, d) => s + d.value, 0);
              return categoryPieData.map((entry) => {
                const pct = pieTotal > 0 ? Math.round((entry.value / pieTotal) * 100) : 0;
                return (
                  <div key={entry.name} className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: entry.color }} />
                    <span className="text-sm text-gray-700 flex-1 truncate">{entry.name}</span>
                    <span className="text-sm font-medium text-gray-800 whitespace-nowrap">{formatCurrency(entry.value)}</span>
                    <span className="text-xs text-gray-400 w-8 text-right">{pct}%</span>
                  </div>
                );
              });
            })()}
            </div>
          </div>
        </div>
      )}

      {/* Period presets */}
      {(() => {
        type PeriodPreset = 'all' | 'this_month' | 'last_month' | 'this_quarter' | 'this_year';
        const PERIOD_PRESETS: { value: PeriodPreset; label: string }[] = [
          { value: 'all',          label: 'All time' },
          { value: 'this_month',   label: 'This month' },
          { value: 'last_month',   label: 'Last month' },
          { value: 'this_quarter', label: 'This quarter' },
          { value: 'this_year',    label: 'This year' },
        ];
        function applyPreset(p: PeriodPreset) {
          if (p === 'all') { setFilters((f) => ({ ...f, dateFrom: '', dateTo: '' })); return; }
          const n = new Date(); const y = n.getFullYear(); const m = n.getMonth();
          const pad = (v: number) => String(v).padStart(2, '0');
          if (p === 'this_month')   { setFilters((f) => ({ ...f, dateFrom: `${y}-${pad(m+1)}-01`, dateTo: `${y}-${pad(m+1)}-31` })); }
          if (p === 'last_month')   { const lm = m === 0 ? 11 : m-1; const ly = m === 0 ? y-1 : y; setFilters((f) => ({ ...f, dateFrom: `${ly}-${pad(lm+1)}-01`, dateTo: `${ly}-${pad(lm+1)}-31` })); }
          if (p === 'this_quarter') { const q = Math.floor(m/3); setFilters((f) => ({ ...f, dateFrom: `${y}-${pad(q*3+1)}-01`, dateTo: `${y}-${pad(q*3+3)}-31` })); }
          if (p === 'this_year')    { setFilters((f) => ({ ...f, dateFrom: `${y}-01-01`, dateTo: `${y}-12-31` })); }
        }
        const activePreset = (): PeriodPreset => {
          if (!filters.dateFrom && !filters.dateTo) return 'all';
          const n = new Date(); const y = n.getFullYear(); const m = n.getMonth();
          const pad = (v: number) => String(v).padStart(2, '0');
          if (filters.dateFrom === `${y}-${pad(m+1)}-01`) return 'this_month';
          const lm = m === 0 ? 11 : m-1; const ly = m === 0 ? y-1 : y;
          if (filters.dateFrom === `${ly}-${pad(lm+1)}-01`) return 'last_month';
          const q = Math.floor(m/3);
          if (filters.dateFrom === `${y}-${pad(q*3+1)}-01`) return 'this_quarter';
          if (filters.dateFrom === `${y}-01-01`) return 'this_year';
          return 'all';
        };
        const active = activePreset();
        return (
          <div className="flex gap-1 p-1 bg-gray-100 rounded-xl w-fit">
            {PERIOD_PRESETS.map((p) => (
              <button key={p.value} onClick={() => applyPreset(p.value)}
                className={`px-3 py-1.5 rounded-lg text-sm transition-colors whitespace-nowrap ${active === p.value ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-500 hover:text-gray-700'}`}>
                {p.label}
              </button>
            ))}
          </div>
        );
      })()}

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
          <SupplierInvoiceList invoices={filteredInvoices} onEdit={handleEdit} onDelete={handleDelete} onReuploadDrive={handleReuploadDrive} />
        )}
      </div>

      </>)}

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
            {queueRunning && (
              <button
                onClick={() => { abortQueueRef.current = true; }}
                className="text-xs text-red-500 hover:text-red-700 underline mt-1"
              >
                Stop after current file
              </button>
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
          duplicateOf={drawerState.duplicateOf}
          onSave={handleSave}
          onSaveAndWhitelist={drawerState.existing ? undefined : handleSaveAndWhitelist}
          onClose={handleDrawerClose}
          queueRemaining={queue.length}
        />
      )}
    </div>
  );
}

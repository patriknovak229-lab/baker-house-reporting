'use client';
import { useState, useEffect, useRef, useMemo } from 'react';
import type {
  SupplierInvoice,
  SupplierInvoiceSource,
  SupplierDocumentType,
  ExtractedInvoiceData,
  ExtractedLineItem,
} from '@/types/supplierInvoice';
import { useCategories } from './useCategories';
import { checkInvoice, findOriginalInvoice, round2 } from '@/utils/invoiceChecks';
import { findKnownSupplier, normalizeIco } from '@/utils/supplierRegistry';

const ALL_ROOMS = ['K.201', 'K.202', 'K.203', 'O.308'];

interface Props {
  extracted?: ExtractedInvoiceData | null;
  file?: File | null;
  existing?: SupplierInvoice | null;
  sourceType: SupplierInvoiceSource;
  gmailMessageId?: string;
  icloudFileName?: string;
  driveSourceFileId?: string;
  extractionFailed?: boolean;
  duplicateOf?: SupplierInvoice | null;   // set when server returned 409
  /** All saved invoices — to pick the original invoice of a credit note */
  invoices?: SupplierInvoice[];
  onSave: (inv: SupplierInvoice, force?: boolean) => void;
  onSaveAndWhitelist?: (inv: SupplierInvoice) => void;
  onClose: () => void;
  queueRemaining?: number;
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}
    </div>
  );
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full border border-gray-200 rounded-md px-3 py-1.5 text-sm text-gray-800 focus:outline-none focus:ring-1 focus:ring-indigo-400 ${props.className ?? ''}`}
    />
  );
}

function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`w-full border border-gray-200 rounded-md px-3 py-1.5 text-sm text-gray-800 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white ${props.className ?? ''}`}
    />
  );
}

function LineItemsBreakdown({
  lineItems,
  currency,
  expanded,
  onToggle,
}: {
  lineItems: ExtractedLineItem[];
  currency: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const total = lineItems.reduce((s, i) => s + i.amount, 0);
  return (
    <div className="border border-violet-200 rounded-lg overflow-hidden text-xs">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2 bg-violet-50 hover:bg-violet-100 transition-colors text-violet-700 font-medium"
      >
        <span>{lineItems.length} reservations · fees summed</span>
        <span className="flex items-center gap-2">
          <span className="text-violet-600">
            {total.toLocaleString('cs-CZ', { style: 'currency', currency, maximumFractionDigits: 2 })}
          </span>
          <span className="text-violet-400">{expanded ? '▾' : '▸'}</span>
        </span>
      </button>
      {expanded && (
        <div className="divide-y divide-violet-100 max-h-48 overflow-y-auto">
          {lineItems.map((item, i) => (
            <div key={i} className="flex justify-between items-center px-3 py-1.5 text-gray-700">
              <span className="truncate mr-4 text-gray-600">{item.description}</span>
              <span className="whitespace-nowrap font-medium">
                {item.amount.toLocaleString('cs-CZ', { style: 'currency', currency, maximumFractionDigits: 2 })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function InvoiceReviewDrawer({
  extracted,
  file: fileProp,
  existing,
  sourceType,
  gmailMessageId,
  icloudFileName,
  driveSourceFileId,
  extractionFailed = false,
  duplicateOf = null,
  invoices = [],
  onSave,
  onSaveAndWhitelist,
  onClose,
  queueRemaining = 0,
}: Props) {
  const { categories } = useCategories();

  const [supplierName, setSupplierName] = useState('');
  const [supplierICO, setSupplierICO] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [duzpDate, setDuzpDate] = useState('');
  const [documentType, setDocumentType] = useState<SupplierDocumentType>('invoice');
  const [originalInvoiceNumber, setOriginalInvoiceNumber] = useState('');
  const [relatedInvoiceId, setRelatedInvoiceId] = useState('');
  const [amountCZK, setAmountCZK] = useState('');
  const [vatAmountCZK, setVatAmountCZK] = useState('');
  const [invoiceCurrency, setInvoiceCurrency] = useState('CZK');
  const [category, setCategory] = useState('other');
  const [rooms, setRooms] = useState<string[]>([]);
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [driveUploading, setDriveUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flagReview, setFlagReview] = useState(existing?.status === 'review_needed');
  const [lineItemsExpanded, setLineItemsExpanded] = useState(false);

  // For manual entry: allow attaching a file directly in the drawer
  const [manualFile, setManualFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeFile = fileProp ?? manualFile;

  useEffect(() => {
    if (existing) {
      setSupplierName(existing.supplierName);
      setSupplierICO(existing.supplierICO ?? '');
      setInvoiceNumber(existing.invoiceNumber);
      setInvoiceDate(existing.invoiceDate);
      setDueDate(existing.dueDate ?? '');
      setDuzpDate(existing.duzpDate ?? '');
      setDocumentType(existing.documentType ?? 'invoice');
      setOriginalInvoiceNumber(existing.originalInvoiceNumber ?? '');
      setRelatedInvoiceId(existing.relatedInvoiceId ?? '');
      // Credit notes are stored negative; the form edits the magnitude
      setAmountCZK(String(Math.abs(existing.amountCZK)));
      setVatAmountCZK(existing.vatAmountCZK != null ? String(Math.abs(existing.vatAmountCZK)) : '');
      setInvoiceCurrency(existing.invoiceCurrency ?? 'CZK');
      setCategory(existing.category);
      setRooms(existing.rooms ?? []);
      setDescription(existing.description ?? '');
    } else if (extracted) {
      if (extracted.supplierName) setSupplierName(extracted.supplierName);
      if (extracted.supplierICO) setSupplierICO(extracted.supplierICO);
      if (extracted.invoiceDate) setInvoiceDate(extracted.invoiceDate);
      if (extracted.dueDate) setDueDate(extracted.dueDate);
      if (extracted.duzpDate) setDuzpDate(extracted.duzpDate);
      if (extracted.amountCZK != null) setAmountCZK(String(Math.abs(extracted.amountCZK)));
      if (extracted.vatAmountCZK != null) setVatAmountCZK(String(Math.abs(extracted.vatAmountCZK)));
      if (extracted.documentType === 'credit_note') {
        setDocumentType('credit_note');
        if (extracted.originalInvoiceNumber) setOriginalInvoiceNumber(extracted.originalInvoiceNumber);
        const original = findOriginalInvoice(extracted.supplierName, extracted.supplierICO, extracted.originalInvoiceNumber, invoices);
        if (original) setRelatedInvoiceId(original.id);
      }
      if (extracted.invoiceCurrency) setInvoiceCurrency(extracted.invoiceCurrency);
      if (extracted.suggestedCategory) setCategory(extracted.suggestedCategory);
      if (extracted.lineItems && extracted.lineItems.length > 0) {
        setDescription(`Service fees — ${extracted.lineItems.length} reservations`);
      }

      // Invoice number: use extracted value, or generate a fallback
      if (extracted.invoiceNumber) {
        setInvoiceNumber(extracted.invoiceNumber);
      } else {
        // INV-SUPPLIERNAME-DDMM  (day + month from the invoice date or today)
        const ref = extracted.invoiceDate ? new Date(extracted.invoiceDate) : new Date();
        const dd = String(ref.getDate()).padStart(2, '0');
        const mm = String(ref.getMonth() + 1).padStart(2, '0');
        const safeName = (extracted.supplierName ?? 'UNKNOWN')
          .replace(/[^a-zA-Z0-9]/g, '')
          .slice(0, 12)
          .toUpperCase();
        setInvoiceNumber(`INV-${safeName}-${dd}${mm}`);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- invoices only seeds the credit-note link once
  }, [extracted, existing]);

  const isCredit = documentType === 'credit_note';

  // Same-supplier invoices a credit note can be linked to (newest first)
  const linkCandidates = useMemo(() => {
    if (!isCredit) return [];
    const name = supplierName.trim().toLowerCase();
    const ico = normalizeIco(supplierICO);
    const known = findKnownSupplier(supplierName, supplierICO);
    return invoices
      .filter((i) => i.documentType !== 'credit_note' && i.id !== existing?.id)
      .filter((i) =>
        (!!name && i.supplierName.trim().toLowerCase() === name) ||
        (!!ico && normalizeIco(i.supplierICO) === ico) ||
        (!!known && findKnownSupplier(i.supplierName, i.supplierICO)?.id === known.id))
      .sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate));
  }, [isCredit, invoices, supplierName, supplierICO, existing?.id]);

  // Live sanity checks on the current form values. The extracted VAT table is only
  // used while total + VAT still equal what was extracted (after a manual correction
  // it would describe the wrong numbers).
  const issues = useMemo(() => {
    const amount = parseFloat(amountCZK);
    const vat = vatAmountCZK ? parseFloat(vatAmountCZK) : null;
    const sign = (n: number) => (isCredit ? -Math.abs(n) : n);
    const unchanged = !!extracted && extracted.amountCZK != null &&
      Math.abs(Math.abs(extracted.amountCZK) - amount) < 0.01 &&
      Math.abs(Math.abs(extracted.vatAmountCZK ?? 0) - (vat ?? 0)) < 0.01;
    return checkInvoice({
      supplierName,
      supplierICO,
      invoiceDate,
      amount: Number.isFinite(amount) ? sign(amount) : null,
      vat: vat != null && Number.isFinite(vat) ? sign(vat) : null,
      currency: invoiceCurrency,
      documentType,
      vatBreakdown: unchanged ? extracted?.vatBreakdown : null,
      hasOriginalInvoice: !!relatedInvoiceId,
    });
  }, [amountCZK, vatAmountCZK, isCredit, extracted, supplierName, supplierICO, invoiceDate, invoiceCurrency, documentType, relatedInvoiceId]);

  // Sync default category once categories load
  useEffect(() => {
    if (categories.length > 0 && !existing && !extracted?.suggestedCategory) {
      setCategory(categories[categories.length - 1].id);
    }
  }, [categories, existing, extracted]);

  function toggleRoom(room: string) {
    setRooms((prev) => prev.includes(room) ? prev.filter((r) => r !== room) : [...prev, room]);
  }

  function handleFileAttach(files: FileList | null) {
    if (!files || files.length === 0) return;
    const f = files[0];
    if (f.type !== 'application/pdf' && !f.type.startsWith('image/')) return;
    setManualFile(f);
  }

  function validate(): boolean {
    if (!supplierName.trim()) { setError('Supplier name is required.'); return false; }
    if (!invoiceNumber.trim()) { setError('Invoice number is required.'); return false; }
    if (!invoiceDate) { setError('Invoice date is required.'); return false; }
    const amount = parseFloat(amountCZK);
    if (isNaN(amount) || amount <= 0) { setError('Amount must be a positive number.'); return false; }
    if (isCredit && !relatedInvoiceId && !originalInvoiceNumber.trim()) {
      setError('Pick the original invoice this credit note belongs to (or type its number).');
      return false;
    }
    return true;
  }

  async function buildInvoice(): Promise<SupplierInvoice> {
    // Credit notes are stored negative so they net off the original invoice
    const sign = (n: number) => round2(isCredit ? -Math.abs(n) : n);
    const amount = sign(parseFloat(amountCZK));

    let driveFileId: string | undefined;
    let driveFileName: string | undefined;
    let driveUrl: string | undefined;

    if (activeFile) {
      setDriveUploading(true);
      try {
        const fd = new FormData();
        fd.append('file', activeFile);
        fd.append('supplierName', supplierName.trim());
        fd.append('invoiceNumber', invoiceNumber.trim());
        fd.append('amountCZK', String(Math.round(amount)));
        fd.append('invoiceDate', invoiceDate);
        const driveRes = await fetch('/api/supplier-invoices/drive-upload', { method: 'POST', body: fd });
        if (driveRes.ok) {
          const d = await driveRes.json() as { fileId: string; fileName: string; driveUrl: string };
          driveFileId = d.fileId;
          driveFileName = d.fileName;
          driveUrl = d.driveUrl;
        }
      } catch { /* non-fatal */ } finally {
        setDriveUploading(false);
      }
    }

    return {
      id: existing?.id ?? crypto.randomUUID(),
      supplierName: supplierName.trim(),
      supplierICO: supplierICO.trim() || undefined,
      invoiceNumber: invoiceNumber.trim(),
      invoiceDate,
      dueDate: dueDate || undefined,
      duzpDate: duzpDate || undefined,
      amountCZK: amount,
      vatAmountCZK: vatAmountCZK ? sign(parseFloat(vatAmountCZK)) : undefined,
      documentType: isCredit ? 'credit_note' : undefined,
      originalInvoiceNumber: isCredit ? (originalInvoiceNumber.trim() || undefined) : undefined,
      relatedInvoiceId: isCredit ? (relatedInvoiceId || undefined) : undefined,
      invoiceCurrency: invoiceCurrency !== 'CZK' ? invoiceCurrency : undefined,
      category,
      rooms: rooms.length > 0 ? rooms : undefined,
      description: description.trim() || undefined,
      status: flagReview ? 'review_needed' : (existing?.status === 'reconciled' ? 'reconciled' : 'pending'),
      sourceType,
      driveFileId: driveFileId ?? existing?.driveFileId,
      driveFileName: driveFileName ?? existing?.driveFileName,
      driveUrl: driveUrl ?? existing?.driveUrl,
      gmailMessageId: gmailMessageId ?? existing?.gmailMessageId,
      icloudFileName: icloudFileName ?? existing?.icloudFileName,
      driveSourceFileId: driveSourceFileId ?? existing?.driveSourceFileId,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
  }

  async function handleSave(force = false) {
    if (!validate()) return;
    setSaving(true);
    setError(null);
    const invoice = await buildInvoice();
    onSave(invoice, force);
    setSaving(false);
  }

  async function handleSaveAndWhitelistClick() {
    if (!validate()) return;
    if (!onSaveAndWhitelist) return;
    setSaving(true);
    setError(null);
    const invoice = await buildInvoice();
    onSaveAndWhitelist(invoice);
    setSaving(false);
  }

  const isEdit = !!existing;
  const isManual = sourceType === 'manual' && !fileProp;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-white shadow-xl flex flex-col h-full overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 sticky top-0 bg-white z-10">
          <div>
            <h2 className="text-base font-semibold text-gray-800">
              {isEdit ? 'Edit Invoice' : 'Review & Save Invoice'}
            </h2>
            {queueRemaining > 0 && (
              <p className="text-xs text-indigo-500 mt-0.5">{queueRemaining} more waiting in queue</p>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none" title={queueRemaining > 0 ? 'Skip & process next' : 'Close'}>×</button>
        </div>

        {/* Form */}
        <div className="flex-1 px-6 py-5 space-y-4">
          {duplicateOf && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-xs text-amber-800 space-y-2">
              <p className="font-semibold">Duplicate detected</p>
              <p>An invoice from <span className="font-medium">{duplicateOf.supplierName}</span> #{duplicateOf.invoiceNumber} already exists (saved {new Date(duplicateOf.createdAt).toLocaleDateString('cs-CZ')}).</p>
              <div className="flex gap-2 mt-1">
                <button onClick={onClose} className="px-3 py-1.5 text-xs font-medium border border-amber-300 rounded-md hover:bg-amber-100">
                  Skip
                </button>
                <button onClick={() => handleSave(true)} disabled={saving} className="px-3 py-1.5 text-xs font-medium bg-amber-600 text-white rounded-md hover:bg-amber-700 disabled:opacity-50">
                  Save anyway
                </button>
              </div>
            </div>
          )}
          {!isEdit && extractionFailed && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-xs text-red-700">
              Claude couldn&apos;t read this document — please fill in the fields manually.
            </div>
          )}
          {!isEdit && !extractionFailed && extracted && (
            <div className="bg-indigo-50 border border-indigo-100 rounded-lg px-4 py-3 text-xs text-indigo-700">
              Fields were auto-filled by Claude from the document. Please review before saving.
            </div>
          )}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-xs text-red-700">{error}</div>
          )}
          {issues.length > 0 && (extracted || existing || amountCZK) && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-xs text-amber-800">
              <p className="font-semibold mb-1">Check before saving</p>
              <ul className="list-disc pl-4 space-y-0.5">
                {issues.map((i, n) => <li key={n}>{i.message}</li>)}
              </ul>
            </div>
          )}

          <div className="flex rounded-lg border border-gray-200 p-0.5 text-xs font-medium w-fit">
            {(['invoice', 'credit_note'] as const).map((t) => (
              <button key={t} type="button" onClick={() => setDocumentType(t)}
                className={`px-3 py-1 rounded-md transition-colors ${documentType === t ? (t === 'credit_note' ? 'bg-rose-600 text-white' : 'bg-indigo-600 text-white') : 'text-gray-500 hover:text-gray-800'}`}>
                {t === 'invoice' ? 'Invoice / receipt' : 'Credit note (dobropis)'}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <Field label="Supplier Name *">
                <Input value={supplierName} onChange={(e) => setSupplierName(e.target.value)} placeholder="e.g. Jana Cleaning s.r.o." />
              </Field>
            </div>
            <Field label="Supplier IČO" hint="Czech company ID">
              <Input value={supplierICO} onChange={(e) => setSupplierICO(e.target.value)} placeholder="12345678" />
            </Field>
            <Field label="Invoice Number *">
              <Input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} placeholder="INV-2026-04" />
            </Field>
            <Field label="Invoice Date *">
              <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
            </Field>
            <Field label="Due Date">
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </Field>
            <Field label="DUZP" hint="Taxable-supply date, if different">
              <Input type="date" value={duzpDate} onChange={(e) => setDuzpDate(e.target.value)} />
            </Field>
            <div />
            {isCredit && (
              <div className="col-span-2 grid grid-cols-2 gap-4 bg-rose-50 border border-rose-100 rounded-lg p-3">
                <div className="col-span-2">
                  <Field label="Credit note for invoice *" hint="Several credit notes can point at the same invoice (e.g. one per returned item).">
                    <Select value={relatedInvoiceId} onChange={(e) => {
                      setRelatedInvoiceId(e.target.value);
                      const inv = linkCandidates.find((c) => c.id === e.target.value);
                      if (inv) setOriginalInvoiceNumber(inv.invoiceNumber);
                    }}>
                      <option value="">— not linked —</option>
                      {linkCandidates.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.invoiceDate} · #{c.invoiceNumber} · {c.amountCZK.toLocaleString('cs-CZ', { maximumFractionDigits: 2 })} {c.invoiceCurrency ?? 'CZK'}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <Field label="Original invoice # (as printed)">
                  <Input value={originalInvoiceNumber} onChange={(e) => setOriginalInvoiceNumber(e.target.value)} placeholder="e.g. 4024458200" />
                </Field>
                <p className="text-xs text-rose-700 self-end pb-1">Amounts below are entered positive and saved as negative (they reduce the cost).</p>
              </div>
            )}
            <Field label={`${isCredit ? 'Credited' : 'Total'} Amount (${invoiceCurrency}) *`}>
              <Input type="number" min="0" step="0.01" value={amountCZK} onChange={(e) => setAmountCZK(e.target.value)} placeholder="1500" />
            </Field>
            <Field label={`VAT Amount (${invoiceCurrency})`}>
              <Input type="number" min="0" step="0.01" value={vatAmountCZK} onChange={(e) => setVatAmountCZK(e.target.value)} placeholder="0" />
            </Field>
            {extracted?.lineItems && extracted.lineItems.length > 0 && (
              <div className="col-span-2">
                <LineItemsBreakdown
                  lineItems={extracted.lineItems}
                  currency={invoiceCurrency}
                  expanded={lineItemsExpanded}
                  onToggle={() => setLineItemsExpanded((v) => !v)}
                />
              </div>
            )}

            <div className="col-span-2">
              <Field label="Category *">
                <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="col-span-2">
              <Field label="Rooms">
                <div className="flex gap-2 flex-wrap mt-0.5">
                  {ALL_ROOMS.map((room) => (
                    <button key={room} type="button" onClick={() => toggleRoom(room)}
                      className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${rooms.includes(room) ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-200 hover:border-indigo-300'}`}>
                      {room}
                    </button>
                  ))}
                  <button type="button"
                    onClick={() => setRooms(rooms.length === ALL_ROOMS.length ? [] : [...ALL_ROOMS])}
                    className="px-3 py-1 rounded-full text-xs font-medium border border-gray-200 text-gray-500 hover:border-indigo-300">
                    {rooms.length === ALL_ROOMS.length ? 'Clear all' : 'All rooms'}
                  </button>
                </div>
              </Field>
            </div>

            <div className="col-span-2">
              <Field label="Description / Notes">
                <textarea value={description} onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional notes about this invoice" rows={2}
                  className="w-full border border-gray-200 rounded-md px-3 py-1.5 text-sm text-gray-800 focus:outline-none focus:ring-1 focus:ring-indigo-400 resize-none" />
              </Field>
            </div>
          </div>

          {/* File section */}
          {isManual && !manualFile && (
            <div
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-gray-200 rounded-xl flex flex-col items-center justify-center py-6 cursor-pointer hover:border-indigo-300 hover:bg-gray-50 transition-colors"
            >
              <svg className="w-6 h-6 text-gray-300 mb-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
              </svg>
              <p className="text-xs text-gray-400">Attach PDF or photo <span className="text-indigo-500">(optional)</span></p>
            </div>
          )}
          <input ref={fileInputRef} type="file" accept=".pdf,image/*" className="hidden" onChange={(e) => handleFileAttach(e.target.files)} />

          {activeFile && (
            <div className="bg-gray-50 rounded-lg px-4 py-3 text-xs text-gray-600 flex items-center justify-between">
              <span>
                <span className="font-medium">File:</span> {activeFile.name}
                {' · '}
                {activeFile.type === 'application/pdf'
                  ? 'Will be uploaded to Drive on save.'
                  : 'Will be converted to PDF and uploaded to Drive on save.'}
              </span>
              {isManual && (
                <button onClick={() => setManualFile(null)} className="text-gray-400 hover:text-red-500 ml-2">×</button>
              )}
            </div>
          )}
          {isEdit && existing?.driveUrl && !activeFile && (
            <div className="bg-gray-50 rounded-lg px-4 py-3 text-xs text-gray-600">
              <span className="font-medium">Drive:</span>{' '}
              <a href={existing.driveUrl} target="_blank" rel="noopener noreferrer" className="text-indigo-600 underline">
                {existing.driveFileName ?? 'View file'}
              </a>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 sticky bottom-0 bg-white">
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-1.5 text-sm text-red-600 cursor-pointer select-none" title="Save with a red 'Review needed' flag so you can filter it later">
              <input
                type="checkbox"
                checked={flagReview}
                onChange={(e) => setFlagReview(e.target.checked)}
                className="rounded border-gray-300 text-red-600 focus:ring-red-400"
              />
              ⚑ Review needed
            </label>
            <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
            {!isEdit && onSaveAndWhitelist && (
              <button
                onClick={handleSaveAndWhitelistClick}
                disabled={saving}
                title="Save this invoice and add this supplier to the whitelist for future auto-processing"
                className="px-4 py-2 text-sm font-medium text-indigo-700 border border-indigo-200 rounded-lg hover:bg-indigo-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? 'Saving…' : 'Save & Whitelist'}
              </button>
            )}
            <button onClick={() => handleSave()} disabled={saving}
              className="px-5 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed">
              {driveUploading ? 'Uploading to Drive…' : saving ? 'Saving…' : activeFile ? `Save & Push to Drive${queueRemaining > 0 ? ` (${queueRemaining} next)` : ''}` : 'Save'}
            </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

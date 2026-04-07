'use client';
import { useState, useEffect, useRef } from 'react';
import type {
  SupplierInvoice,
  SupplierInvoiceSource,
  ExtractedInvoiceData,
} from '@/types/supplierInvoice';
import { useCategories } from './useCategories';

const ALL_ROOMS = ['K.201', 'K.202', 'K.203'];

interface Props {
  extracted?: ExtractedInvoiceData | null;
  file?: File | null;
  existing?: SupplierInvoice | null;
  sourceType: SupplierInvoiceSource;
  gmailMessageId?: string;
  extractionFailed?: boolean;
  onSave: (inv: SupplierInvoice) => void;
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

export default function InvoiceReviewDrawer({
  extracted,
  file: fileProp,
  existing,
  sourceType,
  gmailMessageId,
  extractionFailed = false,
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
  const [amountCZK, setAmountCZK] = useState('');
  const [vatAmountCZK, setVatAmountCZK] = useState('');
  const [category, setCategory] = useState('other');
  const [rooms, setRooms] = useState<string[]>([]);
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [driveUploading, setDriveUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setAmountCZK(String(existing.amountCZK));
      setVatAmountCZK(existing.vatAmountCZK != null ? String(existing.vatAmountCZK) : '');
      setCategory(existing.category);
      setRooms(existing.rooms ?? []);
      setDescription(existing.description ?? '');
    } else if (extracted) {
      if (extracted.supplierName) setSupplierName(extracted.supplierName);
      if (extracted.supplierICO) setSupplierICO(extracted.supplierICO);
      if (extracted.invoiceNumber) setInvoiceNumber(extracted.invoiceNumber);
      if (extracted.invoiceDate) setInvoiceDate(extracted.invoiceDate);
      if (extracted.dueDate) setDueDate(extracted.dueDate);
      if (extracted.amountCZK != null) setAmountCZK(String(extracted.amountCZK));
      if (extracted.vatAmountCZK != null) setVatAmountCZK(String(extracted.vatAmountCZK));
      if (extracted.suggestedCategory) setCategory(extracted.suggestedCategory);
    }
  }, [extracted, existing]);

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
    return true;
  }

  async function buildInvoice(): Promise<SupplierInvoice> {
    const amount = parseFloat(amountCZK);

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
      amountCZK: amount,
      vatAmountCZK: vatAmountCZK ? parseFloat(vatAmountCZK) : undefined,
      category,
      rooms: rooms.length > 0 ? rooms : undefined,
      description: description.trim() || undefined,
      status: existing?.status ?? 'pending',
      sourceType,
      driveFileId: driveFileId ?? existing?.driveFileId,
      driveFileName: driveFileName ?? existing?.driveFileName,
      driveUrl: driveUrl ?? existing?.driveUrl,
      gmailMessageId: gmailMessageId ?? existing?.gmailMessageId,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
  }

  async function handleSave() {
    if (!validate()) return;
    setSaving(true);
    setError(null);
    const invoice = await buildInvoice();
    onSave(invoice);
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
            <Field label="Total Amount (CZK) *">
              <Input type="number" min="0" step="0.01" value={amountCZK} onChange={(e) => setAmountCZK(e.target.value)} placeholder="1500" />
            </Field>
            <Field label="VAT Amount (CZK)">
              <Input type="number" min="0" step="0.01" value={vatAmountCZK} onChange={(e) => setVatAmountCZK(e.target.value)} placeholder="0" />
            </Field>

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
          <div className="flex justify-end gap-2">
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
            <button onClick={handleSave} disabled={saving}
              className="px-5 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed">
              {driveUploading ? 'Uploading to Drive…' : saving ? 'Saving…' : activeFile ? `Save & Push to Drive${queueRemaining > 0 ? ` (${queueRemaining} next)` : ''}` : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

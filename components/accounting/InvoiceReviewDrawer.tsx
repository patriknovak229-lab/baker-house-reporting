'use client';
import { useState, useEffect } from 'react';
import type {
  SupplierInvoice,
  SupplierInvoiceCategory,
  SupplierInvoiceSource,
  ExtractedInvoiceData,
} from '@/types/supplierInvoice';

const CATEGORIES: { value: SupplierInvoiceCategory; label: string }[] = [
  { value: 'cleaning', label: 'Cleaning' },
  { value: 'laundry', label: 'Laundry' },
  { value: 'consumables', label: 'Consumables' },
  { value: 'utilities', label: 'Utilities' },
  { value: 'software', label: 'Software' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'other', label: 'Other' },
];

const ALL_ROOMS = ['K.201', 'K.202', 'K.203'];

interface Props {
  /** If provided, pre-fills form from extracted data */
  extracted?: ExtractedInvoiceData | null;
  /** The raw file to push to Drive (null for manual entry or edit-only) */
  file?: File | null;
  /** If editing an existing invoice */
  existing?: SupplierInvoice | null;
  sourceType: SupplierInvoiceSource;
  gmailMessageId?: string;
  onSave: (inv: SupplierInvoice) => void;
  onClose: () => void;
  /** How many more invoices are waiting in the queue after this one */
  queueRemaining?: number;
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
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
  file,
  existing,
  sourceType,
  gmailMessageId,
  onSave,
  onClose,
  queueRemaining = 0,
}: Props) {
  const [supplierName, setSupplierName] = useState('');
  const [supplierICO, setSupplierICO] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [amountCZK, setAmountCZK] = useState('');
  const [vatAmountCZK, setVatAmountCZK] = useState('');
  const [category, setCategory] = useState<SupplierInvoiceCategory>('other');
  const [rooms, setRooms] = useState<string[]>([]);
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [driveUploading, setDriveUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-fill from extracted data or existing invoice
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

  function toggleRoom(room: string) {
    setRooms((prev) =>
      prev.includes(room) ? prev.filter((r) => r !== room) : [...prev, room]
    );
  }

  async function handleSave() {
    if (!supplierName.trim()) { setError('Supplier name is required.'); return; }
    if (!invoiceNumber.trim()) { setError('Invoice number is required.'); return; }
    if (!invoiceDate) { setError('Invoice date is required.'); return; }
    const amount = parseFloat(amountCZK);
    if (isNaN(amount) || amount <= 0) { setError('Amount must be a positive number.'); return; }

    setSaving(true);
    setError(null);

    let driveFileId: string | undefined;
    let driveFileName: string | undefined;
    let driveUrl: string | undefined;

    // Upload to Drive if we have a file
    if (file) {
      setDriveUploading(true);
      try {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('supplierName', supplierName.trim());
        fd.append('invoiceNumber', invoiceNumber.trim());
        fd.append('amountCZK', String(Math.round(amount)));
        fd.append('invoiceDate', invoiceDate);
        const driveRes = await fetch('/api/supplier-invoices/drive-upload', {
          method: 'POST',
          body: fd,
        });
        if (driveRes.ok) {
          const d = await driveRes.json() as { fileId: string; fileName: string; driveUrl: string };
          driveFileId = d.fileId;
          driveFileName = d.fileName;
          driveUrl = d.driveUrl;
        }
        // Drive upload failure is non-fatal — invoice is still saved
      } catch {
        // Non-fatal
      } finally {
        setDriveUploading(false);
      }
    }

    const invoice: SupplierInvoice = {
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

    onSave(invoice);
    setSaving(false);
  }

  const isEdit = !!existing;

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
          {!isEdit && extracted && (
            <div className="bg-indigo-50 border border-indigo-100 rounded-lg px-4 py-3 text-xs text-indigo-700">
              Fields were auto-filled by Claude from the document. Please review before saving.
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-xs text-red-700">
              {error}
            </div>
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
              <Input
                type="number"
                min="0"
                step="0.01"
                value={amountCZK}
                onChange={(e) => setAmountCZK(e.target.value)}
                placeholder="1500"
              />
            </Field>

            <Field label="VAT Amount (CZK)">
              <Input
                type="number"
                min="0"
                step="0.01"
                value={vatAmountCZK}
                onChange={(e) => setVatAmountCZK(e.target.value)}
                placeholder="0"
              />
            </Field>

            <div className="col-span-2">
              <Field label="Category *">
                <Select value={category} onChange={(e) => setCategory(e.target.value as SupplierInvoiceCategory)}>
                  {CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="col-span-2">
              <Field label="Rooms">
                <div className="flex gap-2 flex-wrap mt-0.5">
                  {ALL_ROOMS.map((room) => (
                    <button
                      key={room}
                      type="button"
                      onClick={() => toggleRoom(room)}
                      className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                        rooms.includes(room)
                          ? 'bg-indigo-600 text-white border-indigo-600'
                          : 'bg-white text-gray-600 border-gray-200 hover:border-indigo-300'
                      }`}
                    >
                      {room}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setRooms(rooms.length === ALL_ROOMS.length ? [] : [...ALL_ROOMS])}
                    className="px-3 py-1 rounded-full text-xs font-medium border border-gray-200 text-gray-500 hover:border-indigo-300"
                  >
                    {rooms.length === ALL_ROOMS.length ? 'Clear all' : 'All rooms'}
                  </button>
                </div>
              </Field>
            </div>

            <div className="col-span-2">
              <Field label="Description / Notes">
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional notes about this invoice"
                  rows={2}
                  className="w-full border border-gray-200 rounded-md px-3 py-1.5 text-sm text-gray-800 focus:outline-none focus:ring-1 focus:ring-indigo-400 resize-none"
                />
              </Field>
            </div>
          </div>

          {/* Drive status */}
          {file && (
            <div className="bg-gray-50 rounded-lg px-4 py-3 text-xs text-gray-600">
              <span className="font-medium">File:</span> {file.name}
              {' · '}Will be uploaded to Google Drive on save.
            </div>
          )}
          {isEdit && existing?.driveUrl && (
            <div className="bg-gray-50 rounded-lg px-4 py-3 text-xs text-gray-600">
              <span className="font-medium">Drive:</span>{' '}
              <a href={existing.driveUrl} target="_blank" rel="noopener noreferrer" className="text-indigo-600 underline">
                {existing.driveFileName ?? 'View file'}
              </a>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3 sticky bottom-0 bg-white">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {driveUploading ? 'Uploading to Drive…' : saving ? 'Saving…' : file ? `Save & Push to Drive${queueRemaining > 0 ? ` (${queueRemaining} next)` : ''}` : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

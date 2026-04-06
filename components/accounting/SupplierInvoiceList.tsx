'use client';
import { useRef, useState } from 'react';
import type { SupplierInvoice, SupplierInvoiceStatus } from '@/types/supplierInvoice';
import { formatCurrency } from '@/utils/formatters';

function StatusBadge({ status }: { status: SupplierInvoiceStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
        status === 'reconciled'
          ? 'bg-green-50 text-green-700'
          : 'bg-amber-50 text-amber-700'
      }`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          status === 'reconciled' ? 'bg-green-500' : 'bg-amber-400'
        }`}
      />
      {status === 'reconciled' ? 'Reconciled' : 'Pending'}
    </span>
  );
}

function SourceIcon({ source }: { source: SupplierInvoice['sourceType'] }) {
  const icons = { email: '✉', upload: '↑', manual: '✎' };
  const labels = { email: 'Gmail', upload: 'Upload', manual: 'Manual' };
  return (
    <span
      title={labels[source]}
      className="text-xs text-gray-400"
    >
      {icons[source]}
    </span>
  );
}

interface Filters {
  status: 'all' | SupplierInvoiceStatus;
  category: string;
  search: string;
  dateFrom: string;
  dateTo: string;
}

interface Props {
  invoices: SupplierInvoice[];
  filters: Filters;
  onEdit: (inv: SupplierInvoice) => void;
  onDelete: (id: string) => void;
  onReuploadDrive?: (inv: SupplierInvoice, file: File) => void;
}

export default function SupplierInvoiceList({ invoices, filters, onEdit, onDelete, onReuploadDrive }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingReupload, setPendingReupload] = useState<SupplierInvoice | null>(null);
  const [uploadingId, setUploadingId] = useState<string | null>(null);

  function triggerReupload(inv: SupplierInvoice) {
    setPendingReupload(inv);
    fileInputRef.current?.click();
  }

  async function handleReuploadFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !pendingReupload || !onReuploadDrive) return;
    setUploadingId(pendingReupload.id);
    try {
      await onReuploadDrive(pendingReupload, file);
    } finally {
      setUploadingId(null);
      setPendingReupload(null);
    }
  }
  const filtered = invoices.filter((inv) => {
    if (filters.status !== 'all' && inv.status !== filters.status) return false;
    if (filters.category !== 'all' && inv.category !== filters.category) return false;
    if (filters.dateFrom && inv.invoiceDate < filters.dateFrom) return false;
    if (filters.dateTo && inv.invoiceDate > filters.dateTo) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      if (
        !inv.supplierName.toLowerCase().includes(q) &&
        !inv.invoiceNumber.toLowerCase().includes(q) &&
        !(inv.description ?? '').toLowerCase().includes(q)
      ) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-gray-400">
        <p className="text-sm">No invoices match the current filters.</p>
      </div>
    );
  }

  const total = filtered.reduce((s, inv) => s + inv.amountCZK, 0);

  return (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,image/*"
        className="hidden"
        onChange={handleReuploadFileChange}
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Date</th>
              <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Supplier</th>
              <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Invoice #</th>
              <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Category</th>
              <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Rooms</th>
              <th className="text-right py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Amount</th>
              <th className="text-center py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
              <th className="text-center py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Drive</th>
              <th className="text-center py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Src</th>
              <th className="py-2 px-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {filtered.map((inv) => (
              <tr key={inv.id} className="hover:bg-gray-50 group">
                <td className="py-2.5 px-3 text-gray-700 whitespace-nowrap">
                  {inv.invoiceDate}
                  {inv.dueDate && (
                    <div className="text-xs text-gray-400">due {inv.dueDate}</div>
                  )}
                </td>
                <td className="py-2.5 px-3">
                  <div className="font-medium text-gray-800">{inv.supplierName}</div>
                  {inv.supplierICO && (
                    <div className="text-xs text-gray-400">IČO {inv.supplierICO}</div>
                  )}
                </td>
                <td className="py-2.5 px-3 text-gray-600 font-mono text-xs">{inv.invoiceNumber}</td>
                <td className="py-2.5 px-3">
                  <span className="inline-block text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 capitalize">
                    {inv.category}
                  </span>
                </td>
                <td className="py-2.5 px-3 text-xs text-gray-500">
                  {inv.rooms && inv.rooms.length > 0 ? inv.rooms.join(', ') : '—'}
                </td>
                <td className="py-2.5 px-3 text-right font-medium text-gray-800 whitespace-nowrap">
                  {formatCurrency(inv.amountCZK)}
                  {inv.vatAmountCZK != null && (
                    <div className="text-xs text-gray-400">VAT {formatCurrency(inv.vatAmountCZK)}</div>
                  )}
                </td>
                <td className="py-2.5 px-3 text-center">
                  <StatusBadge status={inv.status} />
                </td>
                <td className="py-2.5 px-3 text-center">
                  {inv.driveUrl ? (
                    <a
                      href={inv.driveUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-indigo-600 hover:text-indigo-800 text-xs font-medium"
                      title={inv.driveFileName}
                    >
                      View
                    </a>
                  ) : uploadingId === inv.id ? (
                    <span className="text-xs text-gray-400 animate-pulse">Uploading…</span>
                  ) : onReuploadDrive ? (
                    <button
                      onClick={() => triggerReupload(inv)}
                      title="Upload file to Drive"
                      className="text-xs text-amber-500 hover:text-indigo-600 font-medium"
                    >
                      ↑ Upload
                    </button>
                  ) : (
                    <span className="text-gray-300 text-xs">—</span>
                  )}
                </td>
                <td className="py-2.5 px-3 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <SourceIcon source={inv.sourceType} />
                    {inv.autoProcessed && (
                      <span
                        title="Auto-processed via whitelist"
                        className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-indigo-100 text-indigo-600 text-[9px] font-bold"
                      >
                        A
                      </span>
                    )}
                  </div>
                </td>
                <td className="py-2.5 px-3 text-right">
                  <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => onEdit(inv)}
                      className="text-xs text-gray-500 hover:text-indigo-600"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => onDelete(inv.id)}
                      className="text-xs text-gray-400 hover:text-red-500"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-gray-200 bg-gray-50">
              <td colSpan={5} className="py-2.5 px-3 text-xs text-gray-500 font-medium">
                {filtered.length} invoice{filtered.length !== 1 ? 's' : ''}
              </td>
              <td className="py-2.5 px-3 text-right font-semibold text-gray-800">
                {formatCurrency(total)}
              </td>
              <td colSpan={4} />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

'use client';
import { useRef, useState } from 'react';
import type { SupplierInvoice, SupplierInvoiceStatus } from '@/types/supplierInvoice';
import { formatCurrency } from '@/utils/formatters';
import { useCategories } from './useCategories';
import { textColorFor } from '@/utils/categoryColors';

// ── Source icons ──────────────────────────────────────────────────────────────
function SourceIcon({ source }: { source: SupplierInvoice['sourceType'] }) {
  if (source === 'email') {
    return (
      <span title="Gmail" className="text-gray-400">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round"
            d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0-9.75 6.75L2.25 6.75" />
        </svg>
      </span>
    );
  }
  if (source === 'upload') {
    return (
      <span title="Photo upload" className="text-gray-400">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round"
            d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
          <path strokeLinecap="round" strokeLinejoin="round"
            d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zM18.75 10.5h.008v.008h-.008V10.5z" />
        </svg>
      </span>
    );
  }
  if (source === 'portal') {
    return (
      <span title="Portal download" className="text-gray-400">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round"
            d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
        </svg>
      </span>
    );
  }
  // manual
  return (
    <span title="Manual entry" className="text-gray-400">
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
      </svg>
    </span>
  );
}

function StatusBadge({ status }: { status: SupplierInvoiceStatus }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
      status === 'reconciled' ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${status === 'reconciled' ? 'bg-green-500' : 'bg-amber-400'}`} />
      {status === 'reconciled' ? 'Reconciled' : 'Pending'}
    </span>
  );
}

type SortCol = 'invoiceDate' | 'dueDate';

interface Props {
  invoices: SupplierInvoice[]; // already filtered by parent
  onEdit: (inv: SupplierInvoice) => void;
  onDelete: (id: string) => void;
  onReuploadDrive?: (inv: SupplierInvoice, file: File) => void;
}

export default function SupplierInvoiceList({ invoices, onEdit, onDelete, onReuploadDrive }: Props) {
  const { categories } = useCategories();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingReupload, setPendingReupload] = useState<SupplierInvoice | null>(null);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [sortCol, setSortCol] = useState<SortCol>('invoiceDate');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  function toggleSort(col: SortCol) {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir('desc');
    }
  }

  function triggerReupload(inv: SupplierInvoice) {
    setPendingReupload(inv);
    fileInputRef.current?.click();
  }

  async function handleReuploadFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !pendingReupload || !onReuploadDrive) return;
    setUploadingId(pendingReupload.id);
    try { await onReuploadDrive(pendingReupload, file); }
    finally { setUploadingId(null); setPendingReupload(null); }
  }

  const sorted = [...invoices].sort((a, b) => {
    const av = sortCol === 'dueDate' ? (a.dueDate ?? '') : a.invoiceDate;
    const bv = sortCol === 'dueDate' ? (b.dueDate ?? '') : b.invoiceDate;
    // Empty due dates sink to bottom regardless of direction
    if (sortCol === 'dueDate') {
      if (!av && !bv) return 0;
      if (!av) return 1;
      if (!bv) return -1;
    }
    return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
  });

  const SortArrow = ({ col }: { col: SortCol }) => (
    <span className="ml-0.5 text-[10px] opacity-60">
      {sortCol === col ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
    </span>
  );

  if (sorted.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-gray-400">
        <p className="text-sm">No invoices match the current filters.</p>
      </div>
    );
  }

  const total = sorted.reduce((s, inv) => s + inv.amountCZK, 0);

  return (
    <div>
      <input ref={fileInputRef} type="file" accept=".pdf,image/*" className="hidden" onChange={handleReuploadFileChange} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <button onClick={() => toggleSort('invoiceDate')} className="flex items-center hover:text-gray-800">
                  Date <SortArrow col="invoiceDate" />
                </button>
              </th>
              <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <button onClick={() => toggleSort('dueDate')} className="flex items-center hover:text-gray-800">
                  Due <SortArrow col="dueDate" />
                </button>
              </th>
              <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Supplier</th>
              <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Invoice #</th>
              <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Category</th>
              <th className="text-right py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Amount</th>
              <th className="text-center py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
              <th className="text-center py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Drive</th>
              <th className="text-center py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Src</th>
              <th className="py-2 px-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {sorted.map((inv) => (
              <tr
                key={inv.id}
                className="hover:bg-gray-50 group cursor-pointer"
                onClick={() => onEdit(inv)}
              >
                <td className="py-2.5 px-3 text-gray-700 whitespace-nowrap">{inv.invoiceDate}</td>
                <td className="py-2.5 px-3 text-gray-500 whitespace-nowrap text-xs">
                  {inv.dueDate ?? <span className="text-gray-300">—</span>}
                </td>
                <td className="py-2.5 px-3">
                  <div className="font-medium text-gray-800">{inv.supplierName}</div>
                  {inv.supplierICO && <div className="text-xs text-gray-400">IČO {inv.supplierICO}</div>}
                </td>
                <td className="py-2.5 px-3 text-gray-600 font-mono text-xs">{inv.invoiceNumber}</td>
                <td className="py-2.5 px-3">
                  {(() => {
                    const cat = categories.find((c) => c.id === inv.category);
                    const bg = cat?.color ?? '#F3F4F6';
                    return (
                      <span
                        className="inline-block text-xs font-medium px-2 py-0.5 rounded-full capitalize"
                        style={{ backgroundColor: bg, color: textColorFor(bg) }}
                      >
                        {cat?.label ?? inv.category}
                      </span>
                    );
                  })()}
                </td>
                <td className="py-2.5 px-3 text-right font-medium text-gray-800 whitespace-nowrap">
                  {formatCurrency(inv.amountCZK)}
                </td>
                <td className="py-2.5 px-3 text-center">
                  <StatusBadge status={inv.status} />
                </td>
                <td className="py-2.5 px-3 text-center" onClick={(e) => e.stopPropagation()}>
                  {inv.driveUrl ? (
                    <a href={inv.driveUrl} target="_blank" rel="noopener noreferrer"
                      className="text-indigo-600 hover:text-indigo-800 text-xs font-medium" title={inv.driveFileName}>
                      View
                    </a>
                  ) : uploadingId === inv.id ? (
                    <span className="text-xs text-gray-400 animate-pulse">Uploading…</span>
                  ) : onReuploadDrive ? (
                    <button onClick={() => triggerReupload(inv)}
                      title="Upload file to Drive"
                      className="text-xs text-amber-500 hover:text-indigo-600 font-medium">
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
                      <span title="Auto-processed via whitelist"
                        className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-indigo-100 text-indigo-600 text-[9px] font-bold">
                        A
                      </span>
                    )}
                  </div>
                </td>
                <td className="py-2.5 px-3 text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => onEdit(inv)} className="text-xs text-gray-500 hover:text-indigo-600">Edit</button>
                    <button onClick={() => onDelete(inv.id)} className="text-xs text-gray-400 hover:text-red-500">Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-gray-200 bg-gray-50">
              <td colSpan={5} className="py-2.5 px-3 text-xs text-gray-500 font-medium">
                {sorted.length} invoice{sorted.length !== 1 ? 's' : ''}
              </td>
              <td className="py-2.5 px-3 text-right font-semibold text-gray-800">{formatCurrency(total)}</td>
              <td colSpan={4} />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

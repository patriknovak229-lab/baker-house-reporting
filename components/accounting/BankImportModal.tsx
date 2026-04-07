'use client';
import { useState, useRef } from 'react';
import type { BankTransaction } from '@/types/bankTransaction';

interface ImportResult {
  imported: number;
  duplicates: number;
  autoReconciled: number;
  transactions: BankTransaction[];
}

interface Props {
  onImported: (result: ImportResult) => void;
  onClose: () => void;
}

export default function BankImportModal({ onImported, onClose }: Props) {
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFile(f: File) {
    if (!f.name.toLowerCase().endsWith('.csv')) {
      setError('Please select a .csv file exported from MojeBanka Business.');
      return;
    }
    setError(null);
    setFile(f);
  }

  async function handleImport() {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/bank-transactions/import', { method: 'POST', body: fd });
      const data = await res.json() as ImportResult & { error?: string; preview?: string };
      if (!res.ok) {
        const msg = data.error ?? 'Import failed';
        const detail = data.preview ? `\n\nFile preview:\n${data.preview}` : '';
        throw new Error(msg + detail);
      }
      onImported(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4">

        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-800">Import Bank Statement</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <p className="text-xs text-gray-500">
            Export from <strong>MojeBanka Business</strong> → Výpisy → CSV format (semicolon-delimited).
            Re-importing overlapping periods is safe — duplicates are skipped automatically.
          </p>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-xs text-red-700 whitespace-pre-wrap font-mono break-all max-h-40 overflow-y-auto">
              {error}
            </div>
          )}

          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl flex flex-col items-center justify-center py-10 cursor-pointer transition-colors ${
              dragging ? 'border-indigo-400 bg-indigo-50' : 'border-gray-200 hover:border-indigo-300 hover:bg-gray-50'
            }`}
          >
            <svg className="w-8 h-8 text-gray-300 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            {file ? (
              <p className="text-sm font-medium text-indigo-700">{file.name}</p>
            ) : (
              <>
                <p className="text-sm font-medium text-gray-700">Drop CSV here</p>
                <p className="text-xs text-gray-400 mt-1">or click to browse</p>
              </>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
          />
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
          <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
          <button
            onClick={handleImport}
            disabled={!file || loading}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2"
          >
            {loading && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            {loading ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}

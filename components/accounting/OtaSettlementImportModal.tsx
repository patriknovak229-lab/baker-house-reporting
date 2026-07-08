'use client';
import { useState, useRef } from 'react';

interface Props {
  /** Called with the selected report files to process sequentially */
  onProcessBatch: (files: File[]) => void;
  onClose: () => void;
}

/**
 * Multi-file upload modal for OTA earnings/settlement reports (Airbnb, …).
 * Mirrors the costs-tab Upload flow: drop or browse multiple PDFs, then process
 * them one by one (extract → review → create settlement).
 */
export default function OtaSettlementImportModal({ onProcessBatch, onClose }: Props) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const valid = Array.from(list).filter((f) => {
      if (f.type === 'application/pdf' || f.type.startsWith('image/')) return true;
      const ext = f.name.split('.').pop()?.toLowerCase();
      return ext === 'heic' || ext === 'heif';
    });
    if (valid.length === 0) { setError('Only PDF or image files are supported.'); return; }
    setError(null);
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.name));
      return [...prev, ...valid.filter((f) => !existing.has(f.name))];
    });
  }

  function removeFile(name: string) {
    setFiles((prev) => prev.filter((f) => f.name !== name));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 flex flex-col max-h-[90vh] overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <h2 className="text-base font-semibold text-gray-800">Import OTA settlement report</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-3">
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-xs text-red-700">{error}</div>
          )}

          <p className="text-xs text-gray-500">
            Upload monthly settlement reports — Airbnb “Earnings report” or Booking.com “Výkaz plateb”.
            Gross booking volume and channel fees are extracted, creating a revenue record and a cost
            record that net to the bank payout.
          </p>

          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl flex flex-col items-center justify-center py-10 cursor-pointer transition-colors ${
              dragging ? 'border-indigo-400 bg-indigo-50' : 'border-gray-200 hover:border-indigo-300 hover:bg-gray-50'
            }`}
          >
            <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-3">
              <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>
            <p className="text-sm font-medium text-gray-700">Drop earnings reports here</p>
            <p className="text-xs text-gray-400 mt-1">or click to browse · multiple files supported</p>
            <p className="text-xs text-gray-400">PDF, JPG, PNG</p>
          </div>

          <input ref={fileInputRef} type="file" accept=".pdf,image/*,.heic,.heif" multiple className="hidden" onChange={(e) => handleFiles(e.target.files)} />

          {files.length > 0 && (
            <div className="space-y-1.5">
              {files.map((f) => (
                <div key={f.name} className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm text-gray-800 truncate">{f.name}</p>
                    <p className="text-xs text-gray-400">{Math.round(f.size / 1024)} KB</p>
                  </div>
                  <button onClick={() => removeFile(f.name)} className="text-gray-300 hover:text-red-500 ml-2 flex-shrink-0">×</button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-end gap-3 flex-shrink-0">
          <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
          {files.length > 0 && (
            <button
              onClick={() => onProcessBatch(files)}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700"
            >
              Process {files.length} report{files.length !== 1 ? 's' : ''}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

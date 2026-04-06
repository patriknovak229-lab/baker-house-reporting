'use client';
import { useState, useRef } from 'react';

interface GmailAttachment {
  messageId: string;
  subject: string;
  from: string;
  date: string;
  attachmentName: string;
  attachmentSize: number;
  data: string; // base64url
}

interface Props {
  onProcessBatch: (
    items: Array<{ file: File; gmailMessageId?: string }>
  ) => void;
  onFileSelected: (file: File) => void;
  onManual: () => void;
  onClose: () => void;
}

type ActiveTab = 'upload' | 'gmail';

function base64UrlToFile(data: string, name: string): File {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type: 'application/pdf' });
}

export default function InvoiceImportModal({ onProcessBatch, onFileSelected, onManual, onClose }: Props) {
  const [tab, setTab] = useState<ActiveTab>('upload');
  const [dragging, setDragging] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gmailAttachments, setGmailAttachments] = useState<GmailAttachment[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const valid = Array.from(files).filter(
      (f) => f.type === 'application/pdf' || f.type.startsWith('image/')
    );
    if (valid.length === 0) {
      setError('Only PDF or image files are supported.');
      return;
    }
    setError(null);
    if (valid.length === 1) {
      // Single file — go directly to extraction drawer
      onFileSelected(valid[0]);
    } else {
      // Multiple files — show queue preview
      setUploadFiles((prev) => {
        const existingNames = new Set(prev.map((f) => f.name));
        return [...prev, ...valid.filter((f) => !existingNames.has(f.name))];
      });
    }
  }

  function removeUploadFile(name: string) {
    setUploadFiles((prev) => prev.filter((f) => f.name !== name));
  }

  function handleProcessUploadFiles() {
    onProcessBatch(uploadFiles.map((file) => ({ file })));
  }

  async function handleGmailScan() {
    setScanning(true);
    setError(null);
    setGmailAttachments([]);
    setSelected(new Set());
    try {
      const res = await fetch('/api/supplier-invoices/gmail-scan', { method: 'POST' });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error ?? 'Gmail scan failed');
      }
      const data = await res.json() as { attachments: GmailAttachment[] };
      setGmailAttachments(data.attachments);
      // Auto-select all by default
      setSelected(new Set(data.attachments.map((a) => a.messageId + a.attachmentName)));
      if (data.attachments.length === 0) {
        setError('No new invoices found in your Gmail label.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gmail scan failed.');
    } finally {
      setScanning(false);
    }
  }

  function toggleItem(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === gmailAttachments.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(gmailAttachments.map((a) => a.messageId + a.attachmentName)));
    }
  }

  function handleProcessSelected() {
    const items = gmailAttachments
      .filter((a) => selected.has(a.messageId + a.attachmentName))
      .map((a) => ({
        file: base64UrlToFile(a.data, a.attachmentName),
        gmailMessageId: a.messageId,
      }));
    onProcessBatch(items);
  }

  const allSelected = gmailAttachments.length > 0 && selected.size === gmailAttachments.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 flex flex-col max-h-[90vh] overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <h2 className="text-base font-semibold text-gray-800">Add Invoice</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100 flex-shrink-0">
          {(['upload', 'gmail'] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setError(null); setGmailAttachments([]); setSelected(new Set()); }}
              className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                tab === t ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t === 'upload' ? 'Upload File' : 'Scan Gmail'}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {error && (
            <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-xs text-red-700">
              {error}
            </div>
          )}

          {/* ── Upload tab ── */}
          {tab === 'upload' && (
            <div className="space-y-3">
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
                <p className="text-sm font-medium text-gray-700">Drop PDFs or photos here</p>
                <p className="text-xs text-gray-400 mt-1">or click to browse · multiple files supported</p>
                <p className="text-xs text-gray-400">PDF, JPG, PNG, HEIC</p>
              </div>

              {/* Multi-file queue preview */}
              {uploadFiles.length > 0 && (
                <div className="space-y-1.5">
                  {uploadFiles.map((f) => (
                    <div key={f.name} className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm text-gray-800 truncate">{f.name}</p>
                        <p className="text-xs text-gray-400">{Math.round(f.size / 1024)} KB</p>
                      </div>
                      <button onClick={() => removeUploadFile(f.name)} className="text-gray-300 hover:text-red-500 ml-2 flex-shrink-0">×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <input ref={fileInputRef} type="file" accept=".pdf,image/*,.heic,.heif" multiple className="hidden" onChange={(e) => handleFiles(e.target.files)} />

          {/* ── Gmail tab ── */}
          {tab === 'gmail' && (
            <div className="space-y-4">
              <button
                onClick={handleGmailScan}
                disabled={scanning}
                className="w-full py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {scanning ? (
                  <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Scanning…</>
                ) : 'Sync Gmail Label'}
              </button>

              {gmailAttachments.length > 0 && (
                <div className="space-y-2">
                  {/* Select all row */}
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleAll}
                        className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-400"
                      />
                      <span className="text-xs font-medium text-gray-600">
                        {selected.size} of {gmailAttachments.length} selected
                      </span>
                    </label>
                    <button onClick={toggleAll} className="text-xs text-indigo-600 hover:underline">
                      {allSelected ? 'Deselect all' : 'Select all'}
                    </button>
                  </div>

                  {/* Attachment list */}
                  <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                    {gmailAttachments.map((att) => {
                      const key = att.messageId + att.attachmentName;
                      return (
                        <label
                          key={key}
                          className={`flex items-start gap-3 border rounded-lg px-3 py-2.5 cursor-pointer transition-colors ${
                            selected.has(key)
                              ? 'border-indigo-300 bg-indigo-50'
                              : 'border-gray-200 hover:border-gray-300'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(key)}
                            onChange={() => toggleItem(key)}
                            className="mt-0.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-400 flex-shrink-0"
                          />
                          <div className="min-w-0">
                            <div className="font-medium text-sm text-gray-800 truncate">{att.attachmentName}</div>
                            <div className="text-xs text-gray-500 truncate">{att.from}</div>
                            <div className="text-xs text-gray-400">{att.date} · {Math.round(att.attachmentSize / 1024)} KB</div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between flex-shrink-0">
          <button onClick={onManual} className="text-sm text-gray-500 hover:text-indigo-600">
            Enter manually
          </button>
          <div className="flex items-center gap-3">
            <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">
              Cancel
            </button>
            {tab === 'upload' && uploadFiles.length > 0 && (
              <button
                onClick={handleProcessUploadFiles}
                className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700"
              >
                Process {uploadFiles.length} file{uploadFiles.length !== 1 ? 's' : ''}
              </button>
            )}
            {tab === 'gmail' && selected.size > 0 && (
              <button
                onClick={handleProcessSelected}
                className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700"
              >
                Process {selected.size} invoice{selected.size !== 1 ? 's' : ''}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

'use client';
import { useState, useRef } from 'react';
import type { ExtractedInvoiceData } from '@/types/supplierInvoice';

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
  onExtracted: (
    extracted: ExtractedInvoiceData,
    file: File | null,
    sourceType: 'upload' | 'email',
    gmailMessageId?: string
  ) => void;
  onManual: () => void;
  onClose: () => void;
}

type ActiveTab = 'upload' | 'gmail';

function base64UrlToFile(data: string, name: string): File {
  // Gmail uses base64url — convert to base64
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type: 'application/pdf' });
}

export default function InvoiceImportModal({ onExtracted, onManual, onClose }: Props) {
  const [tab, setTab] = useState<ActiveTab>('upload');
  const [dragging, setDragging] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gmailAttachments, setGmailAttachments] = useState<GmailAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function extractFile(file: File, sourceType: 'upload' | 'email', gmailMessageId?: string) {
    setExtracting(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/supplier-invoices/extract', { method: 'POST', body: fd });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error ?? 'Extraction failed');
      }
      const data = await res.json() as ExtractedInvoiceData;
      onExtracted(data, file, sourceType, gmailMessageId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Extraction failed. Please try again.');
    } finally {
      setExtracting(false);
    }
  }

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0];
    const ok = file.type === 'application/pdf' || file.type.startsWith('image/');
    if (!ok) { setError('Only PDF or image files are supported.'); return; }
    extractFile(file, 'upload');
  }

  async function handleGmailScan() {
    setScanning(true);
    setError(null);
    try {
      const res = await fetch('/api/supplier-invoices/gmail-scan', { method: 'POST' });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error ?? 'Gmail scan failed');
      }
      const data = await res.json() as { attachments: GmailAttachment[] };
      setGmailAttachments(data.attachments);
      if (data.attachments.length === 0) {
        setError('No new invoices found in your Gmail label.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gmail scan failed.');
    } finally {
      setScanning(false);
    }
  }

  function handleGmailSelect(att: GmailAttachment) {
    const file = base64UrlToFile(att.data, att.attachmentName);
    extractFile(file, 'email', att.messageId);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 flex flex-col max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-800">Add Invoice</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100">
          {(['upload', 'gmail'] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setError(null); setGmailAttachments([]); }}
              className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                tab === t
                  ? 'text-indigo-600 border-b-2 border-indigo-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t === 'upload' ? 'Upload File' : 'Scan Gmail'}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {error && (
            <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-xs text-red-700">
              {error}
            </div>
          )}

          {tab === 'upload' && (
            <div className="space-y-4">
              {/* Drop zone */}
              <div
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  handleFiles(e.dataTransfer.files);
                }}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl flex flex-col items-center justify-center py-10 cursor-pointer transition-colors ${
                  dragging ? 'border-indigo-400 bg-indigo-50' : 'border-gray-200 hover:border-indigo-300 hover:bg-gray-50'
                }`}
              >
                {extracting ? (
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-7 h-7 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                    <p className="text-sm text-gray-500">Extracting with Claude…</p>
                  </div>
                ) : (
                  <>
                    <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-3">
                      <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                      </svg>
                    </div>
                    <p className="text-sm font-medium text-gray-700">Drop PDF or image here</p>
                    <p className="text-xs text-gray-400 mt-1">or click to browse</p>
                    <p className="text-xs text-gray-400">Supports: PDF, JPG, PNG, HEIC</p>
                  </>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,image/*"
                className="hidden"
                onChange={(e) => handleFiles(e.target.files)}
              />
            </div>
          )}

          {tab === 'gmail' && (
            <div className="space-y-4">
              <p className="text-sm text-gray-600">
                Scans your Gmail label <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs font-mono">{process.env.NEXT_PUBLIC_GMAIL_LABEL ?? 'baker-invoices'}</code> for new PDFs not yet imported.
              </p>
              <button
                onClick={handleGmailScan}
                disabled={scanning}
                className="w-full py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {scanning ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Scanning…
                  </>
                ) : 'Sync Gmail Label'}
              </button>

              {gmailAttachments.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-gray-500 font-medium">{gmailAttachments.length} new attachment{gmailAttachments.length !== 1 ? 's' : ''} found:</p>
                  {gmailAttachments.map((att) => (
                    <button
                      key={att.messageId + att.attachmentName}
                      onClick={() => handleGmailSelect(att)}
                      disabled={extracting}
                      className="w-full text-left border border-gray-200 rounded-lg px-4 py-3 hover:border-indigo-300 hover:bg-indigo-50 transition-colors disabled:opacity-50"
                    >
                      <div className="font-medium text-sm text-gray-800 truncate">{att.attachmentName}</div>
                      <div className="text-xs text-gray-500 mt-0.5 truncate">{att.from}</div>
                      <div className="text-xs text-gray-400">{att.date} · {Math.round(att.attachmentSize / 1024)} KB</div>
                    </button>
                  ))}
                  {extracting && (
                    <div className="flex items-center gap-2 text-sm text-gray-500 py-1">
                      <div className="w-4 h-4 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                      Extracting with Claude…
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between">
          <button
            onClick={onManual}
            className="text-sm text-gray-500 hover:text-indigo-600"
          >
            Enter manually
          </button>
          <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700 px-3 py-1.5">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

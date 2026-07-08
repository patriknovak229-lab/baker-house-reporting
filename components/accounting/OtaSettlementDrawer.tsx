'use client';
import { useState, useMemo } from 'react';
import type { SettlementGroup, SettlementSource } from '@/types/settlementGroup';
import type { BankTransaction } from '@/types/bankTransaction';
import type { ExtractedSettlementData } from '@/app/api/revenue-invoices/extract-settlement/route';
import { formatCurrency, formatDate } from '@/utils/formatters';

interface Props {
  /** create mode: freshly extracted report, not yet saved */
  extracted?: ExtractedSettlementData | null;
  file?: File | null;
  /** view mode: an existing settlement */
  group?: SettlementGroup | null;
  transactions: BankTransaction[];
  /** number of reports still queued after this one (batch flow) */
  queueRemaining?: number;
  onClose: () => void;
  /** called after a settlement is created or mutated (null = deleted) */
  onGroupUpdate: (group: SettlementGroup | null) => void;
  onTxUpdate: (tx: BankTransaction) => void;
}

const SOURCE_OPTIONS: { value: SettlementSource; label: string }[] = [
  { value: 'airbnb',  label: 'Airbnb' },
  { value: 'booking', label: 'Booking.com' },
  { value: 'other',   label: 'Other' },
];

/** "2026-05-01" → "May 2026" (falls back to the raw string) */
function monthLabel(date?: string | null): string {
  if (!date) return '';
  const d = new Date(date + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function defaultName(source: SettlementSource | null, periodStart?: string | null): string {
  const src = SOURCE_OPTIONS.find((o) => o.value === source)?.label ?? 'OTA';
  const month = monthLabel(periodStart);
  return month ? `${src} ${month}` : src;
}

export default function OtaSettlementDrawer({
  extracted, file, group, transactions, queueRemaining = 0, onClose, onGroupUpdate, onTxUpdate,
}: Props) {
  // The settlement currently shown — either the passed-in group, or one we just created.
  const [current, setCurrent] = useState<SettlementGroup | null>(group ?? null);

  // ── Create-mode form state ────────────────────────────────────────────────
  const initialSource = extracted?.source ?? 'airbnb';
  const [form, setForm] = useState({
    source:      initialSource as SettlementSource,
    name:        defaultName(extracted?.source ?? 'airbnb', extracted?.periodStart),
    periodStart: extracted?.periodStart ?? '',
    periodEnd:   extracted?.periodEnd ?? '',
    gross:       extracted?.grossAmount != null ? String(extracted.grossAmount) : '',
    commission:  extracted?.commissionAmount != null ? String(extracted.commissionAmount) : '',
    net:         extracted?.netAmount != null ? String(extracted.netAmount) : '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [txSearch, setTxSearch] = useState('');
  const [busyTx, setBusyTx] = useState<string | null>(null);

  function setField(field: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
    setError('');
  }

  const grossNum = parseFloat(form.gross) || 0;
  const commNum  = parseFloat(form.commission) || 0;
  const netNum   = form.net !== '' ? (parseFloat(form.net) || 0) : grossNum - commNum;

  async function handleCreate() {
    if (!form.name.trim())    { setError('Name is required'); return; }
    if (!form.periodStart)    { setError('Period start is required (the month the report covers)'); return; }
    if (grossNum <= 0)        { setError('Gross earnings must be a positive number'); return; }

    setSaving(true);
    setError('');
    try {
      // 1. Upload the report to Drive (best-effort — settlement is created regardless)
      let reportFileId: string | undefined;
      let reportFileName: string | undefined;
      let reportUrl: string | undefined;
      if (file) {
        try {
          const fd = new FormData();
          fd.append('file', file);
          fd.append('clientName', form.name.trim());
          fd.append('invoiceNumber', `${form.source}-${form.periodStart}`);
          fd.append('amountCZK', String(Math.round(netNum)));
          fd.append('invoiceDate', form.periodStart);
          const driveRes = await fetch('/api/revenue-invoices/drive-upload', { method: 'POST', body: fd });
          if (driveRes.ok) {
            const d = await driveRes.json() as { fileId?: string; fileName?: string; driveUrl?: string };
            reportFileId = d.fileId; reportFileName = d.fileName; reportUrl = d.driveUrl;
          }
        } catch { /* non-fatal */ }
      }

      // 2. Create the settlement (report-first — no transactions yet)
      const res = await fetch('/api/settlement-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:             form.name.trim(),
          source:           form.source,
          periodStart:      form.periodStart,
          periodEnd:        form.periodEnd || form.periodStart,
          grossAmount:      grossNum,
          commissionAmount: commNum,
          netAmount:        netNum,
          adjustmentsAmount: extracted?.adjustmentsAmount ?? undefined,
          taxWithheld:       extracted?.taxWithheld ?? undefined,
          reportFileId, reportFileName, reportUrl,
        }),
      });
      if (!res.ok) { setError('Failed to save settlement — please try again'); return; }
      const data = await res.json() as { group: SettlementGroup };
      setCurrent(data.group);
      onGroupUpdate(data.group);
    } finally {
      setSaving(false);
    }
  }

  // ── Bank-credit linking (view mode) ────────────────────────────────────────
  const linkedTxs = useMemo(
    () => (current ? transactions.filter((t) => current.transactionIds.includes(t.id)) : []),
    [transactions, current],
  );
  const linkedSum = linkedTxs.reduce((s, t) => s + t.amount, 0);

  const candidateTxs = useMemo(() => {
    if (!current) return [];
    const q = txSearch.toLowerCase();
    return transactions
      .filter((t) => t.direction === 'credit' && t.state === 'revenue')
      .filter((t) => !q || (t.counterpartyName ?? '').toLowerCase().includes(q) || formatDate(t.date).includes(txSearch) || String(t.amount).includes(txSearch))
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [transactions, current, txSearch]);

  async function putGroup(body: object) {
    if (!current) return null;
    const res = await fetch(`/api/settlement-groups/${current.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return res.json() as Promise<{ group: SettlementGroup | null; deleted: boolean }>;
  }

  async function handleAddTx(txId: string) {
    setBusyTx(txId);
    try {
      const data = await putGroup({ action: 'add_transaction', transactionId: txId });
      if (data?.group) {
        setCurrent(data.group);
        onGroupUpdate(data.group);
        const tx = transactions.find((t) => t.id === txId);
        if (tx) onTxUpdate({ ...tx, state: 'grouped', settlementGroupId: data.group.id });
      }
    } finally { setBusyTx(null); }
  }

  async function handleRemoveTx(txId: string) {
    setBusyTx(txId);
    try {
      const data = await putGroup({ action: 'remove_transaction', transactionId: txId });
      const tx = transactions.find((t) => t.id === txId);
      if (tx) onTxUpdate({ ...tx, state: 'revenue', settlementGroupId: undefined });
      // Report settlements are never auto-deleted, so group is returned
      if (data?.group) { setCurrent(data.group); onGroupUpdate(data.group); }
    } finally { setBusyTx(null); }
  }

  async function handleDelete() {
    if (!current) return;
    if (!confirm(`Delete settlement "${current.name}"? This resets its ${current.transactionIds.length} linked payout(s) back to revenue.`)) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/settlement-groups/${current.id}`, { method: 'DELETE' });
      if (res.ok) {
        for (const txId of current.transactionIds) {
          const tx = transactions.find((t) => t.id === txId);
          if (tx) onTxUpdate({ ...tx, state: 'revenue', settlementGroupId: undefined });
        }
        onGroupUpdate(null);
        onClose();
      }
    } finally { setSaving(false); }
  }

  const isCreate = !current;
  const net = current?.netAmount ?? netNum;
  // Bank rounds CZK to whole crowns → allow ~1 CZK slack per linked payout.
  const tolerance = Math.max(1, linkedTxs.length);
  const diff = linkedSum - net;
  const reconciled = current != null && linkedTxs.length > 0 && Math.abs(diff) <= tolerance;

  const inputClass = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400';
  const sectionTitle = 'text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2';

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white shadow-xl flex flex-col h-full overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <h2 className="text-base font-semibold text-gray-900">
            {isCreate ? 'Review OTA settlement' : current!.name}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">

          {/* ── CREATE: review extracted report ─────────────────────────── */}
          {isCreate && (
            <>
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-green-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <p className="text-xs text-green-700 font-medium">Report extracted — review and confirm</p>
                {queueRemaining > 0 && <span className="text-xs text-gray-400">· {queueRemaining} more queued</span>}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Source</label>
                  <select value={form.source} onChange={(e) => { const v = e.target.value as SettlementSource; setField('source', v); setForm((f) => ({ ...f, name: defaultName(v, f.periodStart) })); }} className={`${inputClass} bg-white`}>
                    {SOURCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
                  <input type="text" value={form.name} onChange={(e) => setField('name', e.target.value)} className={inputClass} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Period start *</label>
                  <input type="date" value={form.periodStart} onChange={(e) => { setField('periodStart', e.target.value); setForm((f) => ({ ...f, name: defaultName(f.source, e.target.value) })); }} className={inputClass} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Period end</label>
                  <input type="date" value={form.periodEnd} onChange={(e) => setField('periodEnd', e.target.value)} className={inputClass} />
                </div>
              </div>
              <p className="text-xs text-gray-400 -mt-2">Revenue is recognised in the period the report covers, not when the payout arrives.</p>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Gross *</label>
                  <input type="number" step="0.01" value={form.gross} onChange={(e) => setField('gross', e.target.value)} className={inputClass} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Commission</label>
                  <input type="number" step="0.01" value={form.commission} onChange={(e) => setField('commission', e.target.value)} className={inputClass} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Net</label>
                  <input type="number" step="0.01" value={form.net} onChange={(e) => setField('net', e.target.value)} placeholder={String(grossNum - commNum)} className={inputClass} />
                </div>
              </div>
              <div className={`text-xs rounded-lg px-3 py-2 ${Math.abs((grossNum - commNum) - netNum) <= 1 ? 'bg-gray-50 text-gray-500' : 'bg-amber-50 text-amber-700 border border-amber-100'}`}>
                Gross − commission = {formatCurrency(grossNum - commNum)}
                {Math.abs((grossNum - commNum) - netNum) > 1 && ` · doesn't match net ${formatCurrency(netNum)}`}
              </div>

              {file && (
                <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg">
                  <span className="text-xs text-gray-500 truncate flex-1">{file.name}</span>
                  <span className="text-xs text-indigo-600 shrink-0">→ Drive</span>
                </div>
              )}

              {error && <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}
            </>
          )}

          {/* ── VIEW: report summary + bank linking ─────────────────────── */}
          {!isCreate && current && (
            <>
              <div className="bg-gray-50 rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-rose-100 text-rose-700 capitalize">{current.source ?? 'ota'}</span>
                  <span className="text-xs text-gray-400">{monthLabel(current.periodStart)}</span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <div><p className="text-xs text-gray-400">Gross</p><p className="font-semibold text-gray-900">{formatCurrency(current.grossAmount ?? 0)}</p></div>
                  <div><p className="text-xs text-gray-400">Commission</p><p className="font-medium text-rose-600">−{formatCurrency(current.commissionAmount ?? 0)}</p></div>
                  <div><p className="text-xs text-gray-400">Net payout</p><p className="font-semibold text-green-700">{formatCurrency(net)}</p></div>
                </div>
                {current.reportUrl && (
                  <a href={current.reportUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-indigo-600 hover:underline block">📄 {current.reportFileName ?? 'View report in Drive'}</a>
                )}
              </div>

              {/* Reconciliation status */}
              <div className={`rounded-xl px-4 py-3 border ${reconciled ? 'bg-green-50 border-green-200' : linkedTxs.length > 0 ? 'bg-amber-50 border-amber-200' : 'bg-gray-50 border-gray-200'}`}>
                <div className="flex items-center justify-between">
                  <p className={`text-sm font-medium ${reconciled ? 'text-green-800' : linkedTxs.length > 0 ? 'text-amber-800' : 'text-gray-600'}`}>
                    {reconciled ? '✓ Payouts reconciled' : linkedTxs.length > 0 ? 'Payouts don’t match net yet' : 'No payouts linked'}
                  </p>
                  <p className="text-sm font-semibold text-gray-800">{formatCurrency(linkedSum)} / {formatCurrency(net)}</p>
                </div>
                {linkedTxs.length > 0 && !reconciled && (
                  <p className="text-xs text-amber-700 mt-1">Difference {formatCurrency(diff)} (tolerance ±{formatCurrency(tolerance)})</p>
                )}
              </div>

              {/* Linked payouts */}
              <div>
                <p className={sectionTitle}>Linked bank payouts</p>
                <div className="space-y-1.5">
                  {linkedTxs.length === 0 && <p className="text-xs text-gray-400">None linked yet.</p>}
                  {linkedTxs.map((tx) => (
                    <div key={tx.id} className="flex items-center gap-2 border border-gray-100 rounded-lg px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-gray-800 truncate">{tx.counterpartyName ?? '—'}</p>
                        <p className="text-xs text-gray-400">{formatDate(tx.date)}</p>
                      </div>
                      <p className="text-sm font-semibold text-green-700 whitespace-nowrap">+{formatCurrency(tx.amount)}</p>
                      <button onClick={() => { void handleRemoveTx(tx.id); }} disabled={busyTx === tx.id} className="text-xs text-gray-400 hover:text-red-500 ml-1 flex-shrink-0 disabled:opacity-50">Remove</button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Attach payout */}
              <div>
                <p className={sectionTitle}>Link a bank payout</p>
                <input type="text" placeholder="Search revenue credits…" value={txSearch} onChange={(e) => setTxSearch(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-1 focus:ring-indigo-400" />
                {candidateTxs.length === 0 ? (
                  <p className="text-xs text-gray-400">No unlinked revenue credits found.</p>
                ) : (
                  <div className="space-y-1.5 max-h-56 overflow-y-auto">
                    {candidateTxs.map((tx) => (
                      <button key={tx.id} onClick={() => { void handleAddTx(tx.id); }} disabled={busyTx === tx.id} className="w-full flex items-center gap-2 border border-gray-100 rounded-lg px-3 py-2 hover:border-indigo-300 hover:bg-indigo-50 text-left transition-colors disabled:opacity-50">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-gray-800 truncate">{tx.counterpartyName ?? '—'}</p>
                          <p className="text-xs text-gray-400">{formatDate(tx.date)}</p>
                        </div>
                        <p className="text-sm font-medium text-green-600 whitespace-nowrap">+{formatCurrency(tx.amount)}</p>
                        <span className="text-xs text-indigo-600 ml-1 flex-shrink-0">Link</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 flex gap-3 flex-shrink-0">
          {isCreate ? (
            <>
              <button onClick={onClose} disabled={saving} className="px-4 py-2 text-sm border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 disabled:opacity-40">
                {queueRemaining > 0 ? 'Skip' : 'Cancel'}
              </button>
              <button onClick={() => { void handleCreate(); }} disabled={saving} className="flex-1 px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">
                {saving ? 'Saving…' : 'Save settlement'}
              </button>
            </>
          ) : (
            <div className="flex w-full items-center justify-between gap-3">
              <button onClick={() => { void handleDelete(); }} disabled={saving} className="px-4 py-2 text-sm font-medium text-red-500 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50">
                Delete
              </button>
              <button onClick={onClose} className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
                {queueRemaining > 0 ? 'Next report →' : 'Done'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

'use client';
import { useState, useMemo } from 'react';
import type { SettlementGroup } from '@/types/settlementGroup';
import type { BankTransaction } from '@/types/bankTransaction';
import type { SupplierInvoice } from '@/types/supplierInvoice';
import { formatCurrency, formatDate } from '@/utils/formatters';

interface Props {
  group: SettlementGroup;
  transactions: BankTransaction[];
  invoices: SupplierInvoice[];
  onClose: () => void;
  onGroupUpdate: (group: SettlementGroup | null) => void;
  onTxUpdate: (tx: BankTransaction) => void;
  onInvoiceUpdate: (inv: SupplierInvoice) => void;
}

export default function SettlementGroupDrawer({
  group, transactions, invoices, onClose, onGroupUpdate, onTxUpdate, onInvoiceUpdate,
}: Props) {
  const [name, setName]                   = useState(group.name);
  const [renameSaving, setRenameSaving]   = useState(false);
  const [invoiceSearch, setInvoiceSearch] = useState('');
  const [saving, setSaving]               = useState<string | null>(null); // action key
  const [deleting, setDeleting]           = useState(false);

  const groupTxs = useMemo(
    () => transactions.filter((t) => group.transactionIds.includes(t.id)),
    [transactions, group.transactionIds],
  );
  const cumulative = groupTxs.reduce((s, t) => s + t.amount, 0);

  const groupInvoices = useMemo(
    () => invoices.filter((inv) => group.invoiceIds.includes(inv.id)),
    [invoices, group.invoiceIds],
  );

  const attachableCandidates = useMemo(() => {
    const q = invoiceSearch.toLowerCase();
    return invoices
      .filter((inv) => inv.status === 'pending' && !group.invoiceIds.includes(inv.id))
      .filter((inv) => !q || inv.supplierName.toLowerCase().includes(q) || inv.invoiceNumber.toLowerCase().includes(q))
      .sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate));
  }, [invoices, group.invoiceIds, invoiceSearch]);

  async function put(body: object) {
    return fetch(`/api/settlement-groups/${group.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function handleRename() {
    if (name.trim() === group.name || !name.trim()) return;
    setRenameSaving(true);
    try {
      const res = await put({ action: 'rename', name: name.trim() });
      if (res.ok) {
        const data = await res.json() as { group: SettlementGroup };
        onGroupUpdate(data.group);
      }
    } finally {
      setRenameSaving(false);
    }
  }

  async function handleRemoveTx(txId: string) {
    setSaving(`remove_tx_${txId}`);
    try {
      const res = await put({ action: 'remove_transaction', transactionId: txId });
      if (res.ok) {
        const data = await res.json() as { group: SettlementGroup | null; deleted: boolean };
        const tx = transactions.find((t) => t.id === txId);
        if (tx) onTxUpdate({ ...tx, state: 'revenue', settlementGroupId: undefined });
        if (data.deleted) {
          onGroupUpdate(null);
          onClose();
        } else {
          onGroupUpdate(data.group);
        }
      }
    } finally {
      setSaving(null);
    }
  }

  async function handleDetachInvoice(invId: string) {
    setSaving(`detach_inv_${invId}`);
    try {
      const res = await put({ action: 'remove_invoice', invoiceId: invId });
      if (res.ok) {
        const data = await res.json() as { group: SettlementGroup };
        const inv = invoices.find((i) => i.id === invId);
        if (inv) onInvoiceUpdate({ ...inv, status: 'pending', settlementGroupId: undefined, reconciledAt: undefined });
        onGroupUpdate(data.group);
      }
    } finally {
      setSaving(null);
    }
  }

  async function handleAttachInvoice(invId: string) {
    setSaving(`attach_inv_${invId}`);
    try {
      const res = await put({ action: 'add_invoice', invoiceId: invId });
      if (res.ok) {
        const data = await res.json() as { group: SettlementGroup };
        const inv = invoices.find((i) => i.id === invId);
        if (inv) onInvoiceUpdate({ ...inv, status: 'reconciled', settlementGroupId: group.id, reconciledAt: new Date().toISOString() });
        onGroupUpdate(data.group);
        setInvoiceSearch('');
      }
    } finally {
      setSaving(null);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete group "${group.name}"? This will reset all ${group.transactionIds.length} transactions back to revenue and detach ${group.invoiceIds.length} invoices.`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/settlement-groups/${group.id}`, { method: 'DELETE' });
      if (res.ok) {
        // Reset all grouped txs locally
        for (const txId of group.transactionIds) {
          const tx = transactions.find((t) => t.id === txId);
          if (tx) onTxUpdate({ ...tx, state: 'revenue', settlementGroupId: undefined });
        }
        // Reset all attached invoices locally
        for (const invId of group.invoiceIds) {
          const inv = invoices.find((i) => i.id === invId);
          if (inv) onInvoiceUpdate({ ...inv, status: 'pending', settlementGroupId: undefined, bankTransactionId: undefined, reconciledAt: undefined });
        }
        onGroupUpdate(null);
        onClose();
      }
    } finally {
      setDeleting(false);
    }
  }

  const sectionTitle = 'text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2';

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white shadow-xl flex flex-col h-full overflow-hidden">

        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0">
          <div className="flex-1 min-w-0 mr-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => { void handleRename(); }}
              className="text-base font-semibold text-gray-800 w-full bg-transparent border-b border-transparent focus:border-indigo-400 focus:outline-none pb-0.5"
            />
            {renameSaving && <p className="text-xs text-gray-400 mt-0.5">Saving…</p>}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none flex-shrink-0">×</button>
        </div>

        {/* Summary */}
        <div className="px-5 py-3 bg-violet-50 border-b border-violet-100 flex-shrink-0 flex items-center justify-between">
          <div>
            <p className="text-xs text-violet-500">{groupTxs.length} payment{groupTxs.length !== 1 ? 's' : ''} · {groupInvoices.length} invoice{groupInvoices.length !== 1 ? 's' : ''}</p>
          </div>
          <p className="text-xl font-bold text-green-700">+{formatCurrency(cumulative)}</p>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">

          {/* Transactions */}
          <div>
            <p className={sectionTitle}>Payments in this group</p>
            <div className="space-y-1.5">
              {groupTxs.length === 0 && (
                <p className="text-xs text-gray-400">No transactions.</p>
              )}
              {groupTxs.map((tx) => (
                <div key={tx.id} className="flex items-center gap-2 border border-gray-100 rounded-lg px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-800 truncate">{tx.counterpartyName ?? '—'}</p>
                    <p className="text-xs text-gray-400">{formatDate(tx.date)}</p>
                  </div>
                  <p className="text-sm font-semibold text-green-700 whitespace-nowrap">+{formatCurrency(tx.amount)}</p>
                  <button
                    onClick={() => { void handleRemoveTx(tx.id); }}
                    disabled={saving === `remove_tx_${tx.id}`}
                    className="text-xs text-gray-400 hover:text-red-500 ml-1 flex-shrink-0 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Attached invoices */}
          <div>
            <p className={sectionTitle}>Attached invoices</p>
            <div className="space-y-1.5">
              {groupInvoices.length === 0 && (
                <p className="text-xs text-amber-500">No invoices attached yet.</p>
              )}
              {groupInvoices.map((inv) => (
                <div key={inv.id} className="flex items-center gap-2 border border-gray-100 rounded-lg px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-800 truncate">{inv.supplierName}</p>
                    <p className="text-xs text-gray-400">{inv.invoiceNumber} · {inv.invoiceDate}</p>
                  </div>
                  <p className="text-sm font-medium text-gray-700 whitespace-nowrap">{formatCurrency(inv.amountCZK)}</p>
                  <button
                    onClick={() => { void handleDetachInvoice(inv.id); }}
                    disabled={saving === `detach_inv_${inv.id}`}
                    className="text-xs text-gray-400 hover:text-red-500 ml-1 flex-shrink-0 disabled:opacity-50"
                  >
                    Detach
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Attach invoice */}
          <div>
            <p className={sectionTitle}>Attach a supplier invoice</p>
            <input
              type="text"
              placeholder="Search pending invoices…"
              value={invoiceSearch}
              onChange={(e) => setInvoiceSearch(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-1 focus:ring-violet-400"
            />
            {attachableCandidates.length === 0 && invoiceSearch.length === 0 ? (
              <p className="text-xs text-gray-400">No pending invoices available.</p>
            ) : attachableCandidates.length === 0 ? (
              <p className="text-xs text-gray-400">No matches found.</p>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {attachableCandidates.map((inv) => (
                  <button
                    key={inv.id}
                    onClick={() => { void handleAttachInvoice(inv.id); }}
                    disabled={saving === `attach_inv_${inv.id}`}
                    className="w-full flex items-center gap-2 border border-gray-100 rounded-lg px-3 py-2 hover:border-violet-300 hover:bg-violet-50 text-left transition-colors disabled:opacity-50"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-gray-800 truncate">{inv.supplierName}</p>
                      <p className="text-xs text-gray-400">{inv.invoiceNumber} · {inv.invoiceDate}</p>
                    </div>
                    <p className="text-sm font-medium text-gray-700 whitespace-nowrap">{formatCurrency(inv.amountCZK)}</p>
                    <span className="text-xs text-violet-600 ml-1 flex-shrink-0">Attach</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-100 flex-shrink-0">
          <button
            onClick={() => { void handleDelete(); }}
            disabled={deleting}
            className="w-full py-2 text-sm font-medium text-red-500 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {deleting && <div className="w-4 h-4 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />}
            Delete group
          </button>
        </div>
      </div>
    </div>
  );
}

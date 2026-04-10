'use client';
import { useState, useMemo } from 'react';
import type { BankTransaction, IgnoreCategoryId } from '@/types/bankTransaction';
import { IGNORE_CATEGORIES } from '@/types/bankTransaction';
import type { SupplierInvoice } from '@/types/supplierInvoice';
import type { SettlementGroup } from '@/types/settlementGroup';
import { formatAmount, formatDate, formatCurrency } from '@/utils/formatters';

interface Props {
  transaction: BankTransaction;
  transactions: BankTransaction[];
  invoices: SupplierInvoice[];
  groups: SettlementGroup[];
  onSave: (tx: BankTransaction) => void;
  onGroupSave: (group: SettlementGroup | null, isNew: boolean) => void;
  onClose: () => void;
}

// ── Scored suggestion ──────────────────────────────────────────────────────────
function findSuggestion(tx: BankTransaction, invoices: SupplierInvoice[]): SupplierInvoice | null {
  const pending = invoices.filter((inv) => inv.status === 'pending' && !inv.bankTransactionId);
  const norm = (s: string) => s.toLowerCase().trim();

  const isForeign = tx.originalCurrency && tx.originalAmount != null;
  const txAmount  = isForeign ? (tx.originalAmount ?? tx.amount) : tx.amount;

  interface Scored { inv: SupplierInvoice; score: number }
  const scored: Scored[] = [];

  for (const inv of pending) {
    const invAmount = inv.amountCZK;
    // Amount: required within 1% or 2 units (handles rounding)
    const tolerance = Math.max(2, invAmount * 0.01);
    if (Math.abs(txAmount - invAmount) > tolerance) continue;

    // Name score (priority 1)
    const txName  = tx.counterpartyName ? norm(tx.counterpartyName) : '';
    const invName = norm(inv.supplierName);
    let nameScore = 0;
    if (txName && invName) {
      if (txName === invName) nameScore = 4;
      else if (txName.includes(invName) && invName.includes(txName)) nameScore = 3;
      else if (txName.includes(invName) || invName.includes(txName)) nameScore = 2;
      else {
        // Word-level overlap
        const txWords  = txName.split(/\s+/);
        const invWords = invName.split(/\s+/);
        const overlap  = txWords.filter((w) => invWords.some((iw) => iw.includes(w) || w.includes(iw))).length;
        if (overlap > 0) nameScore = 1;
      }
    }

    // Date score (priority 2): closer = higher, within 90 days
    const daysDiff = Math.abs(
      (new Date(tx.date).getTime() - new Date(inv.invoiceDate).getTime()) / 86_400_000,
    );
    const dateScore = daysDiff <= 90 ? (90 - daysDiff) / 90 : 0;

    scored.push({ inv, score: nameScore * 100 + dateScore });
  }

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  // Only surface if there's a name signal or just one candidate
  return scored[0].score > 0 || scored.length === 1 ? scored[0].inv : null;
}

/** Render a small label+value detail row */
function Detail({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex gap-2 text-xs">
      <span className="text-gray-400 w-28 flex-shrink-0">{label}</span>
      <span className="text-gray-700 break-all">{value}</span>
    </div>
  );
}

type DebitMode  = 'match' | 'ignore' | 'non_deductible';
type CreditMode = 'note' | 'refund' | 'partial_refund' | 'net_settlement' | 'settlement_group';

export default function ReconcileDrawer({ transaction: tx, transactions, invoices, groups, onSave, onGroupSave, onClose }: Props) {
  const isCredit  = tx.direction === 'credit';
  const suggestion = useMemo(() => (!isCredit ? findSuggestion(tx, invoices) : null), [tx, invoices, isCredit]);

  // ── Debit state ───────────────────────────────────────────────────────────
  const [debitMode, setDebitMode]              = useState<DebitMode>('match');
  const [selectedInvoiceId, setSelected]       = useState(tx.invoiceId ?? suggestion?.id ?? '');
  const [invoiceSearch, setInvoiceSearch]      = useState('');
  const [ignoreCategory, setIgnoreCat]         = useState<IgnoreCategoryId>((tx.ignoreCategory as IgnoreCategoryId) ?? 'other');
  const [ignoreNote, setIgnoreNote]            = useState(tx.ignoreNote ?? '');
  const [nonDeductNote, setNonDeductNote]      = useState(tx.state === 'non_deductible' ? (tx.ignoreNote ?? '') : '');

  // ── Credit state ──────────────────────────────────────────────────────────
  const initialCreditMode: CreditMode =
    tx.state === 'refund'          ? 'refund' :
    tx.state === 'partial_refund'  ? 'partial_refund' :
    tx.state === 'net_settlement'  ? 'net_settlement' :
    tx.state === 'grouped'         ? 'settlement_group' : 'note';

  const [creditMode, setCreditMode]            = useState<CreditMode>(initialCreditMode);
  const [revenueNote, setRevenueNote]          = useState(tx.ignoreNote ?? '');
  const [selectedDebitId, setSelectedDebitId]  = useState(tx.linkedTransactionId ?? '');
  const [debitSearch, setDebitSearch]          = useState('');
  const [settlementInvoiceIds, setSettlementInvoiceIds] = useState<Set<string>>(
    new Set(tx.deductedInvoiceIds ?? []),
  );
  const [settlementGross, setSettlementGross]  = useState(
    tx.grossAmount != null ? String(tx.grossAmount) : String(tx.amount),
  );
  const [settlementSearch, setSettlementSearch] = useState('');

  // ── Settlement group state ────────────────────────────────────────────────
  const [groupMode, setGroupMode]              = useState<'existing' | 'new'>(
    tx.settlementGroupId ? 'existing' : 'existing',
  );
  const [groupSearch, setGroupSearch]          = useState('');
  const [selectedGroupId, setSelectedGroupId]  = useState(tx.settlementGroupId ?? '');
  const [newGroupName, setNewGroupName]        = useState('');

  const [saving, setSaving] = useState(false);

  // ── Candidate invoices for debit matching ─────────────────────────────────
  const candidateInvoices = useMemo(() => invoices
    .filter((inv) => inv.status === 'pending' || inv.id === tx.invoiceId)
    .filter((inv) => {
      if (!invoiceSearch) return true;
      const q = invoiceSearch.toLowerCase();
      return inv.supplierName.toLowerCase().includes(q) || inv.invoiceNumber.toLowerCase().includes(q);
    })
    .sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate)),
  [invoices, tx.invoiceId, invoiceSearch]);

  // ── Candidate invoices for net settlement ────────────────────────────────
  const settlementCandidates = useMemo(() => invoices
    .filter((inv) =>
      inv.status === 'pending' ||
      (tx.deductedInvoiceIds ?? []).includes(inv.id) ||
      (inv.settlementTransactionIds?.length ?? 0) > 0,
    )
    .filter((inv) => {
      if (!settlementSearch) return true;
      const q = settlementSearch.toLowerCase();
      return inv.supplierName.toLowerCase().includes(q) || inv.invoiceNumber.toLowerCase().includes(q);
    })
    .sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate)),
  [invoices, tx.deductedInvoiceIds, settlementSearch]);

  // ── Candidate debits for refund linking ──────────────────────────────────
  const candidateDebits = useMemo(() => transactions
    .filter((t) => t.direction === 'debit' && t.id !== tx.id)
    .filter((t) => {
      if (!debitSearch) return true;
      const q = debitSearch.toLowerCase();
      return (
        (t.counterpartyName ?? '').toLowerCase().includes(q) ||
        (t.variableSymbol ?? '').toLowerCase().includes(q) ||
        String(t.amount).includes(q)
      );
    })
    .sort((a, b) => b.date.localeCompare(a.date)),
  [transactions, tx.id, debitSearch]);

  // ── Candidate groups for settlement group ────────────────────────────────
  const filteredGroups = useMemo(() => {
    const q = groupSearch.toLowerCase();
    return groups
      .filter((g) => !q || g.name.toLowerCase().includes(q))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [groups, groupSearch]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  async function put(body: object): Promise<BankTransaction | null> {
    const res = await fetch(`/api/bank-transactions/${tx.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok ? (await res.json() as BankTransaction) : null;
  }

  async function handleSave() {
    setSaving(true);
    try {
      if (isCredit && creditMode === 'settlement_group') {
        if (groupMode === 'new') {
          if (!newGroupName.trim()) return;
          const res = await fetch('/api/settlement-groups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newGroupName.trim(), transactionId: tx.id }),
          });
          if (res.ok) {
            const data = await res.json() as { group: SettlementGroup; transaction: BankTransaction };
            onGroupSave(data.group, true);
            onSave(data.transaction);
          }
        } else {
          if (!selectedGroupId) return;
          const res = await fetch(`/api/settlement-groups/${selectedGroupId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'add_transaction', transactionId: tx.id }),
          });
          if (res.ok) {
            const data = await res.json() as { group: SettlementGroup };
            onGroupSave(data.group, false);
            // Also update local tx state
            const updatedTx = { ...tx, state: 'grouped' as const, settlementGroupId: selectedGroupId };
            onSave(updatedTx);
          }
        }
        return;
      }

      let body: object;
      if (isCredit) {
        if (creditMode === 'note') {
          body = { action: 'note', note: revenueNote };
        } else if (creditMode === 'net_settlement') {
          body = {
            action: 'net_settlement',
            deductedInvoiceIds: [...settlementInvoiceIds],
            grossAmount: parseFloat(settlementGross) || undefined,
          };
        } else {
          body = {
            action: 'refund',
            partial: creditMode === 'partial_refund',
            linkedTransactionId: selectedDebitId || undefined,
          };
        }
      } else if (debitMode === 'match') {
        if (!selectedInvoiceId) return;
        body = { action: 'reconcile', invoiceId: selectedInvoiceId };
      } else if (debitMode === 'ignore') {
        body = { action: 'ignore', ignoreCategory, ignoreNote: ignoreNote || undefined };
      } else {
        body = { action: 'non_deductible', ignoreNote: nonDeductNote || undefined };
      }
      const updated = await put(body);
      if (updated) onSave(updated);
    } finally {
      setSaving(false);
    }
  }

  async function handleUnmatch() {
    setSaving(true);
    try {
      // For grouped transactions, remove from group via group API
      if (tx.state === 'grouped' && tx.settlementGroupId) {
        const res = await fetch(`/api/settlement-groups/${tx.settlementGroupId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'remove_transaction', transactionId: tx.id }),
        });
        if (res.ok) {
          const data = await res.json() as { group: SettlementGroup | null; deleted: boolean };
          onGroupSave(data.group, false);
          const updatedTx = { ...tx, state: 'revenue' as const, settlementGroupId: undefined };
          onSave(updatedTx);
        }
        return;
      }
      const updated = await put({ action: 'unmatch' });
      if (updated) onSave(updated);
    } finally {
      setSaving(false);
    }
  }

  const canSave = isCredit
    ? creditMode === 'settlement_group'
      ? groupMode === 'new' ? !!newGroupName.trim() : !!selectedGroupId
      : true
    : debitMode === 'match' ? !!selectedInvoiceId
    : debitMode === 'ignore' ? !!ignoreCategory
    : true;

  const amountLabel = tx.direction === 'debit' ? '−' : '+';

  const tabClass = (active: boolean) =>
    `flex-1 py-2.5 text-xs font-medium transition-colors ${
      active ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-gray-500 hover:text-gray-700'
    }`;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white shadow-xl flex flex-col h-full overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0">
          <h2 className="text-base font-semibold text-gray-800">
            {isCredit ? 'Revenue Transaction' : 'Reconcile Payment'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        {/* Transaction summary */}
        <div className="px-5 py-4 bg-gray-50 border-b border-gray-100 flex-shrink-0 space-y-3">
          <div className="flex items-start justify-between">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-gray-900">{tx.counterpartyName ?? '—'}</p>
              {tx.counterpartyAccount && <p className="text-xs text-gray-400 mt-0.5">{tx.counterpartyAccount}</p>}
            </div>
            <div className="text-right flex-shrink-0 ml-3">
              <p className={`text-lg font-semibold ${isCredit ? 'text-green-700' : 'text-gray-900'}`}>
                {amountLabel}{formatAmount(tx.amount)}
              </p>
              {tx.originalCurrency && tx.originalAmount != null && (
                <p className="text-xs text-indigo-500">
                  {amountLabel}{tx.originalAmount.toLocaleString('cs-CZ', { style: 'currency', currency: tx.originalCurrency, maximumFractionDigits: 2 })}
                </p>
              )}
              <p className="text-xs text-gray-400">{formatDate(tx.date)}</p>
              {tx.valueDate && tx.valueDate !== tx.date && (
                <p className="text-xs text-gray-400">value {formatDate(tx.valueDate)}</p>
              )}
            </div>
          </div>

          <div className="space-y-1 pt-1 border-t border-gray-100">
            <Detail label="Variable symbol"  value={tx.variableSymbol} />
            <Detail label="Constant symbol"  value={tx.constantSymbol} />
            <Detail label="Specific symbol"  value={tx.specificSymbol} />
            <Detail label="Transaction type" value={tx.transactionType} />
            <Detail label="Description"      value={tx.description} />
            <Detail label="My note"          value={tx.myDescription} />
            {tx.state === 'reconciled' && tx.reconciledAt && (
              <Detail label="Reconciled at" value={new Date(tx.reconciledAt).toLocaleString('cs-CZ')} />
            )}
            {(tx.state === 'ignored' || tx.state === 'non_deductible') && tx.ignoredAt && (
              <Detail label="Tagged at" value={new Date(tx.ignoredAt).toLocaleString('cs-CZ')} />
            )}
            {tx.state === 'grouped' && tx.settlementGroupId && (
              <Detail label="Settlement group" value={groups.find((g) => g.id === tx.settlementGroupId)?.name ?? tx.settlementGroupId} />
            )}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">

          {/* ── CREDIT / REVENUE ──────────────────────────────────────────── */}
          {isCredit && (
            <>
              <div className="flex border-b border-gray-100 flex-shrink-0">
                <button onClick={() => setCreditMode('note')}              className={tabClass(creditMode === 'note')}>Note</button>
                <button onClick={() => setCreditMode('settlement_group')}  className={tabClass(creditMode === 'settlement_group')}>Group</button>
                <button onClick={() => setCreditMode('net_settlement')}    className={tabClass(creditMode === 'net_settlement')}>Net settlement</button>
                <button onClick={() => setCreditMode('refund')}            className={tabClass(creditMode === 'refund')}>Refund</button>
                <button onClick={() => setCreditMode('partial_refund')}    className={tabClass(creditMode === 'partial_refund')}>Partial</button>
              </div>

              <div className="px-5 py-4 space-y-4">

                {/* ── Settlement group tab ─────────────────────────────────── */}
                {creditMode === 'settlement_group' && (
                  <>
                    <p className="text-xs text-gray-500">
                      Group multiple credit transactions together (e.g. weekly Airbnb payouts) and attach supplier invoices to the group.
                    </p>

                    {/* Mode toggle */}
                    <div className="flex gap-2">
                      <button
                        onClick={() => setGroupMode('existing')}
                        className={`flex-1 py-2 text-xs font-medium rounded-lg border transition-colors ${groupMode === 'existing' ? 'border-violet-400 bg-violet-50 text-violet-700' : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}
                      >
                        Add to existing group
                      </button>
                      <button
                        onClick={() => setGroupMode('new')}
                        className={`flex-1 py-2 text-xs font-medium rounded-lg border transition-colors ${groupMode === 'new' ? 'border-violet-400 bg-violet-50 text-violet-700' : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}
                      >
                        New group
                      </button>
                    </div>

                    {groupMode === 'new' && (
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1.5">Group name</label>
                        <input
                          type="text"
                          value={newGroupName}
                          onChange={(e) => setNewGroupName(e.target.value)}
                          placeholder="e.g. Airbnb April 2026"
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-violet-400"
                          autoFocus
                        />
                      </div>
                    )}

                    {groupMode === 'existing' && (
                      <>
                        <input
                          type="text"
                          placeholder="Search groups…"
                          value={groupSearch}
                          onChange={(e) => setGroupSearch(e.target.value)}
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-violet-400"
                        />
                        {filteredGroups.length === 0 ? (
                          <div className="text-xs text-gray-400 text-center py-6">
                            No groups yet — switch to "New group" to create one.
                          </div>
                        ) : (
                          <div className="space-y-1.5 max-h-72 overflow-y-auto">
                            {filteredGroups.map((g) => {
                              const groupTxs    = transactions.filter((t) => g.transactionIds.includes(t.id));
                              const cumulative  = groupTxs.reduce((s, t) => s + t.amount, 0);
                              const isSelected  = selectedGroupId === g.id;
                              return (
                                <label key={g.id}
                                  className={`flex items-start gap-3 border rounded-lg px-3 py-2.5 cursor-pointer transition-colors ${isSelected ? 'border-violet-300 bg-violet-50' : 'border-gray-200 hover:border-gray-300'}`}
                                >
                                  <input type="radio" name="group" value={g.id}
                                    checked={isSelected}
                                    onChange={() => setSelectedGroupId(g.id)}
                                    className="mt-0.5 text-violet-600 flex-shrink-0" />
                                  <div className="min-w-0 flex-1">
                                    <p className="text-sm font-medium text-gray-800 truncate">{g.name}</p>
                                    <p className="text-xs text-gray-500">
                                      {g.transactionIds.length} payment{g.transactionIds.length !== 1 ? 's' : ''} · {g.invoiceIds.length} invoice{g.invoiceIds.length !== 1 ? 's' : ''}
                                    </p>
                                  </div>
                                  <p className="text-sm font-semibold text-green-700 whitespace-nowrap flex-shrink-0">
                                    +{formatCurrency(cumulative)}
                                  </p>
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}

                {creditMode === 'net_settlement' && (
                  <>
                    <p className="text-xs text-gray-500">
                      Use when an OTA (Booking.com, Airbnb, etc.) deducts their commission before remitting.
                      Select the fee invoices that were deducted — they will be marked reconciled against this payment.
                    </p>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1.5">
                        Gross amount received from guests (optional)
                      </label>
                      <input
                        type="number"
                        value={settlementGross}
                        onChange={(e) => setSettlementGross(e.target.value)}
                        placeholder={String(tx.amount)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      />
                      <p className="text-xs text-gray-400 mt-1">
                        Net received: {formatAmount(tx.amount)} · Fees: {formatAmount(
                          Math.max(0, (parseFloat(settlementGross) || tx.amount) - tx.amount)
                        )}
                      </p>
                    </div>
                    <input
                      type="text"
                      placeholder="Search fee invoice…"
                      value={settlementSearch}
                      onChange={(e) => setSettlementSearch(e.target.value)}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                    <div className="space-y-1.5 max-h-72 overflow-y-auto">
                      {settlementCandidates.length === 0 ? (
                        <p className="text-xs text-gray-400 text-center py-4">No pending invoices found.</p>
                      ) : settlementCandidates.map((inv) => {
                        const checked = settlementInvoiceIds.has(inv.id);
                        const otherSettlements = (inv.settlementTransactionIds ?? []).filter((tid) => tid !== tx.id);
                        return (
                          <label key={inv.id}
                            className={`flex items-start gap-3 border rounded-lg px-3 py-2.5 cursor-pointer transition-colors ${checked ? 'border-cyan-300 bg-cyan-50' : 'border-gray-200 hover:border-gray-300'}`}>
                            <input type="checkbox"
                              checked={checked}
                              onChange={() => setSettlementInvoiceIds((prev) => {
                                const next = new Set(prev);
                                checked ? next.delete(inv.id) : next.add(inv.id);
                                return next;
                              })}
                              className="mt-0.5 text-cyan-600 flex-shrink-0" />
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-gray-800 truncate">{inv.supplierName}</p>
                              <p className="text-xs text-gray-500">{inv.invoiceNumber} · {inv.invoiceDate}</p>
                              {otherSettlements.length > 0 && (
                                <p className="text-xs text-cyan-600 mt-0.5">
                                  {otherSettlements.length} other settlement{otherSettlements.length !== 1 ? 's' : ''} already linked
                                </p>
                              )}
                            </div>
                            <p className="text-sm font-medium text-gray-800 whitespace-nowrap flex-shrink-0">
                              {formatAmount(inv.amountCZK, inv.invoiceCurrency)}
                            </p>
                          </label>
                        );
                      })}
                    </div>
                    {settlementInvoiceIds.size > 0 && (
                      <p className="text-xs text-cyan-700 font-medium">
                        {settlementInvoiceIds.size} invoice{settlementInvoiceIds.size !== 1 ? 's' : ''} selected
                      </p>
                    )}
                  </>
                )}

                {creditMode === 'note' && (
                  <>
                    <p className="text-xs text-gray-500">
                      Add a reference note to identify the source (e.g. booking number, platform, guest name).
                      Full revenue reconciliation is handled in Phase 3.
                    </p>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1.5">Reference note (optional)</label>
                      <input
                        type="text"
                        value={revenueNote}
                        onChange={(e) => setRevenueNote(e.target.value)}
                        placeholder="e.g. Airbnb booking HMABCD · Jan 2026"
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      />
                    </div>
                  </>
                )}

                {(creditMode === 'refund' || creditMode === 'partial_refund') && (
                  <>
                    <p className="text-xs text-gray-500">
                      {creditMode === 'refund'
                        ? 'Mark as a full refund and optionally link to the original payment.'
                        : 'Mark as a partial refund and optionally link to the original payment.'}
                    </p>
                    <input
                      type="text"
                      placeholder="Search by counterparty, amount…"
                      value={debitSearch}
                      onChange={(e) => setDebitSearch(e.target.value)}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                    <p className="text-xs text-gray-400 -mt-2">Linking is optional — save without selecting to just tag the status.</p>
                    <div className="space-y-1.5 max-h-72 overflow-y-auto">
                      {candidateDebits.length === 0 ? (
                        <p className="text-xs text-gray-400 text-center py-4">No debit transactions found.</p>
                      ) : candidateDebits.map((t) => (
                        <label key={t.id}
                          className={`flex items-start gap-3 border rounded-lg px-3 py-2.5 cursor-pointer transition-colors ${selectedDebitId === t.id ? 'border-teal-300 bg-teal-50' : 'border-gray-200 hover:border-gray-300'}`}>
                          <input type="radio" name="debit" value={t.id}
                            checked={selectedDebitId === t.id}
                            onChange={() => setSelectedDebitId(t.id)}
                            className="mt-0.5 text-teal-600 flex-shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-gray-800 truncate">{t.counterpartyName ?? '—'}</p>
                            <p className="text-xs text-gray-500">{formatDate(t.date)}{t.variableSymbol ? ` · VS ${t.variableSymbol}` : ''}</p>
                          </div>
                          <p className="text-sm font-medium text-gray-800 whitespace-nowrap flex-shrink-0">−{formatAmount(t.amount)}</p>
                        </label>
                      ))}
                    </div>
                    {selectedDebitId && (
                      <button onClick={() => setSelectedDebitId('')} className="text-xs text-gray-400 hover:text-gray-600">
                        Clear selection
                      </button>
                    )}
                  </>
                )}
              </div>
            </>
          )}

          {/* ── DEBIT — mode tabs ─────────────────────────────────────────── */}
          {!isCredit && (
            <>
              <div className="flex border-b border-gray-100 flex-shrink-0">
                <button onClick={() => setDebitMode('match')}          className={tabClass(debitMode === 'match')}>Match invoice</button>
                <button onClick={() => setDebitMode('ignore')}         className={tabClass(debitMode === 'ignore')}>Not an invoice</button>
                <button onClick={() => setDebitMode('non_deductible')} className={tabClass(debitMode === 'non_deductible')}>Non-deductible</button>
              </div>

              <div className="px-5 py-4">
                {debitMode === 'match' && (
                  <div className="space-y-3">
                    {suggestion && !tx.invoiceId && (
                      <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-3">
                        <p className="text-xs font-semibold text-indigo-700 mb-2">Suggested match</p>
                        <label className="flex items-start gap-3 cursor-pointer">
                          <input type="radio" name="invoice" value={suggestion.id}
                            checked={selectedInvoiceId === suggestion.id}
                            onChange={() => setSelected(suggestion.id)}
                            className="mt-0.5 text-indigo-600" />
                          <div>
                            <p className="text-sm font-medium text-gray-800">{suggestion.supplierName}</p>
                            <p className="text-xs text-gray-500">{suggestion.invoiceNumber} · {formatDate(suggestion.invoiceDate)}</p>
                            <p className="text-sm font-semibold text-gray-800 mt-0.5">{formatAmount(suggestion.amountCZK, suggestion.invoiceCurrency)}</p>
                          </div>
                        </label>
                      </div>
                    )}
                    <input type="text" placeholder="Search supplier or invoice #…" value={invoiceSearch}
                      onChange={(e) => setInvoiceSearch(e.target.value)}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400" />
                    <div className="space-y-1.5 max-h-80 overflow-y-auto">
                      {candidateInvoices.length === 0 ? (
                        <p className="text-xs text-gray-400 text-center py-4">No pending invoices found.</p>
                      ) : candidateInvoices.map((inv) => (
                        <label key={inv.id}
                          className={`flex items-start gap-3 border rounded-lg px-3 py-2.5 cursor-pointer transition-colors ${selectedInvoiceId === inv.id ? 'border-indigo-300 bg-indigo-50' : 'border-gray-200 hover:border-gray-300'}`}>
                          <input type="radio" name="invoice" value={inv.id}
                            checked={selectedInvoiceId === inv.id}
                            onChange={() => setSelected(inv.id)}
                            className="mt-0.5 text-indigo-600 flex-shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-gray-800 truncate">{inv.supplierName}</p>
                            <p className="text-xs text-gray-500">{inv.invoiceNumber} · {formatDate(inv.invoiceDate)}</p>
                          </div>
                          <p className="text-sm font-medium text-gray-800 whitespace-nowrap flex-shrink-0">{formatAmount(inv.amountCZK, inv.invoiceCurrency)}</p>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {debitMode === 'ignore' && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1.5">Category</label>
                      <select value={ignoreCategory} onChange={(e) => setIgnoreCat(e.target.value as IgnoreCategoryId)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400">
                        {IGNORE_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1.5">Note (optional)</label>
                      <input type="text" value={ignoreNote} onChange={(e) => setIgnoreNote(e.target.value)}
                        placeholder="e.g. Jana Nováková — March salary"
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400" />
                    </div>
                  </div>
                )}

                {debitMode === 'non_deductible' && (
                  <div className="space-y-4">
                    <p className="text-xs text-gray-500">
                      Use for costs that do not qualify for tax deduction, or where the receipt has been lost.
                    </p>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1.5">Note (optional)</label>
                      <input type="text" value={nonDeductNote} onChange={(e) => setNonDeductNote(e.target.value)}
                        placeholder="e.g. Receipt lost · client dinner"
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400" />
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-100 flex items-center justify-between flex-shrink-0">
          <div>
            {(tx.state === 'reconciled' || tx.state === 'ignored' || tx.state === 'non_deductible' || tx.state === 'refund' || tx.state === 'partial_refund' || tx.state === 'net_settlement' || tx.state === 'grouped') && (
              <button onClick={handleUnmatch} disabled={saving} className="text-xs text-gray-400 hover:text-red-500">
                {tx.state === 'grouped' ? 'Remove from group' : `Reset to ${isCredit ? 'revenue' : 'unmatched'}`}
              </button>
            )}
          </div>
          <div className="flex gap-3">
            <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
            <button onClick={() => { void handleSave(); }} disabled={!canSave || saving}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2">
              {saving && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

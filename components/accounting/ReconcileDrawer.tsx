'use client';
import { useState, useMemo } from 'react';
import type { BankTransaction, IgnoreCategoryId, RecurringCostCategoryId } from '@/types/bankTransaction';
import { IGNORE_CATEGORIES, RECURRING_COST_CATEGORIES } from '@/types/bankTransaction';
import type { SupplierInvoice } from '@/types/supplierInvoice';
import type { SettlementGroup } from '@/types/settlementGroup';
import { formatAmount, formatDate, formatCurrency } from '@/utils/formatters';
import { findSuggestion } from '@/utils/reconcileSuggest';

interface Props {
  transaction: BankTransaction;
  transactions: BankTransaction[];
  invoices: SupplierInvoice[];
  groups: SettlementGroup[];
  onSave: (tx: BankTransaction) => void;
  onGroupSave: (group: SettlementGroup | null, isNew: boolean) => void;
  onClose: () => void;
}

// findSuggestion moved to utils/reconcileSuggest.ts (shared with BankTransactionList)

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

type DebitMode  = 'match' | 'recurring_cost' | 'ignore' | 'non_deductible';
type CreditMode = 'note' | 'refund' | 'partial_refund' | 'net_settlement' | 'settlement_group';

export default function ReconcileDrawer({ transaction: tx, transactions, invoices, groups, onSave, onGroupSave, onClose }: Props) {
  const isCredit  = tx.direction === 'credit';
  const suggestion = useMemo(() => (!isCredit ? findSuggestion(tx, invoices) : null), [tx, invoices, isCredit]);
  // Invoices already linked to this debit (single legacy id or split-delivery array)
  const linkedIds = useMemo(
    () => (tx.invoiceIds?.length ? tx.invoiceIds : (tx.invoiceId ? [tx.invoiceId] : [])),
    [tx.invoiceIds, tx.invoiceId],
  );

  // ── Debit state ───────────────────────────────────────────────────────────
  const initialDebitMode: DebitMode =
    tx.state === 'recurring_cost' ? 'recurring_cost' :
    tx.state === 'ignored'        ? 'ignore' :
    tx.state === 'non_deductible' ? 'non_deductible' : 'match';
  const [debitMode, setDebitMode]              = useState<DebitMode>(initialDebitMode);
  const initialSelectedInvoiceIds = tx.invoiceIds?.length
    ? tx.invoiceIds
    : (tx.invoiceId ? [tx.invoiceId] : (suggestion ? [suggestion.id] : []));
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<Set<string>>(new Set(initialSelectedInvoiceIds));
  const [invoiceSearch, setInvoiceSearch]      = useState('');
  const [ignoreCategory, setIgnoreCat]         = useState<IgnoreCategoryId>((tx.ignoreCategory as IgnoreCategoryId) ?? 'other');
  const [ignoreNote, setIgnoreNote]            = useState(tx.ignoreNote ?? '');
  const [nonDeductNote, setNonDeductNote]      = useState(tx.state === 'non_deductible' ? (tx.ignoreNote ?? '') : '');

  // ── Recurring-cost state ────────────────────────────────────────────────────
  const [costCategory, setCostCategory]        = useState<RecurringCostCategoryId>((tx.costCategory as RecurringCostCategoryId) ?? 'rent');
  const [costNote, setCostNote]                = useState(tx.costNote ?? '');
  const [addToWhitelist, setAddToWhitelist]    = useState(false);
  const [whitelistLabel, setWhitelistLabel]    = useState(tx.counterpartyName || tx.description || tx.myDescription || '');
  const [whitelistFixed, setWhitelistFixed]    = useState(true);

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
    .filter((inv) => inv.status === 'pending' || linkedIds.includes(inv.id))
    .filter((inv) => {
      if (!invoiceSearch) return true;
      const q = invoiceSearch.toLowerCase();
      return inv.supplierName.toLowerCase().includes(q) || inv.invoiceNumber.toLowerCase().includes(q);
    })
    .sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate)),
  [invoices, linkedIds, invoiceSearch]);

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

  // Sum of the currently-selected invoices (for the split-delivery running total)
  const selectedSum = useMemo(
    () => invoices.filter((inv) => selectedInvoiceIds.has(inv.id)).reduce((s, inv) => s + inv.amountCZK, 0),
    [invoices, selectedInvoiceIds],
  );

  function toggleInvoice(invId: string) {
    setSelectedInvoiceIds((prev) => {
      const next = new Set(prev);
      if (next.has(invId)) next.delete(invId); else next.add(invId);
      return next;
    });
  }

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
        if (selectedInvoiceIds.size === 0) return;
        body = { action: 'reconcile', invoiceIds: [...selectedInvoiceIds] };
      } else if (debitMode === 'recurring_cost') {
        body = {
          action: 'recurring_cost',
          costCategory,
          costNote: costNote || undefined,
          whitelist: addToWhitelist ? { label: whitelistLabel || undefined, fixedAmount: whitelistFixed } : undefined,
        };
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
    : debitMode === 'match' ? selectedInvoiceIds.size > 0
    : debitMode === 'recurring_cost' ? !!costCategory
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
            {(tx.state === 'ignored' || tx.state === 'non_deductible' || tx.state === 'recurring_cost') && tx.ignoredAt && (
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
                <button onClick={() => setDebitMode('recurring_cost')} className={tabClass(debitMode === 'recurring_cost')}>Recurring cost</button>
                <button onClick={() => setDebitMode('ignore')}         className={tabClass(debitMode === 'ignore')}>Not an invoice</button>
                <button onClick={() => setDebitMode('non_deductible')} className={tabClass(debitMode === 'non_deductible')}>Non-deductible</button>
              </div>

              <div className="px-5 py-4">
                {debitMode === 'match' && (
                  <div className="space-y-3">
                    <p className="text-xs text-gray-500">
                      Pick one invoice — or several when a single payment covers multiple invoices (e.g. an order split into separate deliveries).
                    </p>
                    {suggestion && linkedIds.length === 0 && (
                      <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-3">
                        <p className="text-xs font-semibold text-indigo-700 mb-2">Suggested match</p>
                        <label className="flex items-start gap-3 cursor-pointer">
                          <input type="checkbox"
                            checked={selectedInvoiceIds.has(suggestion.id)}
                            onChange={() => toggleInvoice(suggestion.id)}
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
                      ) : candidateInvoices.map((inv) => {
                        const checked = selectedInvoiceIds.has(inv.id);
                        return (
                          <label key={inv.id}
                            className={`flex items-start gap-3 border rounded-lg px-3 py-2.5 cursor-pointer transition-colors ${checked ? 'border-indigo-300 bg-indigo-50' : 'border-gray-200 hover:border-gray-300'}`}>
                            <input type="checkbox"
                              checked={checked}
                              onChange={() => toggleInvoice(inv.id)}
                              className="mt-0.5 text-indigo-600 flex-shrink-0" />
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-gray-800 truncate">{inv.supplierName}</p>
                              <p className="text-xs text-gray-500">{inv.invoiceNumber} · {formatDate(inv.invoiceDate)}</p>
                            </div>
                            <p className="text-sm font-medium text-gray-800 whitespace-nowrap flex-shrink-0">{formatAmount(inv.amountCZK, inv.invoiceCurrency)}</p>
                          </label>
                        );
                      })}
                    </div>
                    {selectedInvoiceIds.size > 1 && (
                      <div className="flex items-center justify-between text-xs bg-gray-50 rounded-lg px-3 py-2">
                        <span className="text-gray-500">{selectedInvoiceIds.size} invoices selected</span>
                        <span className="text-gray-700">
                          Σ {formatAmount(selectedSum)} · payment {formatAmount(tx.amount)}
                          {Math.abs(selectedSum - tx.amount) > 1 && (
                            <span className="text-amber-600"> · Δ {formatAmount(selectedSum - tx.amount)}</span>
                          )}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {debitMode === 'recurring_cost' && (
                  <div className="space-y-4">
                    <p className="text-xs text-gray-500">
                      For contractual standing orders that never have a supplier invoice
                      (rent to owners, parking lease). Counts as a cost in the P&amp;L.
                    </p>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1.5">Cost category</label>
                      <select value={costCategory} onChange={(e) => setCostCategory(e.target.value as RecurringCostCategoryId)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400">
                        {RECURRING_COST_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1.5">Note (optional)</label>
                      <input type="text" value={costNote} onChange={(e) => setCostNote(e.target.value)}
                        placeholder="e.g. Rent K201–203 — monthly"
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400" />
                    </div>

                    {/* Whitelist — auto-classify future matching payments on import */}
                    <div className="rounded-lg border border-gray-200 p-3 space-y-3">
                      <label className="flex items-start gap-2.5 cursor-pointer">
                        <input type="checkbox" checked={addToWhitelist}
                          onChange={(e) => setAddToWhitelist(e.target.checked)}
                          className="mt-0.5 text-indigo-600" />
                        <span className="text-xs text-gray-700">
                          Auto-classify future payments like this on import
                          <span className="block text-gray-400 mt-0.5">
                            Matches on {tx.counterpartyAccount ? 'account' : tx.variableSymbol ? 'variable symbol' : 'counterparty name'}
                            {tx.variableSymbol && tx.counterpartyAccount ? ' + variable symbol' : ''}.
                          </span>
                        </span>
                      </label>
                      {addToWhitelist && (
                        <div className="space-y-3 pl-6">
                          <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1.5">Rule label</label>
                            <input type="text" value={whitelistLabel} onChange={(e) => setWhitelistLabel(e.target.value)}
                              placeholder="e.g. Rent K201–203"
                              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400" />
                          </div>
                          <label className="flex items-center gap-2.5 cursor-pointer">
                            <input type="checkbox" checked={whitelistFixed}
                              onChange={(e) => setWhitelistFixed(e.target.checked)}
                              className="text-indigo-600" />
                            <span className="text-xs text-gray-700">
                              Only when the amount matches ({formatAmount(tx.amount)}) — leave off for dynamic rent
                            </span>
                          </label>
                        </div>
                      )}
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
            {(tx.state === 'reconciled' || tx.state === 'recurring_cost' || tx.state === 'ignored' || tx.state === 'non_deductible' || tx.state === 'refund' || tx.state === 'partial_refund' || tx.state === 'net_settlement' || tx.state === 'grouped') && (
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

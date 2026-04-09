'use client';
import { useState, useMemo } from 'react';
import type { BankTransaction, BankTransactionState } from '@/types/bankTransaction';
import { IGNORE_CATEGORIES } from '@/types/bankTransaction';
import type { SupplierInvoice } from '@/types/supplierInvoice';
import { formatCurrency, formatDate } from '@/utils/formatters';

type SortCol = 'date' | 'counterparty' | 'amount';
type SortDir = 'asc' | 'desc';

interface Props {
  transactions: BankTransaction[];
  allTransactions: BankTransaction[];
  invoices: SupplierInvoice[];
  onSelect: (tx: BankTransaction) => void;
}

const STATE_BADGE: Record<BankTransactionState, { label: string; className: string }> = {
  unmatched:      { label: 'Unmatched',      className: 'bg-amber-100 text-amber-700'    },
  reconciled:     { label: 'Reconciled',     className: 'bg-green-100 text-green-700'    },
  ignored:        { label: 'Ignored',        className: 'bg-gray-100 text-gray-500'      },
  non_deductible: { label: 'Non-deductible', className: 'bg-rose-100 text-rose-600'      },
  revenue:        { label: 'Revenue',        className: 'bg-indigo-100 text-indigo-600'  },
  refund:         { label: 'Refund',         className: 'bg-teal-100 text-teal-700'      },
  partial_refund: { label: 'Part. refund',   className: 'bg-teal-50 text-teal-600'       },
  net_settlement: { label: 'Net settlement', className: 'bg-cyan-100 text-cyan-700'      },
};

function getRevenueBadgeLabel(tx: { state: string; revenueInvoiceId?: string }): string {
  if (tx.state === 'revenue' && tx.revenueInvoiceId) return 'Revenue (linked)';
  return STATE_BADGE['revenue'].label;
}

function SortIcon({ col, active, dir }: { col: SortCol; active: SortCol; dir: SortDir }) {
  if (col !== active) return <span className="ml-1 text-gray-300">↕</span>;
  return <span className="ml-1 text-indigo-500">{dir === 'asc' ? '↑' : '↓'}</span>;
}

export default function BankTransactionList({ transactions, allTransactions, invoices, onSelect }: Props) {
  const [sortCol, setSortCol] = useState<SortCol>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  function toggleSort(col: SortCol) {
    if (sortCol === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortCol(col); setSortDir('desc'); }
  }

  const sorted = useMemo(() => {
    const arr = [...transactions];
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortCol === 'date')              cmp = a.date.localeCompare(b.date);
      else if (sortCol === 'counterparty') cmp = (a.counterpartyName ?? '').localeCompare(b.counterpartyName ?? '');
      else if (sortCol === 'amount')       cmp = a.amount - b.amount;
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [transactions, sortCol, sortDir]);

  if (sorted.length === 0) {
    return (
      <div className="text-center py-16 text-gray-400 text-sm">
        No transactions match — try adjusting your filters.
      </div>
    );
  }

  const invoiceMap = new Map(invoices.map((inv) => [inv.id, inv]));
  const txMap      = new Map(allTransactions.map((t) => [t.id, t]));

  const thClass = 'px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide select-none cursor-pointer hover:text-gray-700 whitespace-nowrap';

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100">
            <th className={`text-left ${thClass}`} onClick={() => toggleSort('date')}>
              Date <SortIcon col="date" active={sortCol} dir={sortDir} />
            </th>
            <th className={`text-left ${thClass}`} onClick={() => toggleSort('counterparty')}>
              Counterparty <SortIcon col="counterparty" active={sortCol} dir={sortDir} />
            </th>
            <th className={`text-right ${thClass}`} onClick={() => toggleSort('amount')}>
              Amount <SortIcon col="amount" active={sortCol} dir={sortDir} />
            </th>
            <th className={`text-left ${thClass} hidden sm:table-cell`}>VS</th>
            <th className={`text-left ${thClass} hidden md:table-cell`}>Linked to</th>
            <th className={`text-left ${thClass}`}>Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {sorted.map((tx) => {
            const badge = STATE_BADGE[tx.state];
            const linkedInvoice = tx.invoiceId ? invoiceMap.get(tx.invoiceId) : undefined;
            const linkedTx      = tx.linkedTransactionId ? txMap.get(tx.linkedTransactionId) : undefined;
            const ignoreCat     = tx.ignoreCategory
              ? IGNORE_CATEGORIES.find((c) => c.id === tx.ignoreCategory)?.label
              : undefined;

            const isRevenuLinked = tx.state === 'revenue' && !!tx.revenueInvoiceId;
            const revenueBadgeLabel = tx.state === 'revenue' ? getRevenueBadgeLabel(tx) : badge.label;
            const revenueBadgeClass = isRevenuLinked ? 'bg-indigo-200 text-indigo-700' : badge.className;

            return (
              <tr
                key={tx.id}
                onClick={() => onSelect(tx)}
                className="cursor-pointer hover:bg-gray-50 transition-colors"
              >
                <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{formatDate(tx.date)}</td>
                <td className="px-4 py-3 max-w-[200px]">
                  <p className="text-gray-800 truncate">{tx.counterpartyName ?? '—'}</p>
                  {tx.counterpartyAccount && (
                    <p className="text-xs text-gray-400 truncate">{tx.counterpartyAccount}</p>
                  )}
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap font-medium">
                  <span className={tx.direction === 'debit' ? 'text-gray-800' : 'text-green-600'}>
                    {tx.direction === 'debit' ? '−' : '+'}{formatCurrency(tx.amount)}
                  </span>
                  {tx.originalCurrency && tx.originalAmount != null && (
                    <p className="text-xs text-gray-400 mt-0.5">
                      {tx.direction === 'debit' ? '−' : '+'}{tx.originalAmount.toLocaleString('cs-CZ', { style: 'currency', currency: tx.originalCurrency, maximumFractionDigits: 2 })}
                    </p>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">
                  {tx.variableSymbol ?? '—'}
                </td>
                <td className="px-4 py-3 hidden md:table-cell">
                  {tx.state === 'net_settlement' ? (
                    <span className="text-xs text-cyan-700">
                      {(tx.deductedInvoiceIds?.length ?? 0)} fee{(tx.deductedInvoiceIds?.length ?? 0) !== 1 ? 's' : ''} deducted
                      {tx.grossAmount != null && <span className="text-gray-400"> · gross {formatCurrency(tx.grossAmount)}</span>}
                    </span>
                  ) : tx.revenueInvoiceId ? (
                    <span className="text-xs text-indigo-600 font-medium">
                      Revenue invoice linked
                    </span>
                  ) : linkedInvoice ? (
                    <span className="text-xs text-gray-700">
                      {linkedInvoice.invoiceNumber} · {linkedInvoice.supplierName}
                    </span>
                  ) : linkedTx ? (
                    <span className="text-xs text-teal-700">
                      {linkedTx.counterpartyName ?? '—'} · {formatCurrency(linkedTx.amount)}
                    </span>
                  ) : ignoreCat ? (
                    <span className="text-xs text-gray-400">{ignoreCat}{tx.ignoreNote ? ` · ${tx.ignoreNote}` : ''}</span>
                  ) : tx.ignoreNote ? (
                    <span className="text-xs text-gray-400">{tx.ignoreNote}</span>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${tx.state === 'revenue' ? revenueBadgeClass : badge.className}`}>
                    {tx.state === 'revenue' ? revenueBadgeLabel : badge.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

'use client';
import type { BankTransaction, BankTransactionState } from '@/types/bankTransaction';
import { IGNORE_CATEGORIES } from '@/types/bankTransaction';
import type { SupplierInvoice } from '@/types/supplierInvoice';
import { formatCurrency, formatDate } from '@/utils/formatters';

interface Props {
  transactions: BankTransaction[];
  invoices: SupplierInvoice[];
  onSelect: (tx: BankTransaction) => void;
}

const STATE_BADGE: Record<BankTransactionState, { label: string; className: string }> = {
  unmatched: { label: 'Unmatched',   className: 'bg-amber-100 text-amber-700' },
  reconciled:{ label: 'Reconciled',  className: 'bg-green-100 text-green-700' },
  ignored:   { label: 'Ignored',     className: 'bg-gray-100 text-gray-500'   },
  revenue:   { label: 'Revenue',     className: 'bg-indigo-100 text-indigo-600'},
};

export default function BankTransactionList({ transactions, invoices, onSelect }: Props) {
  if (transactions.length === 0) {
    return (
      <div className="text-center py-16 text-gray-400 text-sm">
        No transactions yet — import a CSV statement to get started.
      </div>
    );
  }

  const invoiceMap = new Map(invoices.map((inv) => [inv.id, inv]));

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100">
            <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Date</th>
            <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Counterparty</th>
            <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Amount</th>
            <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide hidden sm:table-cell">VS</th>
            <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide hidden md:table-cell">Linked to</th>
            <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {transactions.map((tx) => {
            const badge = STATE_BADGE[tx.state];
            const linkedInvoice = tx.invoiceId ? invoiceMap.get(tx.invoiceId) : undefined;
            const ignoreCat = tx.ignoreCategory
              ? IGNORE_CATEGORIES.find((c) => c.id === tx.ignoreCategory)?.label
              : undefined;
            const isClickable = tx.direction === 'debit';

            return (
              <tr
                key={tx.id}
                onClick={() => isClickable && onSelect(tx)}
                className={`transition-colors ${isClickable ? 'cursor-pointer hover:bg-gray-50' : 'opacity-70'}`}
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
                </td>
                <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">
                  {tx.variableSymbol ?? '—'}
                </td>
                <td className="px-4 py-3 hidden md:table-cell">
                  {linkedInvoice ? (
                    <span className="text-xs text-gray-700">
                      {linkedInvoice.invoiceNumber} · {linkedInvoice.supplierName}
                    </span>
                  ) : ignoreCat ? (
                    <span className="text-xs text-gray-400">{ignoreCat}{tx.ignoreNote ? ` · ${tx.ignoreNote}` : ''}</span>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${badge.className}`}>
                    {badge.label}
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

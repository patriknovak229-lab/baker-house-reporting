'use client';
import { useMemo, useState } from 'react';
import type { RevenueInvoice, RevenueInvoiceCategory } from '@/types/revenueInvoice';
import type { BankTransaction } from '@/types/bankTransaction';
import { formatCurrency, formatDate } from '@/utils/formatters';

interface Props {
  invoices: RevenueInvoice[];
  transactions: BankTransaction[];
  onSelect: (inv: RevenueInvoice) => void;
  onAddManual: () => void;
}

type SortCol = 'date' | 'amount' | 'client';
type SortDir = 'asc' | 'desc';

const CATEGORY_BADGE: Record<RevenueInvoiceCategory, { label: string; className: string }> = {
  accommodation_direct: { label: 'Accommodation',  className: 'bg-teal-100 text-teal-700'   },
  other_services:       { label: 'Other services', className: 'bg-purple-100 text-purple-700' },
  mistake:              { label: 'Mistake',         className: 'bg-rose-100 text-rose-600'    },
};

const STATUS_BADGE = {
  pending:    { label: 'Pending',    className: 'bg-amber-100 text-amber-700' },
  reconciled: { label: 'Reconciled', className: 'bg-green-100 text-green-700' },
};

function SortIcon({ col, active, dir }: { col: SortCol; active: SortCol; dir: SortDir }) {
  if (col !== active) return <span className="ml-1 text-gray-300">↕</span>;
  return <span className="ml-1 text-indigo-500">{dir === 'asc' ? '↑' : '↓'}</span>;
}

export default function RevenueInvoiceList({ invoices, transactions, onSelect, onAddManual }: Props) {
  const [sortCol, setSortCol] = useState<SortCol>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const txMap = useMemo(() => new Map(transactions.map((t) => [t.id, t])), [transactions]);

  function toggleSort(col: SortCol) {
    if (sortCol === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortCol(col); setSortDir('desc'); }
  }

  const sorted = useMemo(() => {
    const arr = [...invoices];
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortCol === 'date')   cmp = a.invoiceDate.localeCompare(b.invoiceDate);
      if (sortCol === 'amount') cmp = a.amountCZK - b.amountCZK;
      if (sortCol === 'client') {
        const na = (a.guestName ?? a.clientName ?? '').toLowerCase();
        const nb = (b.guestName ?? b.clientName ?? '').toLowerCase();
        cmp = na.localeCompare(nb);
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [invoices, sortCol, sortDir]);

  const thClass = 'px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide select-none cursor-pointer hover:text-gray-700 whitespace-nowrap';

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <p className="text-sm text-gray-500">{invoices.length} invoice{invoices.length !== 1 ? 's' : ''}</p>
        <button
          onClick={onAddManual}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white text-xs font-medium rounded-lg hover:bg-indigo-700"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add manual
        </button>
      </div>

      {sorted.length === 0 ? (
        <div className="text-center py-16 text-gray-400 text-sm">
          No revenue invoices yet. Issued invoices with QR payment will appear here automatically.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className={`text-left ${thClass}`} onClick={() => toggleSort('date')}>
                  Date <SortIcon col="date" active={sortCol} dir={sortDir} />
                </th>
                <th className={`text-left ${thClass} hidden sm:table-cell`}>Invoice #</th>
                <th className={`text-left ${thClass}`} onClick={() => toggleSort('client')}>
                  Client / Guest <SortIcon col="client" active={sortCol} dir={sortDir} />
                </th>
                <th className={`text-left ${thClass} hidden md:table-cell`}>Category</th>
                <th className={`text-right ${thClass}`} onClick={() => toggleSort('amount')}>
                  Amount <SortIcon col="amount" active={sortCol} dir={sortDir} />
                </th>
                <th className={`text-left ${thClass} hidden lg:table-cell`}>Linked bank tx</th>
                <th className={`text-left ${thClass}`}>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {sorted.map((inv) => {
                const catBadge    = CATEGORY_BADGE[inv.category];
                const statusBadge = STATUS_BADGE[inv.status];
                const linkedTx    = inv.bankTransactionId ? txMap.get(inv.bankTransactionId) : undefined;
                const clientLabel = inv.guestName ?? inv.clientName ?? '—';

                return (
                  <tr
                    key={inv.id}
                    onClick={() => onSelect(inv)}
                    className="cursor-pointer hover:bg-gray-50 transition-colors"
                  >
                    <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{formatDate(inv.invoiceDate)}</td>
                    <td className="px-4 py-3 text-gray-700 hidden sm:table-cell font-mono text-xs">{inv.invoiceNumber}</td>
                    <td className="px-4 py-3 max-w-[180px]">
                      <p className="text-gray-800 truncate">{clientLabel}</p>
                      {inv.reservationNumber && (
                        <p className="text-xs text-gray-400">#{inv.reservationNumber}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${catBadge.className}`}>
                        {catBadge.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-800 whitespace-nowrap">
                      {formatCurrency(inv.amountCZK)}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      {linkedTx ? (
                        <span className="text-xs text-green-700">
                          {formatDate(linkedTx.date)} · +{formatCurrency(linkedTx.amount)}
                        </span>
                      ) : (
                        <span className="text-gray-300 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusBadge.className}`}>
                        {statusBadge.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

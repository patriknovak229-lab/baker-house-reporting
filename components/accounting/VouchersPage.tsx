'use client';
import { useState, useEffect, useMemo } from 'react';
import type { Voucher, VoucherStatus } from '@/types/voucher';
import { formatCurrency } from '@/utils/formatters';

const STATUS_CONFIG: Record<VoucherStatus, { label: string; className: string }> = {
  issued:  { label: 'Issued',  className: 'bg-purple-100 text-purple-700' },
  used:    { label: 'Used',    className: 'bg-green-100 text-green-700' },
  deleted: { label: 'Deleted', className: 'bg-gray-100 text-gray-500' },
};

export default function VouchersPage() {
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'all' | VoucherStatus>('all');
  const [search, setSearch] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  async function fetchVouchers() {
    try {
      const res = await fetch('/api/vouchers');
      if (res.ok) {
        const data = await res.json();
        setVouchers(data);
      }
    } catch {
      // fail silently
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchVouchers(); }, []);

  const filtered = useMemo(() => {
    return vouchers
      .filter((v) => statusFilter === 'all' || v.status === statusFilter)
      .filter((v) => {
        if (!search.trim()) return true;
        const q = search.toLowerCase();
        return (
          v.code.toLowerCase().includes(q) ||
          (v.guestName ?? '').toLowerCase().includes(q) ||
          (v.reservationNumber ?? '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [vouchers, statusFilter, search]);

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/vouchers/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setVouchers((prev) =>
          prev.map((v) => (v.id === id ? { ...v, status: 'deleted' as const } : v))
        );
      }
    } catch {
      // fail silently
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  }

  const counts = useMemo(() => ({
    all: vouchers.length,
    issued: vouchers.filter((v) => v.status === 'issued').length,
    used: vouchers.filter((v) => v.status === 'used').length,
    deleted: vouchers.filter((v) => v.status === 'deleted').length,
  }), [vouchers]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-purple-300 border-t-purple-600 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Vouchers</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {counts.issued} active · {counts.used} used · {counts.all} total
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex items-center gap-1 p-1 bg-gray-100 rounded-lg">
          {(['all', 'issued', 'used', 'deleted'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                statusFilter === s
                  ? 'bg-white shadow-sm text-gray-900'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
              <span className="ml-1 text-gray-400">
                {counts[s]}
              </span>
            </button>
          ))}
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search code, guest, reservation…"
          className="px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-purple-300 w-full sm:w-64"
        />
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="text-center py-12 text-sm text-gray-400">
          {vouchers.length === 0 ? 'No vouchers yet' : 'No vouchers match your filters'}
        </div>
      ) : (
        <div className="border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Code</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Discount</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide hidden sm:table-cell">Guest</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide hidden md:table-cell">Reservation</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Status</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide hidden md:table-cell">Created</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide hidden lg:table-cell">Expires</th>
                <th className="px-4 py-3 w-16" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((v) => {
                const isExpired = v.status === 'issued' && v.expiresAt < new Date().toISOString().slice(0, 10);
                return (
                  <tr key={v.id} className={`hover:bg-gray-50 transition-colors ${v.status === 'deleted' ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-3">
                      <span className="font-mono font-semibold text-purple-700">{v.code}</span>
                    </td>
                    <td className="px-4 py-3">
                      {v.discountType === 'percentage'
                        ? <span>{v.value}%</span>
                        : <span>{formatCurrency(v.value)}</span>}
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell text-gray-600">
                      {v.guestName || '—'}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell text-gray-500 font-mono text-xs">
                      {v.reservationNumber || '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${STATUS_CONFIG[v.status].className}`}>
                        {STATUS_CONFIG[v.status].label}
                      </span>
                      {isExpired && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 text-amber-700 ml-1">
                          Expired
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell text-gray-500 text-xs">
                      {new Date(v.createdAt).toLocaleDateString('cs-CZ')}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell text-gray-500 text-xs">
                      {v.expiresAt}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {v.status === 'issued' && (
                        confirmDeleteId === v.id ? (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleDelete(v.id)}
                              disabled={deletingId === v.id}
                              className="text-[11px] text-red-600 hover:text-red-800 font-medium"
                            >
                              {deletingId === v.id ? '…' : 'Confirm'}
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(null)}
                              className="text-[11px] text-gray-400 hover:text-gray-600"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmDeleteId(v.id)}
                            title="Delete voucher"
                            className="text-gray-300 hover:text-red-500 transition-colors"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        )
                      )}
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

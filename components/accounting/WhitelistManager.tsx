'use client';
import { useState, useEffect, useCallback } from 'react';
import type { WhitelistedSupplier } from '@/types/supplierInvoice';
import { useCategories } from './useCategories';

export default function WhitelistManager({ onClose }: { onClose: () => void }) {
  const { categories } = useCategories();
  const [whitelist, setWhitelist] = useState<WhitelistedSupplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [supplierName, setSupplierName] = useState('');
  const [category, setCategory] = useState('other');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/supplier-invoices/whitelist');
      if (res.ok) setWhitelist(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Set default category once categories load
  useEffect(() => {
    if (categories.length > 0) setCategory(categories[0].id);
  }, [categories]);

  async function handleAdd() {
    if (!supplierName.trim()) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch('/api/supplier-invoices/whitelist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplierName: supplierName.trim(), category }),
      });
      if (res.ok) {
        const entry = await res.json() as WhitelistedSupplier;
        setWhitelist((prev) => [...prev, entry]);
        setSupplierName('');
      } else {
        const data = await res.json() as { error?: string };
        setError(data.error ?? 'Failed to add supplier.');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(id: string) {
    try {
      const res = await fetch('/api/supplier-invoices/whitelist', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (res.ok) setWhitelist((prev) => prev.filter((s) => s.id !== id));
    } catch { /* non-fatal */ }
  }

  const categoryLabel = (id: string) => {
    return categories.find((c) => c.id === id)?.label ?? id;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-800">Supplier Whitelist</h2>
            <p className="text-xs text-gray-400 mt-0.5">Invoices from these suppliers are auto-processed without review</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-4">×</button>
        </div>

        {/* Add new */}
        <div className="px-6 pt-4 pb-3 space-y-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={supplierName}
              onChange={(e) => setSupplierName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              placeholder="Supplier name (must match exactly)"
              className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
          </div>
          <div className="flex gap-2">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
            <button
              onClick={handleAdd}
              disabled={adding || !supplierName.trim()}
              className="px-4 py-1.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-40 whitespace-nowrap"
            >
              Add
            </button>
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <p className="text-xs text-gray-400">
            The name is matched case-insensitively against the supplier name extracted by Claude.
          </p>
        </div>

        {/* List */}
        <div className="px-6 pb-4">
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {loading && (
              <div className="flex justify-center py-6">
                <div className="w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
              </div>
            )}
            {!loading && whitelist.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-6">No suppliers whitelisted yet.</p>
            )}
            {!loading && whitelist.map((s) => (
              <div key={s.id} className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-lg">
                <div>
                  <p className="text-sm font-medium text-gray-800">{s.supplierName}</p>
                  <p className="text-xs text-gray-400">{categoryLabel(s.category)}</p>
                </div>
                <button
                  onClick={() => handleRemove(s.id)}
                  className="text-gray-300 hover:text-red-500 text-lg leading-none ml-2 flex-shrink-0"
                  title="Remove from whitelist"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="px-6 py-3 border-t border-gray-100">
          <button
            onClick={onClose}
            className="w-full py-2 text-sm text-gray-600 hover:text-gray-800 font-medium"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

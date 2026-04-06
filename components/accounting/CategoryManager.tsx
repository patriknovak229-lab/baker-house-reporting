'use client';
import { useState } from 'react';
import { useCategories } from './useCategories';

export default function CategoryManager({ onClose }: { onClose: () => void }) {
  const { categories, addCategory, removeCategory } = useCategories();
  const [newLabel, setNewLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd() {
    if (!newLabel.trim()) return;
    setAdding(true);
    setError(null);
    const ok = await addCategory(newLabel.trim());
    if (ok) {
      setNewLabel('');
    } else {
      setError('Category already exists or is invalid.');
    }
    setAdding(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-800">Manage Categories</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-3">
          {/* Add new */}
          <div className="flex gap-2">
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              placeholder="New category name…"
              className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
            <button
              onClick={handleAdd}
              disabled={adding || !newLabel.trim()}
              className="px-3 py-1.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-40"
            >
              Add
            </button>
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}

          {/* List */}
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {categories.map((cat) => (
              <div
                key={cat.id}
                className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-lg"
              >
                <span className="text-sm text-gray-700">{cat.label}</span>
                <button
                  onClick={() => removeCategory(cat.id)}
                  className="text-gray-300 hover:text-red-500 text-lg leading-none ml-2"
                  title="Remove"
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

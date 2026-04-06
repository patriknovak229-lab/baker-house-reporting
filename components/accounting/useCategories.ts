'use client';
import { useState, useEffect } from 'react';
import type { InvoiceCategory } from '@/types/supplierInvoice';

const DEFAULT_CATEGORIES: InvoiceCategory[] = [
  { id: 'cleaning', label: 'Cleaning' },
  { id: 'laundry', label: 'Laundry' },
  { id: 'consumables', label: 'Consumables' },
  { id: 'utilities', label: 'Utilities' },
  { id: 'software', label: 'Software' },
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'other', label: 'Other' },
];

export function useCategories() {
  const [categories, setCategories] = useState<InvoiceCategory[]>(DEFAULT_CATEGORIES);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const res = await fetch('/api/supplier-invoices/categories');
      if (res.ok) setCategories(await res.json());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function addCategory(label: string): Promise<boolean> {
    const res = await fetch('/api/supplier-invoices/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    });
    if (res.ok) {
      await load();
      return true;
    }
    return false;
  }

  async function removeCategory(id: string): Promise<void> {
    await fetch('/api/supplier-invoices/categories', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    await load();
  }

  return { categories, loading, addCategory, removeCategory, reload: load };
}

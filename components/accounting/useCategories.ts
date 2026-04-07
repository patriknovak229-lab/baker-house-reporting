'use client';
import { useState, useEffect } from 'react';
import type { InvoiceCategory } from '@/types/supplierInvoice';

const DEFAULT_CATEGORIES: InvoiceCategory[] = [
  { id: 'cleaning',    label: 'Cleaning',    color: '#DBEAFE' },
  { id: 'laundry',     label: 'Laundry',     color: '#EDE9FE' },
  { id: 'consumables', label: 'Consumables', color: '#DCFCE7' },
  { id: 'utilities',   label: 'Utilities',   color: '#FEF9C3' },
  { id: 'software',    label: 'Software',    color: '#CFFAFE' },
  { id: 'maintenance', label: 'Maintenance', color: '#FFEDD5' },
  { id: 'other',       label: 'Other',       color: '#F3F4F6' },
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

  async function addCategory(label: string, color?: string): Promise<boolean> {
    const res = await fetch('/api/supplier-invoices/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, color }),
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

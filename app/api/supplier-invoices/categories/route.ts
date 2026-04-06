import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { InvoiceCategory } from '@/types/supplierInvoice';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const REDIS_KEY = 'baker:invoice-categories';

const DEFAULT_CATEGORIES: InvoiceCategory[] = [
  { id: 'cleaning', label: 'Cleaning' },
  { id: 'laundry', label: 'Laundry' },
  { id: 'consumables', label: 'Consumables' },
  { id: 'utilities', label: 'Utilities' },
  { id: 'software', label: 'Software' },
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'other', label: 'Other' },
];

async function getCategories(): Promise<InvoiceCategory[]> {
  const stored = await redis.get<InvoiceCategory[]>(REDIS_KEY);
  if (stored && stored.length > 0) return stored;
  // Seed defaults on first access
  await redis.set(REDIS_KEY, DEFAULT_CATEGORIES);
  return DEFAULT_CATEGORIES;
}

// GET — list all categories (admin + accountant)
export async function GET() {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;
  const categories = await getCategories();
  return NextResponse.json(categories);
}

// POST — create a new category (admin only)
export async function POST(request: Request) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const { label } = await request.json() as { label?: string };
  if (!label?.trim()) {
    return NextResponse.json({ error: 'Label is required' }, { status: 400 });
  }

  const categories = await getCategories();
  const id = label.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

  if (categories.some((c) => c.id === id)) {
    return NextResponse.json({ error: 'Category already exists' }, { status: 409 });
  }

  const newCategory: InvoiceCategory = { id, label: label.trim() };
  const updated = [...categories, newCategory];
  await redis.set(REDIS_KEY, updated);
  return NextResponse.json(newCategory, { status: 201 });
}

// DELETE — remove a category by id (admin only)
export async function DELETE(request: Request) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const { id } = await request.json() as { id?: string };
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const categories = await getCategories();
  const updated = categories.filter((c) => c.id !== id);
  await redis.set(REDIS_KEY, updated);
  return NextResponse.json({ ok: true });
}

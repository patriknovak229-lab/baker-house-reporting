import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { InvoiceCategory } from '@/types/supplierInvoice';
import { paletteColorAt } from '@/utils/categoryColors';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const REDIS_KEY = 'baker:invoice-categories';

const DEFAULT_CATEGORIES: InvoiceCategory[] = [
  { id: 'cleaning',    label: 'Cleaning',    color: '#DBEAFE' }, // blue
  { id: 'laundry',     label: 'Laundry',     color: '#EDE9FE' }, // violet
  { id: 'consumables', label: 'Consumables', color: '#DCFCE7' }, // green
  { id: 'utilities',   label: 'Utilities',   color: '#FEF9C3' }, // yellow
  { id: 'software',    label: 'Software',    color: '#CFFAFE' }, // cyan
  { id: 'maintenance', label: 'Maintenance', color: '#FFEDD5' }, // orange
  { id: 'other',       label: 'Other',       color: '#F3F4F6' }, // gray
];

async function getCategories(): Promise<InvoiceCategory[]> {
  const stored = await redis.get<InvoiceCategory[]>(REDIS_KEY);
  if (!stored || stored.length === 0) {
    await redis.set(REDIS_KEY, DEFAULT_CATEGORIES);
    return DEFAULT_CATEGORIES;
  }
  // Migrate any stored entries that are missing a colour (zero-downtime)
  const needsMigration = stored.some((c) => !c.color);
  if (needsMigration) {
    const migrated = stored.map((c, i) => ({
      ...c,
      color: c.color ?? paletteColorAt(i).bg,
    }));
    await redis.set(REDIS_KEY, migrated);
    return migrated;
  }
  return stored;
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

  const { label, color } = await request.json() as { label?: string; color?: string };
  if (!label?.trim()) {
    return NextResponse.json({ error: 'Label is required' }, { status: 400 });
  }

  const categories = await getCategories();
  const id = label.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

  if (categories.some((c) => c.id === id)) {
    return NextResponse.json({ error: 'Category already exists' }, { status: 409 });
  }

  // Auto-assign next palette colour if none supplied
  const assignedColor = color ?? paletteColorAt(categories.length).bg;
  const newCategory: InvoiceCategory = { id, label: label.trim(), color: assignedColor };
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

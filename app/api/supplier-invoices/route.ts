import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { SupplierInvoice } from '@/types/supplierInvoice';

const KEY = 'baker:supplier-invoices';

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function GET() {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  const raw = await redis.get(KEY);
  const invoices = (Array.isArray(raw) ? raw : []) as SupplierInvoice[];

  // Return sorted newest first
  invoices.sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate));

  return NextResponse.json(invoices);
}

export async function POST(request: Request) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  const body = await request.json() as SupplierInvoice & { force?: boolean };
  if (!body.id || !body.supplierName || !body.invoiceNumber) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const raw = await redis.get(KEY);
  const invoices = (Array.isArray(raw) ? raw : []) as SupplierInvoice[];

  // Duplicate check (skipped when force === true or when updating an existing invoice by same id)
  if (!body.force) {
    const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ');
    const dup = invoices.find(
      (i) => i.id !== body.id &&
             norm(i.invoiceNumber) === norm(body.invoiceNumber) &&
             norm(i.supplierName)  === norm(body.supplierName),
    );
    if (dup) return NextResponse.json({ code: 'duplicate', existing: dup }, { status: 409 });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { force: _force, ...invoiceBody } = body;
  invoices.push(invoiceBody as SupplierInvoice);
  await redis.set(KEY, invoices);

  return NextResponse.json(invoiceBody, { status: 201 });
}

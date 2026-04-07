import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { BankTransaction, IgnoreCategoryId } from '@/types/bankTransaction';
import type { SupplierInvoice } from '@/types/supplierInvoice';

const TX_KEY = 'baker:bank-transactions';
const INV_KEY = 'baker:supplier-invoices';

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

type ReconcileBody   = { action: 'reconcile'; invoiceId: string };
type IgnoreBody      = { action: 'ignore'; ignoreCategory: IgnoreCategoryId; ignoreNote?: string };
type UnmatchBody     = { action: 'unmatch' };
type NoteBody        = { action: 'note'; note: string };
type PutBody = ReconcileBody | IgnoreBody | UnmatchBody | NoteBody;

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const { id } = await params;
  const body = await request.json() as PutBody;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  const [rawTx, rawInv] = await Promise.all([
    redis.get(TX_KEY),
    redis.get(INV_KEY),
  ]);

  const transactions = (Array.isArray(rawTx) ? rawTx : []) as BankTransaction[];
  const invoices     = (Array.isArray(rawInv) ? rawInv : []) as SupplierInvoice[];

  const txIdx = transactions.findIndex((t) => t.id === id);
  if (txIdx === -1) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });

  const tx = { ...transactions[txIdx] };
  const now = new Date().toISOString();

  if (body.action === 'reconcile') {
    const invIdx = invoices.findIndex((i) => i.id === body.invoiceId);
    if (invIdx === -1) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

    // Un-link any previously matched invoice
    if (tx.invoiceId && tx.invoiceId !== body.invoiceId) {
      const prevIdx = invoices.findIndex((i) => i.id === tx.invoiceId);
      if (prevIdx !== -1) {
        invoices[prevIdx] = {
          ...invoices[prevIdx],
          status: 'pending',
          bankTransactionId: undefined,
          reconciledAt: undefined,
        };
      }
    }

    tx.state = 'reconciled';
    tx.invoiceId = body.invoiceId;
    tx.ignoreCategory = undefined;
    tx.ignoreNote = undefined;
    tx.ignoredAt = undefined;
    tx.reconciledAt = now;

    invoices[invIdx] = {
      ...invoices[invIdx],
      status: 'reconciled',
      bankTransactionId: id,
      reconciledAt: now,
    };

  } else if (body.action === 'ignore') {
    // Un-link any previously matched invoice
    if (tx.invoiceId) {
      const prevIdx = invoices.findIndex((i) => i.id === tx.invoiceId);
      if (prevIdx !== -1) {
        invoices[prevIdx] = {
          ...invoices[prevIdx],
          status: 'pending',
          bankTransactionId: undefined,
          reconciledAt: undefined,
        };
      }
    }

    tx.state = 'ignored';
    tx.invoiceId = undefined;
    tx.reconciledAt = undefined;
    tx.ignoreCategory = body.ignoreCategory;
    tx.ignoreNote = body.ignoreNote || undefined;
    tx.ignoredAt = now;

  } else if (body.action === 'note') {
    tx.ignoreNote = body.note || undefined;

  } else if (body.action === 'unmatch') {
    if (tx.invoiceId) {
      const prevIdx = invoices.findIndex((i) => i.id === tx.invoiceId);
      if (prevIdx !== -1) {
        invoices[prevIdx] = {
          ...invoices[prevIdx],
          status: 'pending',
          bankTransactionId: undefined,
          reconciledAt: undefined,
        };
      }
    }

    tx.state = 'unmatched';
    tx.invoiceId = undefined;
    tx.reconciledAt = undefined;
    tx.ignoreCategory = undefined;
    tx.ignoreNote = undefined;
    tx.ignoredAt = undefined;
  }

  transactions[txIdx] = tx;

  await Promise.all([
    redis.set(TX_KEY, transactions),
    redis.set(INV_KEY, invoices),
  ]);

  return NextResponse.json(tx);
}

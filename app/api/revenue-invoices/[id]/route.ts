import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { RevenueInvoice, RevenueInvoiceCategory } from '@/types/revenueInvoice';
import type { BankTransaction } from '@/types/bankTransaction';

const REV_KEY = 'baker:revenue-invoices';
const TX_KEY  = 'baker:bank-transactions';

function getRedis(): Redis | null {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

type ActionBody =
  | { action: 'update_category'; category: RevenueInvoiceCategory }
  | { action: 'link_bank'; bankTransactionId: string }
  | { action: 'unlink' };

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  const { id } = await params;
  const body = await request.json() as ActionBody;

  const [rawRev, rawTx] = await Promise.all([redis.get(REV_KEY), redis.get(TX_KEY)]);
  const invoices     = (Array.isArray(rawRev) ? rawRev : []) as RevenueInvoice[];
  const transactions = (Array.isArray(rawTx)  ? rawTx  : []) as BankTransaction[];

  const invIdx = invoices.findIndex((i) => i.id === id);
  if (invIdx === -1) return NextResponse.json({ error: 'Revenue invoice not found' }, { status: 404 });

  const now = new Date().toISOString();
  const inv = invoices[invIdx];

  if (body.action === 'update_category') {
    invoices[invIdx] = { ...inv, category: body.category };
    await redis.set(REV_KEY, invoices);
    return NextResponse.json(invoices[invIdx]);
  }

  if (body.action === 'link_bank') {
    const txIdx = transactions.findIndex((t) => t.id === body.bankTransactionId);
    if (txIdx === -1) return NextResponse.json({ error: 'Bank transaction not found' }, { status: 404 });

    // Clear old link if invoice was previously linked to a different tx
    if (inv.bankTransactionId && inv.bankTransactionId !== body.bankTransactionId) {
      const oldTxIdx = transactions.findIndex((t) => t.id === inv.bankTransactionId);
      if (oldTxIdx !== -1) {
        transactions[oldTxIdx] = { ...transactions[oldTxIdx], revenueInvoiceId: undefined };
      }
    }

    invoices[invIdx] = {
      ...inv,
      status: 'reconciled',
      bankTransactionId: body.bankTransactionId,
      reconciledAt: now,
    };

    transactions[txIdx] = {
      ...transactions[txIdx],
      revenueInvoiceId: id,
    };

    await Promise.all([redis.set(REV_KEY, invoices), redis.set(TX_KEY, transactions)]);
    return NextResponse.json({ invoice: invoices[invIdx], transaction: transactions[txIdx] });
  }

  if (body.action === 'unlink') {
    // Clear link on bank transaction
    if (inv.bankTransactionId) {
      const txIdx = transactions.findIndex((t) => t.id === inv.bankTransactionId);
      if (txIdx !== -1) {
        transactions[txIdx] = { ...transactions[txIdx], revenueInvoiceId: undefined };
      }
    }

    invoices[invIdx] = {
      ...inv,
      status: 'pending',
      bankTransactionId: undefined,
      reconciledAt: undefined,
    };

    await Promise.all([redis.set(REV_KEY, invoices), redis.set(TX_KEY, transactions)]);
    return NextResponse.json({ invoice: invoices[invIdx] });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

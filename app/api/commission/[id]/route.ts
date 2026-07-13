import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { CommissionSettlement } from '@/types/commissionSettlement';
import type { BankTransaction } from '@/types/bankTransaction';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const KEY = 'baker:commission-settlements';
const TX_KEY = 'baker:bank-transactions';

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

type ActionBody =
  | { action: 'link_bank'; bankTransactionId: string }
  | { action: 'unlink' };

// PUT /api/commission/[id] — link/unlink the owner payout bank transaction.
// The link is a record-keeping marker only: it does NOT change the bank
// transaction's `state` or its P&L treatment.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireRole(['admin', 'super', 'accountant']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  const { id } = await params;
  const body = (await request.json()) as ActionBody;

  const [rawS, rawTx] = await Promise.all([redis.get(KEY), redis.get(TX_KEY)]);
  const settlements = (Array.isArray(rawS) ? rawS : []) as CommissionSettlement[];
  const transactions = (Array.isArray(rawTx) ? rawTx : []) as BankTransaction[];

  const idx = settlements.findIndex((s) => s.id === id);
  if (idx === -1) return NextResponse.json({ error: 'Settlement not found' }, { status: 404 });

  const now = new Date().toISOString();
  const s = settlements[idx];

  if (body.action === 'link_bank') {
    const txIdx = transactions.findIndex((t) => t.id === body.bankTransactionId);
    if (txIdx === -1) return NextResponse.json({ error: 'Bank transaction not found' }, { status: 404 });

    // Clear a prior link if this settlement pointed at a different tx
    if (s.bankTransactionId && s.bankTransactionId !== body.bankTransactionId) {
      const oldIdx = transactions.findIndex((t) => t.id === s.bankTransactionId);
      if (oldIdx !== -1) {
        transactions[oldIdx] = { ...transactions[oldIdx], commissionSettlementId: undefined };
      }
    }

    settlements[idx] = { ...s, status: 'reconciled', bankTransactionId: body.bankTransactionId, reconciledAt: now };
    transactions[txIdx] = { ...transactions[txIdx], commissionSettlementId: id };

    await Promise.all([redis.set(KEY, settlements), redis.set(TX_KEY, transactions)]);
    return NextResponse.json({ settlement: settlements[idx], transaction: transactions[txIdx] });
  }

  if (body.action === 'unlink') {
    if (s.bankTransactionId) {
      const txIdx = transactions.findIndex((t) => t.id === s.bankTransactionId);
      if (txIdx !== -1) {
        transactions[txIdx] = { ...transactions[txIdx], commissionSettlementId: undefined };
      }
    }
    settlements[idx] = { ...s, status: 'issued', bankTransactionId: undefined, reconciledAt: undefined };
    await Promise.all([redis.set(KEY, settlements), redis.set(TX_KEY, transactions)]);
    return NextResponse.json({ settlement: settlements[idx] });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

// DELETE /api/commission/[id] — remove a settlement and clear any bank link.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireRole(['admin', 'super', 'accountant']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  const { id } = await params;
  const [rawS, rawTx] = await Promise.all([redis.get(KEY), redis.get(TX_KEY)]);
  const settlements = (Array.isArray(rawS) ? rawS : []) as CommissionSettlement[];
  const transactions = (Array.isArray(rawTx) ? rawTx : []) as BankTransaction[];

  const s = settlements.find((x) => x.id === id);
  if (!s) return NextResponse.json({ error: 'Settlement not found' }, { status: 404 });

  const nextSettlements = settlements.filter((x) => x.id !== id);
  let txChanged = false;
  if (s.bankTransactionId) {
    const txIdx = transactions.findIndex((t) => t.id === s.bankTransactionId);
    if (txIdx !== -1) {
      transactions[txIdx] = { ...transactions[txIdx], commissionSettlementId: undefined };
      txChanged = true;
    }
  }

  await Promise.all([
    redis.set(KEY, nextSettlements),
    txChanged ? redis.set(TX_KEY, transactions) : Promise.resolve(),
  ]);
  return NextResponse.json({ ok: true });
}

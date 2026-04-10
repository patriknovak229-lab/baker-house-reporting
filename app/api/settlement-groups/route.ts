import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { SettlementGroup } from '@/types/settlementGroup';
import type { BankTransaction } from '@/types/bankTransaction';

const GROUPS_KEY = 'baker:settlement-groups';
const TX_KEY     = 'baker:bank-transactions';

function getRedis(): Redis | null {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

// GET /api/settlement-groups — return all groups sorted newest first
export async function GET() {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  const groups = (await redis.get<SettlementGroup[]>(GROUPS_KEY)) ?? [];
  groups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return NextResponse.json(groups);
}

// POST /api/settlement-groups — create a new group with the first transaction
export async function POST(request: Request) {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  const body = await request.json() as { name: string; transactionId: string };
  if (!body.name?.trim()) return NextResponse.json({ error: 'name is required' }, { status: 400 });
  if (!body.transactionId) return NextResponse.json({ error: 'transactionId is required' }, { status: 400 });

  // Create the group
  const group: SettlementGroup = {
    id:             crypto.randomUUID(),
    name:           body.name.trim(),
    transactionIds: [body.transactionId],
    invoiceIds:     [],
    createdAt:      new Date().toISOString(),
  };

  // Update the transaction — state → 'grouped', settlementGroupId set
  const txs = (await redis.get<BankTransaction[]>(TX_KEY)) ?? [];
  const updatedTxs = txs.map((t) =>
    t.id === body.transactionId
      ? { ...t, state: 'grouped' as const, settlementGroupId: group.id }
      : t,
  );
  const updatedTx = updatedTxs.find((t) => t.id === body.transactionId) ?? null;

  // Persist group and updated transactions atomically
  const groups = (await redis.get<SettlementGroup[]>(GROUPS_KEY)) ?? [];
  groups.push(group);
  await Promise.all([
    redis.set(GROUPS_KEY, groups),
    redis.set(TX_KEY, updatedTxs),
  ]);

  return NextResponse.json({ group, transaction: updatedTx }, { status: 201 });
}

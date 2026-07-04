import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { BankCostRule } from '@/types/bankCostWhitelist';
import { BANK_COST_WHITELIST_KEY, ruleHasIdentity } from '@/types/bankCostWhitelist';

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

async function loadRules(redis: Redis): Promise<BankCostRule[]> {
  const raw = await redis.get(BANK_COST_WHITELIST_KEY);
  return (Array.isArray(raw) ? raw : []) as BankCostRule[];
}

export async function GET() {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  return NextResponse.json(await loadRules(redis));
}

export async function POST(request: Request) {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  const body = await request.json() as Partial<BankCostRule>;
  if (!ruleHasIdentity(body)) {
    return NextResponse.json({ error: 'Rule needs at least one of: account, variable symbol, or name' }, { status: 400 });
  }
  if (!body.costCategory) {
    return NextResponse.json({ error: 'costCategory is required' }, { status: 400 });
  }

  const rule: BankCostRule = {
    id: `costrule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label: body.label?.trim() || 'Recurring cost',
    costCategory: body.costCategory,
    counterpartyAccount: body.counterpartyAccount?.trim() || undefined,
    variableSymbol: body.variableSymbol?.trim() || undefined,
    counterpartyNameContains: body.counterpartyNameContains?.trim() || undefined,
    amount: typeof body.amount === 'number' ? body.amount : undefined,
    createdAt: new Date().toISOString(),
  };

  const rules = await loadRules(redis);
  rules.push(rule);
  await redis.set(BANK_COST_WHITELIST_KEY, rules);

  return NextResponse.json(rule, { status: 201 });
}

export async function DELETE(request: Request) {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id query param required' }, { status: 400 });

  const rules = await loadRules(redis);
  const next = rules.filter((r) => r.id !== id);
  await redis.set(BANK_COST_WHITELIST_KEY, next);

  return NextResponse.json({ deleted: rules.length - next.length });
}

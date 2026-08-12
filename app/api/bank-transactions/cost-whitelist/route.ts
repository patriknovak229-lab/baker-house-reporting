import { NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import type { BankCostRule } from '@/types/bankCostWhitelist';
import { ruleHasIdentity } from '@/types/bankCostWhitelist';
import { readAllBankCostWhitelist, writeAllBankCostWhitelist } from '@/utils/bankCostWhitelistStore';

export async function GET() {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  return NextResponse.json(await readAllBankCostWhitelist());
}

export async function POST(request: Request) {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

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

  const rules = await readAllBankCostWhitelist();
  rules.push(rule);
  await writeAllBankCostWhitelist(rules);

  return NextResponse.json(rule, { status: 201 });
}

export async function DELETE(request: Request) {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id query param required' }, { status: 400 });

  const rules = await readAllBankCostWhitelist();
  const next = rules.filter((r) => r.id !== id);
  await writeAllBankCostWhitelist(next);

  return NextResponse.json({ deleted: rules.length - next.length });
}

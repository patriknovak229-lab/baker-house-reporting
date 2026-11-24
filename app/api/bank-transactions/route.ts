import { NextResponse } from 'next/server';
import { requireAccess } from '@/utils/authGuard';
import { readAllBankTransactions } from '@/utils/bankTransactionsStore';

export async function GET() {
  const guard = await requireAccess('accounting', 'view');
  if ('error' in guard) return guard.error;

  const transactions = await readAllBankTransactions();
  transactions.sort((a, b) => b.date.localeCompare(a.date));
  return NextResponse.json(transactions);
}

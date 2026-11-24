import { NextResponse } from 'next/server';
import { requireAccess } from '@/utils/authGuard';
import { readAllAdditionalPayments } from '@/utils/additionalPaymentsStore';

export async function GET() {
  const guard = await requireAccess('transactions', 'view');
  if ('error' in guard) return guard.error;

  const payments = await readAllAdditionalPayments();
  return NextResponse.json(payments);
}

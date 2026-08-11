import { NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { readAllAdditionalPayments } from '@/utils/additionalPaymentsStore';

export async function GET() {
  const guard = await requireRole(['admin', 'super', 'viewer', 'accountant']);
  if ('error' in guard) return guard.error;

  const payments = await readAllAdditionalPayments();
  return NextResponse.json(payments);
}

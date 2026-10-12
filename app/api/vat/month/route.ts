import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { loadVatData, monthResult } from '@/utils/vat/loadInputs';
import { isValidMonth } from '@/utils/vat/czechCalendar';

// GET /api/vat/month?month=YYYY-MM — the VAT return + control statement for one month, with flags.
export async function GET(req: NextRequest) {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const month = new URL(req.url).searchParams.get('month');
  if (!isValidMonth(month)) return NextResponse.json({ error: 'month=YYYY-MM is required' }, { status: 400 });

  try {
    const data = await loadVatData();
    return NextResponse.json({ result: monthResult(data, month), settings: data.settings });
  } catch (err) {
    console.error('[vat/month]', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'VAT computation failed' }, { status: 500 });
  }
}

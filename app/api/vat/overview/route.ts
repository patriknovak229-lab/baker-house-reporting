import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { loadVatData, overview } from '@/utils/vat/loadInputs';

// GET /api/vat/overview?year=YYYY — per-month VAT summary + the registration-threshold tracker.
export async function GET(req: NextRequest) {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const year = Number(new URL(req.url).searchParams.get('year'));
  if (!Number.isInteger(year) || year < 2023 || year > 2100) {
    return NextResponse.json({ error: 'year=YYYY is required' }, { status: 400 });
  }

  try {
    const data = await loadVatData();
    return NextResponse.json(overview(data, year));
  } catch (err) {
    console.error('[vat/overview]', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'VAT overview failed' }, { status: 500 });
  }
}

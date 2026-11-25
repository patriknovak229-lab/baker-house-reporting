/**
 * POST /api/corporate/invoices/preview — what invoices over these ranges would
 * bill right now, without saving anything.
 *
 * Body: { agreementId, ranges: [{ from: first night, to: last night }] }
 * → { previews: InvoicePreview[] } in the same order, plus `verified` (false
 *   when Beds24 couldn't be read and the lines come from the agreement only).
 *
 * One Beds24 read for all ranges, so the monthly form can preview a whole
 * schedule in one call. Auth: corporate view.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAccess } from '@/utils/authGuard';
import { getAgreementDetail } from '@/data-access/corporate';
import { isValidRange } from '@/utils/corporateInvoice';
import { loadReservationsByNumber, previewFromData } from '@/utils/corporateInvoiceService';
import { optStr } from '@/utils/corporateInput';

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const guard = await requireAccess('corporate', 'view');
  if ('error' in guard) return guard.error;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const agreementId = optStr(body.agreementId, 40);
  if (!agreementId) return NextResponse.json({ error: 'agreementId is required' }, { status: 400 });
  if (!Array.isArray(body.ranges) || body.ranges.length === 0 || body.ranges.length > 36) {
    return NextResponse.json({ error: 'ranges must list 1–36 { from, to }' }, { status: 400 });
  }
  const ranges: { from: string; to: string }[] = [];
  for (const raw of body.ranges) {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (!isValidRange(r.from, r.to)) return NextResponse.json({ error: 'Each range needs from ≤ to as YYYY-MM-DD' }, { status: 400 });
    ranges.push({ from: r.from, to: r.to as string });
  }

  const agreement = await getAgreementDetail(agreementId);
  if (!agreement) return NextResponse.json({ error: 'Agreement not found' }, { status: 404 });

  const reservations = await loadReservationsByNumber();
  const previews = ranges.map((r) => previewFromData(agreement, r.from, r.to, reservations));
  return NextResponse.json({ previews, verified: reservations !== null });
}

/**
 * One corporate agreement.
 *
 *   GET    → agreement + all its stays + roll-up.
 *   PATCH  → contact / billing / default-guest / notes / status. The schedule,
 *            room types and pricing are deliberately NOT editable: they define
 *            the generated stays, and changing them under created bookings has
 *            no honest answer. Make a new agreement instead.
 *            Changing the default guest does not touch Beds24 — created
 *            bookings keep the guest they were made with; edit a stay to push
 *            a real name through.
 *   DELETE → only while nothing exists in Beds24 (no created or cancelled stay).
 *
 * Auth: admin.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { parseAgreementPatch } from '@/utils/corporateInput';
import { deleteAgreement, getAgreementDetail, updateAgreement } from '@/data-access/corporate';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;
  const { id } = await ctx.params;
  const agreement = await getAgreementDetail(id);
  if (!agreement) return NextResponse.json({ error: 'Agreement not found' }, { status: 404 });
  return NextResponse.json({ agreement });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = parseAgreementPatch(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const updated = await updateAgreement(id, parsed.value);
  if (!updated) return NextResponse.json({ error: 'Agreement not found' }, { status: 404 });
  const agreement = await getAgreementDetail(id);
  return NextResponse.json({ agreement });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;
  const { id } = await ctx.params;

  const agreement = await getAgreementDetail(id);
  if (!agreement) return NextResponse.json({ error: 'Agreement not found' }, { status: 404 });
  if (agreement.summary.created > 0 || agreement.summary.cancelled > 0) {
    return NextResponse.json(
      {
        error:
          'This agreement has bookings in Beds24. Cancel the stays first, or mark the agreement completed/cancelled instead of deleting it.',
      },
      { status: 409 },
    );
  }
  await deleteAgreement(id);
  return NextResponse.json({ ok: true });
}

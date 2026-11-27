/**
 * One corporate agreement.
 *
 *   GET    → agreement + all its stays + roll-up.
 *   PATCH  → contact / billing / default-guest / notes / status. The schedule,
 *            room types and pricing are deliberately NOT editable: they define
 *            the generated stays, and changing them under created bookings has
 *            no honest answer. Make a new agreement instead.
 *            A change to the default guest (or the company name / rep phone it
 *            falls back to) is pushed to every CREATED, not-yet-departed stay
 *            whose effective guest changes — stays with their own guest keep
 *            it. The agreement is saved first; a Beds24 refusal is reported
 *            per stay in `guestPush.failed` (retry by editing that stay).
 *            A change to the commission % is written to the Beds24
 *            `commission` field of EVERY created stay (past ones too — the
 *            company bills its % on all of them), as % × the live Beds24
 *            price; reported in `commissionPush` (retry: POST …/commission).
 *   DELETE → only while nothing exists in Beds24 (no created or cancelled stay)
 *            and no invoice was issued. Scheduled invoices go with it.
 *
 * Auth: admin.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAccess } from '@/utils/authGuard';
import { parseAgreementPatch } from '@/utils/corporateInput';
import { deleteAgreement, getAgreement, getAgreementDetail, listStays, updateAgreement } from '@/data-access/corporate';
import { getAccessToken } from '@/utils/beds24Auth';
import { modifyBookingGroup, staysNeedingGuestPush } from '@/utils/corporateBooking';
import { agreementHasIssuedInvoices } from '@/data-access/corporateInvoices';
import { syncAgreementCommission, type CommissionSyncResult } from '@/utils/corporateCommissionSync';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const guard = await requireAccess('corporate', 'view');
  if ('error' in guard) return guard.error;
  const { id } = await ctx.params;
  const agreement = await getAgreementDetail(id);
  if (!agreement) return NextResponse.json({ error: 'Agreement not found' }, { status: 404 });
  return NextResponse.json({ agreement });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const guard = await requireAccess('corporate', 'change');
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

  const before = await getAgreement(id);
  if (!before) return NextResponse.json({ error: 'Agreement not found' }, { status: 404 });
  // numeric columns take strings in Drizzle
  const { commissionPercent, ...rest } = parsed.value;
  const updated = await updateAgreement(id, {
    ...rest,
    ...(commissionPercent !== undefined ? { commissionPercent: String(commissionPercent) } : {}),
  });
  if (!updated) return NextResponse.json({ error: 'Agreement not found' }, { status: 404 });
  const after = (await getAgreement(id)) ?? before;

  // ── Push the new default guest to created bookings that use it ──
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' });
  const targets = staysNeedingGuestPush(before, after, await listStays(id), today);
  const guestPush = { updated: [] as string[], failed: [] as { stayId: string; error: string }[] };
  if (targets.length > 0) {
    let token: string | null = null;
    try {
      token = await getAccessToken();
    } catch (err) {
      const error = `Beds24 sign-in failed: ${err instanceof Error ? err.message : String(err)}`;
      for (const t of targets) guestPush.failed.push({ stayId: t.stayId, error });
    }
    if (token) {
      // One stay at a time: each is its own booking group, and a refusal on
      // one must not stop the rest.
      for (const t of targets) {
        try {
          await modifyBookingGroup(token, t.bookingId, {
            firstName: t.guest.firstName,
            lastName: t.guest.lastName,
            phone: t.guest.phone,
            email: t.guest.email,
          });
          guestPush.updated.push(t.stayId);
        } catch (err) {
          guestPush.failed.push({ stayId: t.stayId, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }

  // ── Re-apply the commission % to every booking in Beds24 ──
  let commissionPush: CommissionSyncResult | null = null;
  if (commissionPercent !== undefined && commissionPercent !== before.commissionPercent) {
    commissionPush = await syncAgreementCommission(after.commissionPercent, await listStays(id), { apply: true });
  }

  const agreement = await getAgreementDetail(id);
  return NextResponse.json({ agreement, guestPush, commissionPush });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const guard = await requireAccess('corporate', 'change');
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
  // An issued invoice is an accounting document — its agreement stays.
  if (await agreementHasIssuedInvoices(id)) {
    return NextResponse.json(
      { error: 'This agreement has issued invoices. Mark it completed or cancelled instead of deleting it.' },
      { status: 409 },
    );
  }
  await deleteAgreement(id);
  return NextResponse.json({ ok: true });
}

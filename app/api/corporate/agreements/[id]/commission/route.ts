/**
 * The agreement's commission in Beds24.
 *
 *   GET  → compare: every created stay's Beds24 commission vs the agreement's
 *          % × the booking's live Beds24 price. Read-only (one Beds24 GET per
 *          50 bookings). The agreement screen runs it on open when a % is set.
 *   POST → re-apply: write the expected commission to every booking that
 *          differs. Idempotent, so safe to repeat after a partial failure.
 *
 * Both answer `{ commission: CommissionSyncResult }` — see utils/corporateCommissionSync.ts.
 *
 * Auth: corporate view (GET) / change (POST).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAccess } from '@/utils/authGuard';
import { getAgreement, listStays } from '@/data-access/corporate';
import { syncAgreementCommission } from '@/utils/corporateCommissionSync';

type Ctx = { params: Promise<{ id: string }> };

async function run(id: string, apply: boolean) {
  const agreement = await getAgreement(id);
  if (!agreement) return NextResponse.json({ error: 'Agreement not found' }, { status: 404 });
  const commission = await syncAgreementCommission(agreement.commissionPercent, await listStays(id), { apply });
  return NextResponse.json({ commission });
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const guard = await requireAccess('corporate', 'view');
  if ('error' in guard) return guard.error;
  const { id } = await ctx.params;
  return run(id, false);
}

export async function POST(_req: NextRequest, ctx: Ctx) {
  const guard = await requireAccess('corporate', 'change');
  if ('error' in guard) return guard.error;
  const { id } = await ctx.params;
  return run(id, true);
}

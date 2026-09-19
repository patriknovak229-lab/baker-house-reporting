/**
 * POST /api/invoice-requests/[id]
 * Body: { action: 'accept' | 'reject' | 'restore' }
 *
 * - accept: marks the request as accepted. The frontend is responsible for
 *   committing the parsed fields (company name, IČO/DIČ, email) onto the
 *   reservation's invoiceData and creating a "Send Invoice" issue with
 *   actionableDate=checkout — that way operator can review/edit before it
 *   commits, and we don't need to load reservations server-side here.
 * - reject: marks rejected so the banner stops showing. Also how the drawer's
 *   collection panel DISMISSES a request the operator settled outside the app
 *   or no longer wants: rejected is terminal for the agent — the reminder pass
 *   and the auto-complete sweep both only look at `awaiting-info`.
 * - restore: undoes a dismissal. The status isn't remembered, it's re-derived
 *   from the stored fields (see `restoredInvoiceRequestStatus`), so an undo can
 *   never resurrect a state the data no longer supports. Restoring anything
 *   that isn't currently `rejected` would be meaningless, so it 409s.
 *
 * Every action stamps processedAt — except restore, which clears it: the
 * request is live again and hasn't been settled.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import type { InvoiceRequestStatus } from '@/types/invoiceRequest';
import { readAllInvoiceRequests, writeAllInvoiceRequests } from '@/utils/invoiceRequestsStore';
import { restoredInvoiceRequestStatus } from '@/utils/invoiceUtils';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'id required' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const action = body?.action as 'accept' | 'reject' | 'restore' | undefined;
  if (action !== 'accept' && action !== 'reject' && action !== 'restore') {
    return NextResponse.json(
      { error: 'action must be "accept", "reject" or "restore"' },
      { status: 400 },
    );
  }

  const all = await readAllInvoiceRequests();
  const idx = all.findIndex((r) => r.id === id);
  if (idx === -1) {
    return NextResponse.json({ error: 'Invoice request not found' }, { status: 404 });
  }
  const current = all[idx];

  if (action === 'restore') {
    if (current.status !== 'rejected') {
      return NextResponse.json(
        { error: `Only a dismissed request can be restored (this one is "${current.status}")` },
        { status: 409 },
      );
    }
    all[idx] = {
      ...current,
      status: restoredInvoiceRequestStatus({
        companyName: current.companyName,
        ico: current.ico,
        dic: current.dic,
        email: current.email,
      }),
      processedAt: undefined,
    };
    await writeAllInvoiceRequests(all);
    return NextResponse.json({ ok: true, request: all[idx] });
  }

  const newStatus: InvoiceRequestStatus = action === 'accept' ? 'accepted' : 'rejected';
  all[idx] = {
    ...current,
    status: newStatus,
    processedAt: new Date().toISOString(),
  };
  await writeAllInvoiceRequests(all);

  return NextResponse.json({ ok: true, request: all[idx] });
}

/**
 * POST /api/corporate/stays/[id]/cancel — cancel ONE created stay in Beds24.
 *
 * Body: { reason?: string }
 *
 * Sets status=cancelled on the booking and every sub-booking Beds24 allocated
 * under it, which frees the nights for resale. The stay is marked cancelled
 * only after Beds24 accepted every record. Price/invoice consequences are the
 * operator's: a corporate stay is invoiced by us, not charged by a channel, so
 * nothing else needs unwinding here.
 *
 * Auth: admin.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { getAccessToken } from '@/utils/beds24Auth';
import { escapeHtml, sendTelegram } from '@/utils/telegram';
import { modifyBookingGroup, roomLabel } from '@/utils/corporateBooking';
import { formatStayRange } from '@/utils/corporateShared';
import { getAgreement, getStay, updateStay } from '@/data-access/corporate';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;
  const { id } = await ctx.params;

  let reason = '';
  try {
    const body = (await req.json()) as { reason?: unknown };
    if (typeof body.reason === 'string') reason = body.reason.trim().slice(0, 500);
  } catch {
    /* no body is fine */
  }

  const stay = await getStay(id);
  if (!stay) return NextResponse.json({ error: 'Stay not found' }, { status: 404 });
  if (stay.status !== 'created' || !stay.beds24BookingId) {
    return NextResponse.json({ error: 'Only a stay that exists in Beds24 can be cancelled here — skip a planned one instead' }, { status: 409 });
  }
  const agreement = await getAgreement(stay.agreementId);

  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Beds24 auth error' }, { status: 500 });
  }

  let cancelledIds: number[];
  try {
    cancelledIds = await modifyBookingGroup(token, stay.beds24BookingId, { status: 'cancelled' });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Beds24 cancel failed' }, { status: 502 });
  }

  const updated = await updateStay(id, { status: 'cancelled', error: null });

  await sendTelegram(
    [
      `🏢 <b>Corporate stay cancelled</b>`,
      `${escapeHtml(agreement?.companyName ?? stay.agreementId)} · ${formatStayRange(stay.arrival, stay.departure)} · ${escapeHtml(roomLabel(stay.roomId))}`,
      `${stay.reservationNumber}${cancelledIds.length > 1 ? ` (+${cancelledIds.length - 1} linked record${cancelledIds.length > 2 ? 's' : ''})` : ''} — nights back on sale`,
      reason ? `🗒 ${escapeHtml(reason)}` : '',
      `👤 by ${escapeHtml(guard.email)}`,
    ]
      .filter(Boolean)
      .join('\n'),
  ).catch(() => {});

  return NextResponse.json({ stay: updated, cancelledIds });
}

/**
 * PATCH /api/corporate/stays/[id] — edit one stay.
 *
 * Body (all optional): { guestFirstName, guestLastName, guestPhone, guestEmail,
 *                        priceCzk, roomId, status: 'planned' | 'skipped' }
 *
 *   - Guest fields may change at any time. `null` clears the stay's own value
 *     so the agreement's default guest applies again. On a CREATED stay the
 *     effective guest is pushed to Beds24 (master + sub-bookings) first; the
 *     stay is only saved once Beds24 accepted the change.
 *   - Price and room type can only change while the stay is planned/failed.
 *     Once a booking exists those live in Beds24 and are edited there — the
 *     same rule the shorten-stay feature follows.
 *   - Status: planned ↔ skipped, and only before anything exists in Beds24.
 *     Cancelling a created stay is its own endpoint (…/cancel).
 *
 * Auth: admin.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { getAccessToken } from '@/utils/beds24Auth';
import { hasGuestChange, parseStayPatch } from '@/utils/corporateInput';
import { effectiveGuest, modifyBookingGroup } from '@/utils/corporateBooking';
import { czkToDb, getAgreement, getStay, updateStay } from '@/data-access/corporate';
import type { CorporateStayInsert } from '@/lib/db/schema/corporate';

type Ctx = { params: Promise<{ id: string }> };

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
  const parsed = parseStayPatch(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const patch = parsed.value;

  const stay = await getStay(id);
  if (!stay) return NextResponse.json({ error: 'Stay not found' }, { status: 404 });
  const agreement = await getAgreement(stay.agreementId);
  if (!agreement) return NextResponse.json({ error: 'Agreement not found' }, { status: 404 });

  const inBeds24 = stay.status === 'created';
  const locked = inBeds24 || stay.status === 'cancelled';

  if ((patch.priceCzk !== undefined || patch.roomId !== undefined) && locked) {
    return NextResponse.json(
      { error: 'This stay already exists in Beds24 — change its price or room there, or cancel it and plan a new one.' },
      { status: 409 },
    );
  }
  if (patch.status !== undefined && locked) {
    return NextResponse.json({ error: 'A created or cancelled stay cannot be re-planned or skipped' }, { status: 409 });
  }

  const dbPatch: Partial<CorporateStayInsert> = {};
  if ('guestFirstName' in patch) dbPatch.guestFirstName = patch.guestFirstName ?? null;
  if ('guestLastName' in patch) dbPatch.guestLastName = patch.guestLastName ?? null;
  if ('guestPhone' in patch) dbPatch.guestPhone = patch.guestPhone ?? null;
  if ('guestEmail' in patch) dbPatch.guestEmail = patch.guestEmail ?? null;
  if (patch.priceCzk !== undefined) {
    dbPatch.priceCzk = czkToDb(patch.priceCzk);
    dbPatch.priceSource = 'manual';
  }
  if (patch.roomId !== undefined) dbPatch.roomId = patch.roomId;
  if (patch.status !== undefined) {
    dbPatch.status = patch.status;
    if (patch.status === 'planned') dbPatch.error = null;
  }

  // ── Push guest details to Beds24 first when the booking exists ──
  let beds24Updated: number[] = [];
  if (inBeds24 && hasGuestChange(patch) && stay.beds24BookingId) {
    const merged = {
      guestFirstName: 'guestFirstName' in patch ? (patch.guestFirstName ?? null) : stay.guestFirstName,
      guestLastName: 'guestLastName' in patch ? (patch.guestLastName ?? null) : stay.guestLastName,
      guestPhone: 'guestPhone' in patch ? (patch.guestPhone ?? null) : stay.guestPhone,
      guestEmail: 'guestEmail' in patch ? (patch.guestEmail ?? null) : stay.guestEmail,
    };
    const guest = effectiveGuest(agreement, merged);
    try {
      const token = await getAccessToken();
      beds24Updated = await modifyBookingGroup(token, stay.beds24BookingId, {
        firstName: guest.firstName,
        lastName: guest.lastName,
        phone: guest.phone,
        email: guest.email,
      });
    } catch (err) {
      return NextResponse.json(
        { error: `Beds24 did not accept the guest change — nothing saved. ${err instanceof Error ? err.message : ''}`.trim() },
        { status: 502 },
      );
    }
  }

  const updated = await updateStay(id, dbPatch);
  return NextResponse.json({ stay: updated, beds24Updated });
}

/**
 * PUT /api/corporate/stays/[id]/cleanings — assign (or replace) a stay's
 * mid-stay cleanings.   DELETE — remove them all.
 *
 * Body: { frequency, mode, weekdays, dates } — see utils/corporateCleaning.ts.
 * `dates` is the final list the operator confirmed (regular plans are generated
 * in the browser and then editable date by date), strictly inside the stay.
 *
 * Only for stays that exist in Beds24: the cleanings are placed in the room the
 * booking actually sits in. After saving, the reservation's entry in the shared
 * cleaning-request map is republished at once, so the cleaning app shows the
 * cleanings ("Úklid během pobytu") without waiting for the next bookings sync.
 * If the booking isn't in the bookings cache yet, the next sync publishes them.
 * The post-stay cleaning is untouched — it still comes from the checkout.
 *
 * Auth: corporate change (admin).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAccess } from '@/utils/authGuard';
import { getStay, updateStay } from '@/data-access/corporate';
import { parseCleaningPlanInput, type CleaningPlan } from '@/utils/corporateCleaning';
import { cachedReservation } from '@/utils/beds24Reservations';
import { readAllReservationOverrides } from '@/utils/reservationOverridesStore';
import { publishCleaningRequestsEntry } from '@/utils/cleaningRequestsPublish';
import type { Issue } from '@/types/reservation';
import type { CorporateStay } from '@/utils/corporateShared';

type Ctx = { params: Promise<{ id: string }> };

/** Republish the stay's reservation; returns how many corporate cleanings went out, or null if not cached. */
async function republish(stay: CorporateStay): Promise<number | null> {
  if (!stay.reservationNumber) return null;
  const r = await cachedReservation(stay.reservationNumber);
  if (!r) return null;
  const overrides = await readAllReservationOverrides<{ issues?: Issue[] }>();
  const byBooking = await publishCleaningRequestsEntry(r, overrides[r.reservationNumber]?.issues);
  return Object.values(byBooking)
    .flat()
    .filter((c) => c.id.startsWith('corp-')).length;
}

async function loadCreatedStay(id: string) {
  const stay = await getStay(id);
  if (!stay) return { error: NextResponse.json({ error: 'Stay not found' }, { status: 404 }) };
  if (stay.status !== 'created' || !stay.reservationNumber) {
    return { error: NextResponse.json({ error: 'Cleanings can be assigned once the booking exists in Beds24' }, { status: 409 }) };
  }
  return { stay };
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const guard = await requireAccess('corporate', 'change');
  if ('error' in guard) return guard.error;
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const loaded = await loadCreatedStay(id);
  if ('error' in loaded) return loaded.error;
  const { stay } = loaded;

  // Dates are checked against the LIVE booking when we have it (a stay
  // shortened in Beds24 has a different checkout than the agreement planned).
  const live = await cachedReservation(stay.reservationNumber!).catch(() => null);
  const arrival = live?.checkInDate ?? stay.arrival;
  const departure = live?.checkOutDate ?? stay.departure;

  const parsed = parseCleaningPlanInput(body, arrival, departure);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const plan: CleaningPlan = { ...parsed.value, updatedAt: new Date().toISOString(), updatedBy: guard.email };
  const updated = await updateStay(id, { cleaningPlan: plan });
  if (!updated) return NextResponse.json({ error: 'Stay not found' }, { status: 404 });

  const published = await republish(updated).catch((err) => {
    console.error('[corporate cleanings] republish failed', err);
    return null;
  });
  return NextResponse.json({ stay: updated, published });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const guard = await requireAccess('corporate', 'change');
  if ('error' in guard) return guard.error;
  const { id } = await ctx.params;
  const loaded = await loadCreatedStay(id);
  if ('error' in loaded) return loaded.error;

  const updated = await updateStay(id, { cleaningPlan: null });
  if (!updated) return NextResponse.json({ error: 'Stay not found' }, { status: 404 });
  const published = await republish(updated).catch(() => null);
  return NextResponse.json({ stay: updated, published });
}

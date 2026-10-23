import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { readAllReservationOverrides, writeAllReservationOverrides } from '@/utils/reservationOverridesStore';

// All locally managed reservation fields (not stored in Beds24)
// Keyed by reservationNumber (e.g. "BH-12345")

// GET /api/local-state — returns full overrides map
export async function GET() {
  return NextResponse.json(await readAllReservationOverrides());
}

// POST /api/local-state — upsert one reservation's overrides
// Body: { reservationNumber: string, fields: Record<string, unknown> }
// Passing an empty fields object removes that reservation's entry.
export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const { reservationNumber, fields } = await req.json();
  if (!reservationNumber) {
    return NextResponse.json({ error: 'reservationNumber required' }, { status: 400 });
  }

  // Read → modify → write (whole map)
  const state = await readAllReservationOverrides<unknown>();

  // `parkingUse` can be written server-side (a guest's chat reply, see
  // utils/guestContactService) after the drawer loaded. The client sends the key
  // whenever it knows a value — null when the operator cleared it — so an ABSENT
  // key means "this tab never saw it": keep the stored answer instead of wiping it.
  const stored = state[reservationNumber] as Record<string, unknown> | undefined;
  const keepParkingUse =
    stored?.parkingUse != null && (fields == null || !('parkingUse' in fields));

  if (fields && Object.keys(fields).length > 0) {
    state[reservationNumber] = keepParkingUse ? { ...fields, parkingUse: stored!.parkingUse } : fields;
  } else if (keepParkingUse) {
    state[reservationNumber] = { parkingUse: stored!.parkingUse };
  } else {
    delete state[reservationNumber];
  }

  await writeAllReservationOverrides(state);
  return NextResponse.json({ ok: true });
}

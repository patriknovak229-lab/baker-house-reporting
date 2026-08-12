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

  if (fields && Object.keys(fields).length > 0) {
    state[reservationNumber] = fields;
  } else {
    delete state[reservationNumber];
  }

  await writeAllReservationOverrides(state);
  return NextResponse.json({ ok: true });
}

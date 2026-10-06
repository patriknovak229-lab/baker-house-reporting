/**
 * Corporate agreements — collection.
 *
 *   GET  → every agreement with its stay roll-up (the Corporate tab list).
 *   POST → save a new agreement AND the stays its pattern generates, with the
 *          operator's per-row choices from the preview (room, price, guest,
 *          include/skip). Creates NOTHING in Beds24 — that is a second,
 *          explicit step (…/[id]/create-bookings), so a saved agreement with
 *          planned stays is always safe to look at.
 *
 * The server regenerates the schedule from the pattern rather than trusting
 * the client's dates: rows are matched to generated stays by seq, so the
 * client can choose and price a stay but never invent one.
 *
 * Auth: admin.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { generateStays } from '@/utils/corporateSchedule';
import { materialiseStays, parseAgreementInput, parseStayInputs } from '@/utils/corporateInput';
import {
  czkToDb,
  getAgreementDetail,
  insertAgreementWithStays,
  listAgreements,
  newAgreementId,
  stayIdFor,
} from '@/data-access/corporate';
import type { CorporateAgreementInsert, CorporateStayInsert } from '@/lib/db/schema/corporate';

export async function GET() {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;
  try {
    const agreements = await listAgreements();
    return NextResponse.json({ agreements });
  } catch (err) {
    console.error('[corporate] list failed:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to load agreements' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = parseAgreementInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const input = parsed.value;

  let occurrences;
  try {
    occurrences = generateStays({
      startDate: input.startDate,
      endDate: input.endDate,
      nightWeekdays: input.nightWeekdays,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Invalid schedule' }, { status: 400 });
  }
  if (occurrences.length === 0) {
    return NextResponse.json(
      { error: 'This pattern produces no stays between the two dates — check the nights and the period' },
      { status: 400 },
    );
  }

  const rows = parseStayInputs((body as { stays?: unknown }).stays);
  if (!rows.ok) return NextResponse.json({ error: rows.error }, { status: 400 });
  const materialised = materialiseStays(input, occurrences, rows.value);
  if (!materialised.ok) return NextResponse.json({ error: materialised.error }, { status: 400 });

  const id = newAgreementId();
  const agreementRow: CorporateAgreementInsert = {
    id,
    companyName: input.companyName,
    companyAddress: input.companyAddress,
    ico: input.ico,
    vatNumber: input.vatNumber,
    billingEmail: input.billingEmail,
    billingCadence: input.billingCadence,
    repName: input.repName,
    repPhone: input.repPhone,
    repEmail: input.repEmail,
    guestFirstName: input.guestFirstName,
    guestLastName: input.guestLastName,
    guestPhone: input.guestPhone,
    guestEmail: input.guestEmail,
    adults: input.adults,
    children: input.children,
    nationality: input.nationality,
    roomIds: input.roomIds,
    preferredRoomId: input.preferredRoomId,
    startDate: input.startDate,
    endDate: input.endDate,
    nightWeekdays: input.nightWeekdays,
    pricingMode: input.pricingMode,
    flatNightPriceCzk: czkToDb(input.flatNightPriceCzk),
    discountPercent: String(input.discountPercent),
    notes: input.notes,
    status: 'draft',
    createdBy: guard.email,
  };
  const stayRows: CorporateStayInsert[] = materialised.value.map((s) => ({
    id: stayIdFor(id, s.seq),
    agreementId: id,
    seq: s.seq,
    arrival: s.arrival,
    departure: s.departure,
    nights: s.nights,
    roomId: s.roomId,
    guestFirstName: s.guestFirstName,
    guestLastName: s.guestLastName,
    guestPhone: s.guestPhone,
    guestEmail: s.guestEmail,
    listPriceCzk: czkToDb(s.listPriceCzk),
    priceCzk: czkToDb(s.priceCzk),
    priceSource: s.priceSource,
    status: s.status,
  }));

  try {
    await insertAgreementWithStays(agreementRow, stayRows);
  } catch (err) {
    console.error('[corporate] insert failed:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to save the agreement' }, { status: 500 });
  }

  const agreement = await getAgreementDetail(id);
  return NextResponse.json({ agreement }, { status: 201 });
}

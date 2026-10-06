/**
 * POST /api/corporate/agreements/[id]/create-bookings
 *
 * Turns an agreement's planned (or previously failed) stays into Beds24
 * bookings — the one place the Corporate tab writes to Beds24 in bulk.
 *
 * Body: { stayIds?: string[]; dryRun?: boolean }
 *   stayIds — restrict to these stays; default = every planned/failed stay.
 *   dryRun  — build and return the Beds24 payload without sending it.
 *
 * Rules:
 *   - every stay needs a price above 0 (flat is computed; dynamic needs the
 *     quote or a typed number) — refusing is cheaper than fixing invoices;
 *   - bookings go out in chunks of CREATE_CHUNK_SIZE, each an array POST with
 *     `checkAvailability`, so Beds24 refuses instead of overbooking;
 *   - outcomes are written per stay (created → BH number; failed → reason) and
 *     the write is best-effort per row, because by then the bookings EXIST;
 *   - one Telegram summary per run, naming anything that failed.
 *
 * Auth: admin.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { getAccessToken } from '@/utils/beds24Auth';
import { isValidCountryCode } from '@/utils/countries';
import { escapeHtml, sendTelegram } from '@/utils/telegram';
import {
  CREATE_CHUNK_SIZE,
  buildCorporateBookingPayload,
  parseBeds24BatchResponse,
  postBeds24Bookings,
  roomLabel,
} from '@/utils/corporateBooking';
import { describeNights } from '@/utils/corporateSchedule';
import { formatCzk, formatStayDate, formatStayRange, type CorporateStay } from '@/utils/corporateShared';
import { getAgreementDetail, recordStayOutcomes, updateAgreement } from '@/data-access/corporate';
import type { CorporateStayInsert } from '@/lib/db/schema/corporate';

export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

interface StayOutcome {
  stayId: string;
  seq: number;
  arrival: string;
  departure: string;
  roomId: number;
  ok: boolean;
  reservationNumber: string | null;
  error: string | null;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;
  const { id } = await ctx.params;

  let body: { stayIds?: unknown; dryRun?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body = everything planned */
  }
  const dryRun = body.dryRun === true;
  const wanted = Array.isArray(body.stayIds) ? new Set(body.stayIds.map(String)) : null;

  const agreement = await getAgreementDetail(id);
  if (!agreement) return NextResponse.json({ error: 'Agreement not found' }, { status: 404 });
  if (agreement.status === 'cancelled') {
    return NextResponse.json({ error: 'This agreement is cancelled — reactivate it before creating bookings' }, { status: 409 });
  }
  if (!isValidCountryCode(agreement.nationality)) {
    return NextResponse.json({ error: `Agreement nationality "${agreement.nationality}" is not a valid country code` }, { status: 400 });
  }

  const targets = agreement.stays.filter(
    (s) => (s.status === 'planned' || s.status === 'failed') && (!wanted || wanted.has(s.id)),
  );
  if (targets.length === 0) {
    return NextResponse.json({ error: 'No planned stays to create' }, { status: 400 });
  }
  const unpriced = targets.filter((s) => s.priceCzk === null || s.priceCzk <= 0);
  if (unpriced.length > 0) {
    return NextResponse.json(
      {
        error:
          `Every stay needs a price above 0 before it can be created. Missing: ` +
          unpriced.map((s) => formatStayDate(s.arrival)).join(', '),
        unpricedStayIds: unpriced.map((s) => s.id),
      },
      { status: 400 },
    );
  }

  const payloads = targets.map((s) => buildCorporateBookingPayload(agreement, s, agreement.stays.length));
  if (dryRun) {
    return NextResponse.json({ dryRun: true, count: payloads.length, payload: payloads });
  }

  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Beds24 auth error' }, { status: 500 });
  }

  // ── Send, chunk by chunk ──
  const outcomes: StayOutcome[] = [];
  for (let i = 0; i < targets.length; i += CREATE_CHUNK_SIZE) {
    const chunkStays = targets.slice(i, i + CREATE_CHUNK_SIZE);
    const chunkPayload = payloads.slice(i, i + CREATE_CHUNK_SIZE);
    let parsed: ReturnType<typeof parseBeds24BatchResponse>;
    try {
      const json = await postBeds24Bookings(token, chunkPayload);
      parsed = parseBeds24BatchResponse(json, chunkStays.length);
    } catch (err) {
      // The whole request failed — nothing in this chunk was created.
      const reason = err instanceof Error ? err.message : 'Beds24 request failed';
      parsed = chunkStays.map(() => ({ ok: false, bookingId: null, error: reason }));
    }
    chunkStays.forEach((stay, idx) => {
      const r = parsed[idx];
      outcomes.push({
        stayId: stay.id,
        seq: stay.seq,
        arrival: stay.arrival,
        departure: stay.departure,
        roomId: stay.roomId,
        ok: r.ok,
        reservationNumber: r.bookingId !== null ? `BH-${r.bookingId}` : null,
        error: r.error,
      });
    });
  }

  // ── Record outcomes (best-effort per row — the bookings exist now) ──
  const now = new Date();
  const unsaved = await recordStayOutcomes(
    outcomes.map((o) => {
      const patch: Partial<CorporateStayInsert> = o.ok
        ? {
            status: 'created',
            beds24BookingId: Number(o.reservationNumber!.replace(/^BH-/, '')),
            reservationNumber: o.reservationNumber,
            error: null,
            bookedAt: now,
          }
        : { status: 'failed', error: o.error };
      return { id: o.stayId, patch };
    }),
  );

  const created = outcomes.filter((o) => o.ok);
  const failed = outcomes.filter((o) => !o.ok);
  if (created.length > 0 && agreement.status === 'draft') {
    await updateAgreement(id, { status: 'active' }).catch((err) =>
      console.error('[corporate] could not mark agreement active:', err),
    );
  }

  // ── Telegram summary ──
  const stayById = new Map<string, CorporateStay>(agreement.stays.map((s) => [s.id, s]));
  const totalCreatedCzk = created.reduce((sum, o) => sum + (stayById.get(o.stayId)?.priceCzk ?? 0), 0);
  const lines = [
    `🏢 <b>Corporate bookings${failed.length > 0 && created.length === 0 ? ' — all failed' : ' created'}</b>`,
    `${escapeHtml(agreement.companyName)} · ${describeNights(agreement.nightWeekdays)} · ${formatStayDate(agreement.startDate)} → ${formatStayDate(agreement.endDate)}`,
    created.length > 0
      ? `✅ ${created.length} created (${formatCzk(totalCreatedCzk)}): ${created
          .map((o) => `${o.reservationNumber} ${formatStayDate(o.arrival)} ${escapeHtml(roomLabel(o.roomId))}`)
          .join(' · ')}`
      : '',
    failed.length > 0
      ? `❌ ${failed.length} failed:\n${failed
          .map((o) => `• ${formatStayRange(o.arrival, o.departure)} (${escapeHtml(roomLabel(o.roomId))}): ${escapeHtml(o.error ?? 'unknown')}`)
          .join('\n')}`
      : '',
    unsaved.length > 0
      ? `🚨 ${unsaved.length} outcome(s) could NOT be saved to the agreement — bookings exist in Beds24 but the Corporate tab does not know. Do not retry before checking: ${unsaved.join(', ')}`
      : '',
    `👤 by ${escapeHtml(guard.email)}`,
  ].filter(Boolean);
  await sendTelegram(lines.join('\n')).catch(() => {});

  const fresh = await getAgreementDetail(id);
  return NextResponse.json({
    created: created.length,
    failed: failed.length,
    unsaved,
    results: outcomes,
    agreement: fresh,
  });
}

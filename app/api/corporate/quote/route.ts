/**
 * POST /api/corporate/quote — what the web would charge for each planned stay.
 *
 * Body: { adults?: number; children?: number;
 *         segments: [{ roomId, from, to }] }   (≤ MAX_SEGMENTS)
 *
 * Dynamic-mode agreements sell each stay at the web price minus the agreed
 * discount, so the preview asks Beds24 for a real offer per stay — the same
 * plumbing the Stay Request quote uses (utils/beds24Pricing.priceSegment),
 * with a higher cap because a season of weekly stays is many short segments.
 * Sequential on purpose: Beds24 bills per request against a rolling credit
 * limit. Read-only — reserves nothing.
 *
 * Auth: admin.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { priceSegment, type SegmentPrice } from '@/utils/beds24Pricing';
import { nightsBetween, isYmd } from '@/utils/corporateSchedule';
import { SELLABLE_ROOM_IDS } from '@/utils/corporateInput';

export const maxDuration = 60;

/** More than this and the operator should split the agreement — and Beds24 would throttle us anyway. */
const MAX_SEGMENTS = 60;

interface Segment {
  roomId: number;
  from: string;
  to: string;
}

export interface QuotedCorporateSegment extends Segment, SegmentPrice {
  nights: number;
  error?: string;
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  let body: { segments?: unknown; adults?: unknown; children?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const adults = Number(body.adults ?? 1);
  const children = Number(body.children ?? 0);
  if (!Number.isInteger(adults) || adults < 1 || !Number.isInteger(children) || children < 0) {
    return NextResponse.json({ error: 'adults must be ≥ 1 and children ≥ 0' }, { status: 400 });
  }
  if (!Array.isArray(body.segments) || body.segments.length === 0) {
    return NextResponse.json({ error: 'segments must be a non-empty array' }, { status: 400 });
  }
  if (body.segments.length > MAX_SEGMENTS) {
    return NextResponse.json({ error: `at most ${MAX_SEGMENTS} stays can be priced at once` }, { status: 400 });
  }

  const segments: Segment[] = [];
  for (const raw of body.segments) {
    const s = raw as Partial<Segment>;
    const roomId = Number(s.roomId);
    if (!SELLABLE_ROOM_IDS.has(roomId)) return NextResponse.json({ error: `unknown sellable roomId ${s.roomId}` }, { status: 400 });
    if (!isYmd(s.from) || !isYmd(s.to) || nightsBetween(s.from, s.to) <= 0) {
      return NextResponse.json({ error: 'each segment needs from < to as YYYY-MM-DD' }, { status: 400 });
    }
    segments.push({ roomId, from: s.from, to: s.to });
  }

  const quoted: QuotedCorporateSegment[] = [];
  for (const seg of segments) {
    const nights = nightsBetween(seg.from, seg.to);
    try {
      const price = await priceSegment(seg.roomId, seg.from, seg.to, adults, children);
      quoted.push({ ...seg, nights, ...price });
    } catch (err) {
      quoted.push({
        ...seg,
        nights,
        price: null,
        source: 'none',
        offersCount: 0,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  return NextResponse.json({
    segments: quoted,
    complete: quoted.every((q) => q.price !== null),
    hasNominalPrices: quoted.some((q) => q.source === 'calendar-nominal'),
  });
}

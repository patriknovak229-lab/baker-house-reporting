/**
 * POST /api/stay-request/quote — price an itinerary of proposed segments.
 *
 * The client works out WHICH segments are possible (utils/stayRequest.ts, run
 * against the reservations already on screen, exactly like the room-assignment
 * panel does). This route answers only "what would Beds24 charge for each?",
 * because a real quote needs Beds24's own rate-plan evaluation.
 *
 * READ-ONLY. It creates nothing, moves nothing and reserves nothing — a guest
 * asking about dates must never touch live bookings. Availability is not
 * re-validated here either: an out-of-date price is a number the operator
 * re-checks, whereas a booking side effect would be a real change.
 *
 * Each segment is quoted independently, which is also how it would be sold: one
 * reservation per segment. Beds24 applies length-of-stay pricing per booking, so
 * splitting a long stay usually costs MORE than one continuous booking of the
 * same nights — that gap is what the operator's discount is for.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { priceSegment, type SegmentPrice } from '@/utils/beds24Pricing';
import { SELLABLE_UNITS, nightsBetween } from '@/utils/stayRequest';

/** Guard against a runaway body — a real itinerary is a handful of segments. */
const MAX_SEGMENTS = 20;

interface QuoteRequestSegment {
  roomId: number;
  from: string;
  to: string;
}

export interface QuotedSegment extends QuoteRequestSegment, SegmentPrice {
  nights: number;
  /** Per-night average of whatever price we got, for eyeballing the quote. */
  adr: number | null;
  /** Set when Beds24 refused to price this span at all. */
  error?: string;
}

const isYmd = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

export async function POST(req: NextRequest) {
  const authResult = await requireRole(['admin', 'super']);
  if ('error' in authResult) return authResult.error;

  let body: { segments?: unknown; adults?: unknown; children?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const adults = Number(body.adults ?? 2);
  const children = Number(body.children ?? 0);
  if (!Number.isInteger(adults) || adults < 1 || !Number.isInteger(children) || children < 0) {
    return NextResponse.json({ error: 'adults must be ≥ 1 and children ≥ 0' }, { status: 400 });
  }

  if (!Array.isArray(body.segments) || body.segments.length === 0) {
    return NextResponse.json({ error: 'segments must be a non-empty array' }, { status: 400 });
  }
  if (body.segments.length > MAX_SEGMENTS) {
    return NextResponse.json({ error: `at most ${MAX_SEGMENTS} segments` }, { status: 400 });
  }

  const segments: QuoteRequestSegment[] = [];
  for (const raw of body.segments) {
    const s = raw as Partial<QuoteRequestSegment>;
    const roomId = Number(s.roomId);
    if (!SELLABLE_UNITS.some((u) => u.roomId === roomId)) {
      return NextResponse.json({ error: `unknown sellable roomId ${s.roomId}` }, { status: 400 });
    }
    if (!isYmd(s.from) || !isYmd(s.to) || nightsBetween(s.from, s.to) <= 0) {
      return NextResponse.json({ error: 'each segment needs from < to as YYYY-MM-DD' }, { status: 400 });
    }
    segments.push({ roomId, from: s.from, to: s.to });
  }

  // Sequential, not parallel: Beds24 bills per request against a rolling
  // 5-minute credit limit, and a long itinerary fanned out in parallel is the
  // shape most likely to trip it.
  const quoted: QuotedSegment[] = [];
  for (const seg of segments) {
    const nights = nightsBetween(seg.from, seg.to);
    try {
      const price = await priceSegment(seg.roomId, seg.from, seg.to, adults, children);
      quoted.push({
        ...seg,
        nights,
        ...price,
        adr: price.price === null ? null : Math.round((price.price / nights) * 100) / 100,
      });
    } catch (err) {
      // One unpriceable segment must not lose the rest of the itinerary.
      quoted.push({
        ...seg,
        nights,
        price: null,
        source: 'none',
        offersCount: 0,
        adr: null,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  const priced = quoted.filter((q) => q.price !== null);
  const total = priced.reduce((sum, q) => sum + (q.price ?? 0), 0);
  const totalNights = quoted.reduce((sum, q) => sum + q.nights, 0);

  return NextResponse.json({
    segments: quoted,
    total: Math.round(total * 100) / 100,
    totalNights,
    /** false when any segment came back unpriced — the total is then partial. */
    complete: priced.length === quoted.length,
    /** true when any price is a nominal calendar sum rather than a real offer. */
    hasNominalPrices: quoted.some((q) => q.source === 'calendar-nominal'),
  });
}

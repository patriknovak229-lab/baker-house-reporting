/**
 * GET  /api/stripe/backfill-orphans              → list orphaned records (dry run)
 * POST /api/stripe/backfill-orphans              → re-key orphans onto their real reservations
 *
 * Why this exists: the New Direct Booking modal had a bug for ~3 days where
 * `\`BH-${json.data[0]}\`` produced the literal string "BH-[object Object]"
 * instead of "BH-12345678" (object stringified instead of indexing into .id).
 * Fixed in commit 0d81db1 on 2026-04-28. Any AdditionalPayment / SplitPayment
 * created via the split-payments flow during that window was stored under the
 * broken reservationNumber and is therefore invisible in the drawer.
 *
 * Heuristic: match each orphan to a Beds24 reservation by guest email + an
 * `createdAt` ≤ 5 minutes apart from the booking's `bookingTime` — the
 * split-payments POST runs immediately after the bookings POST in the modal,
 * so timestamps are tight. If we get exactly one match we re-key; if zero or
 * multiple, we skip and report.
 */

import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { AdditionalPayment } from '@/types/additionalPayment';
import type { SplitPayment } from '@/types/splitPayment';
import type { Reservation } from '@/types/reservation';

const ADDITIONAL_PAYMENTS_KEY = 'baker:additional-payments';
const SCHEDULED_KEY = 'baker:scheduled-split-payments';

const ORPHAN_PATTERN = /\[object\s+object\]/i;
const TIME_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

function getRedis(): Redis {
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
}

interface OrphanReport {
  apOrphans: Array<{ id: string; reservationNumber: string; createdAt: string; guestEmail?: string; amountCzk: number; description: string }>;
  spOrphans: Array<{ id: string; reservationNumber: string; createdAt: string; guestEmail?: string; amountCzk: number; description: string; sendDate: string }>;
  proposedFixes: Array<{
    type: 'AP' | 'SP';
    recordId: string;
    fromReservationNumber: string;
    toReservationNumber: string;
    matchedBy: string;
  }>;
  unresolvable: Array<{ type: 'AP' | 'SP'; recordId: string; reservationNumber: string; reason: string }>;
}

async function fetchReservations(req: NextRequest): Promise<Reservation[]> {
  const baseUrl = req.nextUrl.origin;
  const cookie = req.headers.get('cookie') ?? '';
  const res = await fetch(`${baseUrl}/api/bookings`, {
    headers: { cookie },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Beds24 fetch failed: ${res.status}`);
  return res.json();
}

function isOrphan(reservationNumber: string): boolean {
  if (!reservationNumber) return true;
  if (ORPHAN_PATTERN.test(reservationNumber)) return true;
  // Valid form is BH-<digits>; anything else is suspect
  return !/^BH-\d+$/.test(reservationNumber);
}

function tryMatch(
  record: { createdAt: string; guestEmail?: string; amountCzk: number },
  reservations: Reservation[],
): { match: Reservation | null; reason: string } {
  const createdAtMs = new Date(record.createdAt).getTime();

  // Email is the primary signal; only consider reservations with this guest's email
  const candidatesByEmail = record.guestEmail
    ? reservations.filter((r) =>
        r.email === record.guestEmail || r.additionalEmail === record.guestEmail,
      )
    : reservations;

  if (candidatesByEmail.length === 0) {
    return { match: null, reason: 'no reservation with matching guest email' };
  }

  // Among email matches, find the one whose bookingTimestamp is closest to record.createdAt
  // and within tolerance.
  const tightMatches = candidatesByEmail
    .map((r) => ({
      r,
      delta: Math.abs(new Date(r.bookingTimestamp).getTime() - createdAtMs),
    }))
    .filter((x) => x.delta <= TIME_TOLERANCE_MS)
    .sort((a, b) => a.delta - b.delta);

  if (tightMatches.length === 1) {
    return { match: tightMatches[0].r, reason: `email + bookingTime within ${Math.round(tightMatches[0].delta / 1000)}s` };
  }
  if (tightMatches.length > 1) {
    // Multiple bookings made within 5 min of payment record — narrow further by amount
    const exactPriceMatch = tightMatches.find((x) => x.r.price === record.amountCzk);
    if (exactPriceMatch) {
      return { match: exactPriceMatch.r, reason: 'email + bookingTime + exact price' };
    }
    return { match: null, reason: `${tightMatches.length} candidates within tolerance, no unique price match` };
  }

  // No bookingTime match — fall back to email-only IF there's exactly one
  if (candidatesByEmail.length === 1) {
    return { match: candidatesByEmail[0], reason: 'unique email match (no bookingTime correlation)' };
  }

  return { match: null, reason: `${candidatesByEmail.length} candidates by email, none within bookingTime tolerance` };
}

async function buildReport(req: NextRequest): Promise<OrphanReport> {
  const redis = getRedis();
  const [aps, sps, reservations] = await Promise.all([
    redis.get<AdditionalPayment[]>(ADDITIONAL_PAYMENTS_KEY).then((v) => v ?? []),
    redis.get<SplitPayment[]>(SCHEDULED_KEY).then((v) => v ?? []),
    fetchReservations(req),
  ]);

  const apOrphans = aps.filter((ap) => isOrphan(ap.reservationNumber));
  const spOrphans = sps.filter((sp) => isOrphan(sp.reservationNumber));

  const proposedFixes: OrphanReport['proposedFixes'] = [];
  const unresolvable: OrphanReport['unresolvable'] = [];

  for (const ap of apOrphans) {
    const { match, reason } = tryMatch(ap, reservations);
    if (match) {
      proposedFixes.push({
        type: 'AP',
        recordId: ap.id,
        fromReservationNumber: ap.reservationNumber,
        toReservationNumber: match.reservationNumber,
        matchedBy: reason,
      });
    } else {
      unresolvable.push({ type: 'AP', recordId: ap.id, reservationNumber: ap.reservationNumber, reason });
    }
  }
  for (const sp of spOrphans) {
    const { match, reason } = tryMatch(sp, reservations);
    if (match) {
      proposedFixes.push({
        type: 'SP',
        recordId: sp.id,
        fromReservationNumber: sp.reservationNumber,
        toReservationNumber: match.reservationNumber,
        matchedBy: reason,
      });
    } else {
      unresolvable.push({ type: 'SP', recordId: sp.id, reservationNumber: sp.reservationNumber, reason });
    }
  }

  return {
    apOrphans: apOrphans.map((ap) => ({
      id: ap.id,
      reservationNumber: ap.reservationNumber,
      createdAt: ap.createdAt,
      guestEmail: ap.guestEmail,
      amountCzk: ap.amountCzk,
      description: ap.description,
    })),
    spOrphans: spOrphans.map((sp) => ({
      id: sp.id,
      reservationNumber: sp.reservationNumber,
      createdAt: sp.createdAt,
      guestEmail: sp.guestEmail,
      amountCzk: sp.amountCzk,
      description: sp.description,
      sendDate: sp.sendDate,
    })),
    proposedFixes,
    unresolvable,
  };
}

export async function GET(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  try {
    const report = await buildReport(req);
    return NextResponse.json({ ok: true, ...report });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  try {
    const report = await buildReport(req);
    if (report.proposedFixes.length === 0) {
      return NextResponse.json({ ok: true, applied: 0, ...report });
    }

    const redis = getRedis();
    const [aps, sps] = await Promise.all([
      redis.get<AdditionalPayment[]>(ADDITIONAL_PAYMENTS_KEY).then((v) => v ?? []),
      redis.get<SplitPayment[]>(SCHEDULED_KEY).then((v) => v ?? []),
    ]);

    let apMutated = false;
    let spMutated = false;

    for (const fix of report.proposedFixes) {
      if (fix.type === 'AP') {
        const idx = aps.findIndex((ap) => ap.id === fix.recordId);
        if (idx !== -1) {
          aps[idx] = { ...aps[idx], reservationNumber: fix.toReservationNumber };
          apMutated = true;
        }
      } else {
        const idx = sps.findIndex((sp) => sp.id === fix.recordId);
        if (idx !== -1) {
          sps[idx] = { ...sps[idx], reservationNumber: fix.toReservationNumber };
          spMutated = true;
        }
      }
    }

    const writes: Promise<unknown>[] = [];
    if (apMutated) writes.push(redis.set(ADDITIONAL_PAYMENTS_KEY, aps));
    if (spMutated) writes.push(redis.set(SCHEDULED_KEY, sps));
    await Promise.all(writes);

    return NextResponse.json({
      ok: true,
      applied: report.proposedFixes.length,
      ...report,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

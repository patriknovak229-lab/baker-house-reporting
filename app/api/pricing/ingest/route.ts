/**
 * Parity runner handshake.
 *
 * GET  — the work order: is a grid run due today, and which custom checks are
 *        queued. Polled by the local Mac runner every few minutes.
 * POST — the results: scraped Airbnb/Booking offers per slot. The server adds
 *        the Web column itself from the Beds24 offers API (the token lives
 *        here, not on the Mac), computes expected prices from the configured
 *        channel economics, stores everything append-only, closes any custom
 *        requests, and fires Telegram alerts on parity violations.
 *
 * AUTH: a shared secret in the `x-parity-secret` header — this endpoint is
 * called by a headless job, not a browser session. The secret lives in
 * PRICING_INGEST_SECRET on both sides. No session fallback on purpose: a
 * browser has no business POSTing observations.
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, lt } from 'drizzle-orm';
import { db } from '@/lib/db';
import { priceCheckRequests, priceSnapshots } from '@/lib/db/schema';
import { getAccessToken } from '@/utils/beds24Auth';
import { extractPrice, fetchOffers, offersForRoom } from '@/utils/beds24Pricing';
import { pragueToday } from '@/utils/periodUtils';
import { sendTelegram } from '@/utils/telegram';
import {
  BOOKING_OVER_AIRBNB_BAND,
  EXPECTED_DRIFT_ALERT_PCT,
  PARITY_CONFIG_VERSION,
  PARITY_ECONOMICS,
  PARITY_UNITS,
} from '@/data/parityConfig';
import type {
  ParityChannel,
  ParityIngestPayload,
  ParityOffer,
  ParityWorkOrder,
} from '@/utils/parityTypes';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

function checkSecret(req: NextRequest): NextResponse | null {
  const expected = process.env.PRICING_INGEST_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: 'PRICING_INGEST_SECRET is not configured on the server.' },
      { status: 503 },
    );
  }
  if (req.headers.get('x-parity-secret') !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function diffDays(fromIso: string, toIso: string): number {
  return Math.round(
    (new Date(`${toIso}T00:00:00Z`).getTime() - new Date(`${fromIso}T00:00:00Z`).getTime()) /
      86_400_000,
  );
}

// ── GET: work order ───────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const denied = checkSecret(req);
  if (denied) return denied;

  const today = pragueToday();

  // Expire custom checks whose stay date passed before any runner poll got to
  // them — leaving them pending would make the runner scrape the past forever.
  await db
    .update(priceCheckRequests)
    .set({ status: 'error', error: 'Expired before the runner picked it up.' })
    .where(and(eq(priceCheckRequests.status, 'pending'), lt(priceCheckRequests.checkIn, today)));

  const [latestGrid] = await db
    .select({ capturedAt: priceSnapshots.capturedAt })
    .from(priceSnapshots)
    .where(eq(priceSnapshots.source, 'grid'))
    .orderBy(desc(priceSnapshots.capturedAt))
    .limit(1);

  // Runner-local capture timestamps are UTC; a grid run counts for the Prague
  // day it lands in. Close enough for "run once a day".
  const lastGridDate = latestGrid
    ? new Date(latestGrid.capturedAt.getTime() + 2 * 3_600_000).toISOString().slice(0, 10)
    : null;

  const pending = await db
    .select()
    .from(priceCheckRequests)
    .where(eq(priceCheckRequests.status, 'pending'))
    .orderBy(priceCheckRequests.requestedAt);

  const order: ParityWorkOrder = {
    today,
    configVersion: PARITY_CONFIG_VERSION,
    lastGridDate,
    gridDue: lastGridDate === null || lastGridDate < today,
    pendingRequests: pending.map((r) => ({ id: r.id, checkIn: r.checkIn, nights: r.nights })),
  };
  return NextResponse.json(order);
}

// ── POST: results ─────────────────────────────────────────────────────────────

const NO_OFFER: ParityOffer = {
  price: null,
  originalPrice: null,
  labels: [],
  availability: 'not_available',
};

export async function POST(req: NextRequest) {
  const denied = checkSecret(req);
  if (denied) return denied;

  let payload: ParityIngestPayload;
  try {
    payload = (await req.json()) as ParityIngestPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!payload?.runId || !Array.isArray(payload.slots) || payload.slots.length === 0) {
    return NextResponse.json({ error: 'runId and non-empty slots are required' }, { status: 400 });
  }
  if (payload.source !== 'grid' && payload.source !== 'custom') {
    return NextResponse.json({ error: "source must be 'grid' or 'custom'" }, { status: 400 });
  }

  const today = pragueToday();
  const capturedAt = payload.capturedAt ? new Date(payload.capturedAt) : new Date();

  // Retry safety: a runner that POSTs the same runId twice replaces, not
  // duplicates. Observations are append-only across runs, idempotent within one.
  await db.delete(priceSnapshots).where(eq(priceSnapshots.runId, payload.runId));

  // Web column, straight from Beds24 — one offers call per slot.
  let beds24Token: string | null = null;
  try {
    beds24Token = await getAccessToken();
  } catch (err) {
    console.error('[parity-ingest] Beds24 token unavailable — Web column will be empty', err);
  }

  const rows: (typeof priceSnapshots.$inferInsert)[] = [];
  const alerts: string[] = [];

  for (const slot of payload.slots) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(slot.checkIn ?? '') || !Number.isInteger(slot.nights)) {
      continue;
    }
    const checkOut = addDays(slot.checkIn, slot.nights);
    const leadDays = diffDays(today, slot.checkIn);

    let webBySell: Record<number, number | null> = {};
    if (beds24Token) {
      try {
        const offers = await fetchOffers(beds24Token, slot.checkIn, checkOut, 2, 0);
        webBySell = Object.fromEntries(
          PARITY_UNITS.map((u) => [u.beds24RoomId, extractPrice(offersForRoom(offers, u.beds24RoomId))]),
        );
      } catch (err) {
        console.error(`[parity-ingest] Beds24 offers failed for ${slot.checkIn}`, err);
      }
    }

    for (const unit of PARITY_UNITS) {
      const scraped = slot.offers?.[unit.id] ?? {};
      const webPrice = webBySell[unit.beds24RoomId] ?? null;
      const web: ParityOffer = {
        price: webPrice,
        originalPrice: null,
        labels: [],
        availability: webPrice !== null ? 'available' : 'not_available',
      };

      const channels: [ParityChannel, ParityOffer | null][] = [
        ['web', web],
        ['airbnb', unit.airbnb ? (scraped.airbnb ?? NO_OFFER) : null],
        ['booking', unit.booking ? (scraped.booking ?? NO_OFFER) : null],
      ];

      const economics = PARITY_ECONOMICS[unit.id];
      const expectedFor = (channel: ParityChannel): number | null => {
        if (webPrice === null || !economics) return null;
        const econ = channel === 'booking' ? economics.booking : channel === 'airbnb' ? economics.airbnb : null;
        if (!econ || econ.markupPct === null) return null;
        let expected = webPrice * (1 + econ.markupPct / 100);
        for (const d of econ.stack) {
          if (d.minNights === undefined || slot.nights >= d.minNights) expected *= 1 - d.pct / 100;
        }
        return Math.round(expected);
      };

      for (const [channel, offer] of channels) {
        if (offer === null) continue; // channel not configured for this unit
        const discountPct =
          offer.price !== null && offer.originalPrice !== null && offer.originalPrice > offer.price
            ? Math.round(((offer.originalPrice - offer.price) / offer.originalPrice) * 1000) / 10
            : null;
        const expected = channel === 'web' ? null : expectedFor(channel);

        rows.push({
          runId: payload.runId,
          source: payload.source,
          unitId: unit.id,
          channel,
          checkIn: slot.checkIn,
          nights: slot.nights,
          leadDays,
          price: offer.price === null ? null : String(offer.price),
          originalPrice: offer.originalPrice === null ? null : String(offer.originalPrice),
          discountPct: discountPct === null ? null : String(discountPct),
          discounts: offer.discountBreakdown ?? null,
          labels: offer.labels.length > 0 ? offer.labels : null,
          availability: offer.availability,
          expectedPrice: expected === null ? null : String(expected),
          capturedAt,
        });

        if (expected !== null && offer.price !== null) {
          const driftPct = Math.abs(offer.price - expected) / expected * 100;
          if (driftPct > EXPECTED_DRIFT_ALERT_PCT) {
            alerts.push(
              `↔️ ${unit.label} ${channel} ${slot.checkIn} (${slot.nights}n): observed ${offer.price} Kč vs expected ${expected} Kč (${driftPct.toFixed(1)}% drift)`,
            );
          }
        }
      }

      // Booking-vs-Airbnb band check, same rule as the UI traffic light.
      const a = unit.airbnb ? (scraped.airbnb?.price ?? null) : null;
      const b = unit.booking ? (scraped.booking?.price ?? null) : null;
      if (a !== null && b !== null && a > 0) {
        const gapPct = ((b - a) / a) * 100;
        if (gapPct <= BOOKING_OVER_AIRBNB_BAND.min) {
          alerts.push(
            `🔻 ${unit.label} ${slot.checkIn} (${slot.nights}n): Booking ${b} Kč ≤ Airbnb ${a} Kč — Booking is undercutting`,
          );
        } else if (gapPct > BOOKING_OVER_AIRBNB_BAND.max) {
          alerts.push(
            `📈 ${unit.label} ${slot.checkIn} (${slot.nights}n): Booking ${b} Kč is ${gapPct.toFixed(0)}% over Airbnb ${a} Kč`,
          );
        }
      }
    }

    // Close the custom request this slot answered.
    if (slot.requestId) {
      await db
        .update(priceCheckRequests)
        .set({ status: 'done', completedAt: new Date(), runId: payload.runId, error: null })
        .where(eq(priceCheckRequests.id, slot.requestId));
    }
  }

  if (rows.length > 0) {
    const CHUNK = 100;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await db.insert(priceSnapshots).values(rows.slice(i, i + CHUNK));
    }
  }

  // Scraper health: a whole channel coming back empty across every configured
  // unit and slot is the "Booking wall is back" signal — the exact failure the
  // Vercel scraper died of, so it gets a loud alert rather than silent nulls.
  if (payload.source === 'grid') {
    for (const channel of ['airbnb', 'booking'] as const) {
      const configured = PARITY_UNITS.filter((u) => u[channel] !== null);
      if (configured.length === 0) continue;
      const channelRows = rows.filter((r) => r.channel === channel);
      const anyPrice = channelRows.some((r) => r.price !== null);
      if (channelRows.length > 0 && !anyPrice) {
        alerts.unshift(
          `🛑 Parity runner: ${channel} returned NO prices for any unit/slot this run — the scraper is likely being blocked.`,
        );
      }
    }
  }

  // Alerts only for the scheduled grid — a custom check is interactive and its
  // result is already on the operator's screen; pinging the group would be noise.
  if (payload.source === 'grid' && alerts.length > 0) {
    const MAX_LINES = 10;
    const message = [
      `⚖️ <b>Price parity — grid run</b> (${payload.slots.length} stays)`,
      ...alerts.slice(0, MAX_LINES),
      ...(alerts.length > MAX_LINES ? [`… and ${alerts.length - MAX_LINES} more`] : []),
    ].join('\n');
    await sendTelegram(message);
  }

  return NextResponse.json({ inserted: rows.length, alerts: alerts.length });
}

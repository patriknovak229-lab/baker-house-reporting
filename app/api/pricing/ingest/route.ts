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
import { and, desc, eq, inArray, lt, ne } from 'drizzle-orm';
import { db } from '@/lib/db';
import { priceCheckRequests, priceSnapshots } from '@/lib/db/schema';
import { getAccessToken } from '@/utils/beds24Auth';
import { extractPrice, fetchOffers, offersForRoom } from '@/utils/beds24Pricing';
import { pragueToday } from '@/utils/periodUtils';
import { pricingChatId, sendTelegram } from '@/utils/telegram';
import {
  AIRBNB_VS_BOOKING_TOLERANCE_PCT,
  bookingMemberFloor,
  COMPETITORS,
  EXPECTED_DRIFT_ALERT_PCT,
  PARITY_CONFIG_VERSION,
  PARITY_ECONOMICS,
  PARITY_SWEEP,
  PARITY_UNITS,
} from '@/data/parityConfig';
import {
  classifyUnsoldStay,
  loadNightMap,
  minStayAt,
  planSweepSlots,
  type NightMap,
} from '@/data-access/pricing/planSlots';
import type {
  ParityChannel,
  ParityIngestPayload,
  ParityOffer,
  ParityWorkOrder,
} from '@/utils/parityTypes';

export const dynamic = 'force-dynamic';
// Grid ingests make ~1 Beds24 offers call per swept check-in and stay length
// (1n/2n/3n/7n window sweeps + slots ≈ 190 sequential calls at a few hundred
// ms each) before the batch insert.
export const maxDuration = 300;

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

  const gridDue = lastGridDate === null || lastGridDate < today;

  // The concrete scrape plan. Also sent when the caller forces a plan
  // (?plan=1) — used by manual runner invocations that re-run a day.
  // ?full=1 plans EVERY sellable 2-night check-in instead of the rotation —
  // a one-off backfill mode (PARITY_FULL_SWEEP=1 on the runner).
  const wantPlan = gridDue || req.nextUrl.searchParams.get('plan') === '1';
  const full = req.nextUrl.searchParams.get('full') === '1';

  const order: ParityWorkOrder = {
    today,
    configVersion: PARITY_CONFIG_VERSION,
    lastGridDate,
    gridDue,
    slots: wantPlan ? await planSweepSlots(today, { full }) : undefined,
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

  // Night-level open/min-stay data (PriceLabs snapshot) so a no-offer web row
  // can say WHY: 'restricted' (open, min-stay blocks the length — K.201 runs
  // min-stay 3 for whole months) vs 'not_available' (a night is booked).
  let nightMap: NightMap = new Map();
  try {
    nightMap = await loadNightMap(today, addDays(today, PARITY_SWEEP.windowDays + 7));
  } catch (err) {
    console.error('[parity-ingest] night map unavailable — min-stay attribution off', err);
  }
  const webOffer = (unitId: string, checkIn: string, nights: number, price: number | null): ParityOffer => {
    if (price !== null) {
      return { price, originalPrice: null, labels: [], availability: 'available' };
    }
    const availability = classifyUnsoldStay(nightMap, unitId, checkIn, nights);
    const minStay = availability === 'restricted' ? minStayAt(nightMap, unitId, checkIn) : null;
    return {
      price: null,
      originalPrice: null,
      labels: minStay !== null ? [`Min stay ${minStay}`] : [],
      availability,
    };
  };

  const rows: (typeof priceSnapshots.$inferInsert)[] = [];
  const alerts: string[] = [];
  // Gap violations carry a stable key so recurring ones (the same undercut
  // persists for days) can be reported as a count instead of re-pinging the
  // ops group with an identical list every morning.
  const gapAlerts: { key: string; line: string }[] = [];

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
      const web = webOffer(unit.id, slot.checkIn, slot.nights, webPrice);

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

      // Parity rules — Booking.com is the baseline channel.
      const a = unit.airbnb ? (scraped.airbnb?.price ?? null) : null;
      const b = unit.booking ? (scraped.booking?.price ?? null) : null;
      const w = webPrice;
      const stay = `${slot.checkIn} (${slot.nights}n)`;

      // 1. Airbnb must sit INSIDE Booking's price corridor: no lower than the
      // derived Genius/app floor (undercutting the baseline channel), no
      // higher than the anonymous price + tolerance (visibly dearer). The
      // floor sits ~19% under anonymous by design, so a single band around
      // either price alone flags one structural regime or the other.
      const bFloor = b !== null ? bookingMemberFloor(b, scraped.booking?.labels ?? []) : null;
      if (a !== null && b !== null && b > 0 && bFloor !== null) {
        const tol = AIRBNB_VS_BOOKING_TOLERANCE_PCT / 100;
        if (a > b * (1 + tol)) {
          gapAlerts.push({
            key: `ab:${unit.id}:${slot.checkIn}:${slot.nights}`,
            line: `↕️ ${unit.label} ${stay}: Airbnb ${a} Kč is ${(((a - b) / b) * 100).toFixed(0)}% above Booking's anonymous ${b} Kč (allowed +${AIRBNB_VS_BOOKING_TOLERANCE_PCT}%)`,
          });
        } else if (a < bFloor * (1 - tol)) {
          gapAlerts.push({
            key: `ab:${unit.id}:${slot.checkIn}:${slot.nights}`,
            line: `↕️ ${unit.label} ${stay}: Airbnb ${a} Kč is ${(((bFloor - a) / bFloor) * 100).toFixed(0)}% below even Booking's Genius/app price ${bFloor} Kč — Airbnb undercuts the baseline channel`,
          });
        }
      }

      // 2. The direct site must never be the expensive option. 1% grace
      // absorbs decimal-vs-rounded comparisons (web offers carry cents).
      if (w !== null) {
        const dearer: string[] = [];
        if (b !== null && w > b * 1.01) dearer.push(`Booking ${b} Kč`);
        if (a !== null && w > a * 1.01) dearer.push(`Airbnb ${a} Kč`);
        if (dearer.length > 0) {
          // When Booking is the cheaper one because Booking itself funds a
          // discount out of its commission ("Booking.com pays"), that is out
          // of our control — still worth alerting, but the line says why.
          const bookingFunded = (scraped.booking?.labels ?? []).includes('Booking.com pays');
          gapAlerts.push({
            key: `web:${unit.id}:${slot.checkIn}:${slot.nights}`,
            line: `🚨 ${unit.label} ${stay}: our site ${Math.round(w)} Kč is ABOVE ${dearer.join(' and ')}${bookingFunded ? ' — includes a “Booking.com pays” discount funded by Booking, not by us' : ''}`,
          });
        }
      }
    }

    // Competitor observations ride along in the same payload, keyed
    // `comp:<id>`. Stored as-is: no web enrichment, no expected price, no
    // alerts — they are context, not parity subjects.
    for (const [key, channels] of Object.entries(slot.offers ?? {})) {
      if (!key.startsWith('comp:')) continue;
      if (!COMPETITORS.some((c) => `comp:${c.id}` === key)) continue;
      for (const channel of ['airbnb', 'booking'] as const) {
        const offer = channels[channel];
        if (!offer) continue;
        const discountPct =
          offer.price !== null && offer.originalPrice !== null && offer.originalPrice > offer.price
            ? Math.round(((offer.originalPrice - offer.price) / offer.originalPrice) * 1000) / 10
            : null;
        rows.push({
          runId: payload.runId,
          source: payload.source,
          unitId: key,
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
          expectedPrice: null,
          capturedAt,
        });
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

  // Full-window availability + Web sweep (grid runs only): every check-in in
  // each board's window gets a fresh Web row daily whether or not it was
  // scraped — one Beds24 offers call per date per stay length. This is what
  // keeps the occupancy boards complete while the channel scrapes rotate, and
  // it costs no page loads at all. Rows are written only for the units whose
  // board uses that stay length (2n = studios, 3n = 2BRs, 1n/7n = all).
  if (payload.source === 'grid' && beds24Token) {
    const sweeps: { nights: number; fromLead: number; toLead: number; units: typeof PARITY_UNITS }[] = [
      { nights: 1, fromLead: 1, toLead: PARITY_SWEEP.oneNightDays, units: PARITY_UNITS },
      {
        nights: 2,
        fromLead: PARITY_SWEEP.minLeadDays,
        toLead: PARITY_SWEEP.windowDays,
        units: PARITY_UNITS.filter((u) => u.shortStayNights === 2),
      },
      {
        nights: 3,
        fromLead: PARITY_SWEEP.minLeadDays,
        toLead: PARITY_SWEEP.windowDays,
        units: PARITY_UNITS.filter((u) => u.shortStayNights === 3),
      },
      { nights: 7, fromLead: PARITY_SWEEP.minLeadDays, toLead: PARITY_SWEEP.windowDays, units: PARITY_UNITS },
    ];
    for (const sweep of sweeps) {
      const covered = new Set(
        payload.slots.filter((s) => s.nights === sweep.nights).map((s) => s.checkIn),
      );
      for (let lead = sweep.fromLead; lead <= sweep.toLead; lead++) {
        const checkIn = addDays(today, lead);
        if (covered.has(checkIn)) continue;
        try {
          const offers = await fetchOffers(beds24Token, checkIn, addDays(checkIn, sweep.nights), 2, 0);
          for (const unit of sweep.units) {
            const price = extractPrice(offersForRoom(offers, unit.beds24RoomId));
            const offer = webOffer(unit.id, checkIn, sweep.nights, price);
            rows.push({
              runId: payload.runId,
              source: payload.source,
              unitId: unit.id,
              channel: 'web',
              checkIn,
              nights: sweep.nights,
              leadDays: lead,
              price: price === null ? null : String(price),
              originalPrice: null,
              discountPct: null,
              discounts: null,
              labels: offer.labels.length > 0 ? offer.labels : null,
              availability: offer.availability,
              expectedPrice: null,
              capturedAt,
            });
          }
        } catch (err) {
          console.error(`[parity-ingest] web sweep failed for ${checkIn} (${sweep.nights}n)`, err);
        }
      }
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
  //
  // Gap violations persist for days (an undercut stays until someone moves a
  // rate), so the message lists only NEW ones — everything already flagged in
  // the previous grid run collapses into a count. Otherwise the group gets an
  // identical 15-line wall every morning and learns to ignore it.
  if (payload.source === 'grid' && (alerts.length > 0 || gapAlerts.length > 0)) {
    const prevKeys = new Set<string>();
    try {
      const [prev] = await db
        .select({ runId: priceSnapshots.runId })
        .from(priceSnapshots)
        .where(and(eq(priceSnapshots.source, 'grid'), ne(priceSnapshots.runId, payload.runId)))
        .orderBy(desc(priceSnapshots.capturedAt))
        .limit(1);
      if (prev) {
        // Rebuild the SAME violation keys from the previous run's rows — the
        // rules here must stay in lockstep with the checks above.
        const prevRows = await db
          .select()
          .from(priceSnapshots)
          .where(
            and(
              eq(priceSnapshots.runId, prev.runId),
              inArray(priceSnapshots.channel, ['web', 'airbnb', 'booking']),
            ),
          );
        const byKey = new Map<
          string,
          { a?: number | null; b?: number | null; w?: number | null; bLabels?: string[] }
        >();
        for (const r of prevRows) {
          if (r.unitId.startsWith('comp:')) continue;
          const k = `${r.unitId}:${r.checkIn}:${r.nights}`;
          const entry = byKey.get(k) ?? {};
          const price = r.price === null ? null : Number(r.price);
          if (r.channel === 'airbnb') entry.a = price;
          if (r.channel === 'booking') {
            entry.b = price;
            entry.bLabels = Array.isArray(r.labels) ? (r.labels as string[]) : [];
          }
          if (r.channel === 'web') entry.w = price;
          byKey.set(k, entry);
        }
        for (const [k, { a, b, w, bLabels }] of byKey) {
          if (a != null && b != null && b > 0) {
            const floor = bookingMemberFloor(b, bLabels ?? []);
            const tol = AIRBNB_VS_BOOKING_TOLERANCE_PCT / 100;
            if (a > b * (1 + tol) || a < floor * (1 - tol)) prevKeys.add(`ab:${k}`);
          }
          if (w != null && ((b != null && w > b * 1.01) || (a != null && w > a * 1.01))) {
            prevKeys.add(`web:${k}`);
          }
        }
      }
    } catch (err) {
      console.error('[parity-ingest] previous-run alert diff failed', err);
    }

    const fresh = gapAlerts.filter((g) => !prevKeys.has(g.key));
    const ongoing = gapAlerts.length - fresh.length;

    if (alerts.length > 0 || fresh.length > 0) {
      const MAX_LINES = 10;
      const lines = [...alerts, ...fresh.map((g) => g.line)];
      const message = [
        `⚖️ <b>Price parity — grid run</b> (${payload.slots.length} stays)`,
        ...lines.slice(0, MAX_LINES),
        ...(lines.length > MAX_LINES ? [`… and ${lines.length - MAX_LINES} more`] : []),
        ...(ongoing > 0
          ? [`↺ ${ongoing} known violation${ongoing === 1 ? '' : 's'} still in effect — see the Pricing board`]
          : []),
      ].join('\n');
      await sendTelegram(message, { chatId: pricingChatId() });
    }
  }

  return NextResponse.json({ inserted: rows.length, alerts: alerts.length });
}

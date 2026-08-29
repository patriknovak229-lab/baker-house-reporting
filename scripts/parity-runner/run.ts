/**
 * Parity runner — the local half of the price parity monitor.
 *
 * Runs on the operator's Mac (launchd, every 5 minutes — see
 * docs/pricing-runner.md). Each invocation:
 *
 *   1. Asks the reporting app for a work order (GET /api/pricing/ingest):
 *      is today's grid run still due, and which custom checks are queued.
 *   2. If there is nothing to do, exits silently — most invocations do this.
 *   3. Scrapes Booking.com + Airbnb in the local real Chrome (residential IP;
 *      Vercel datacenter IPs are bot-walled by Booking.com).
 *   4. POSTs observations back; the server adds the Beds24 Web column,
 *      computes expected prices, stores history, and fires parity alerts.
 *
 * Requires in .env.local: PRICING_INGEST_SECRET, CHROME_EXECUTABLE_PATH.
 * Optional: PARITY_INGEST_URL (defaults to production), RUNNER_HEADFUL=1 to
 * watch the browser work, PARITY_GRID_AFTER=HH:MM Prague gate for the daily
 * grid run (default 08:00).
 */
import '../_loadEnv';
import puppeteer, { type Browser } from 'puppeteer-core';
import { PARITY_GRID, PARITY_UNITS } from '../../data/parityConfig';
import type {
  ParityIngestPayload,
  ParityOffer,
  ParitySlotResult,
  ParityWorkOrder,
} from '../../utils/parityTypes';
import { scrapeBookingSlots } from './bookingScraper';
import { scrapeAirbnbViaBrowser } from './airbnbScraper';

const RUNNER_VERSION = 'parity-runner/1.0';

const BASE_URL = (process.env.PARITY_INGEST_URL ?? 'https://reporting.bakerhouseapartments.cz').replace(/\/$/, '');
const SECRET = process.env.PRICING_INGEST_SECRET ?? '';
const CHROME = process.env.CHROME_EXECUTABLE_PATH ?? '';

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function pragueNowHHMM(): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Prague',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'x-parity-secret': SECRET, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    throw new Error(`${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

interface WorkSlot {
  checkIn: string;
  checkOut: string;
  nights: number;
  requestId?: number;
}

async function main() {
  if (!SECRET) throw new Error('PRICING_INGEST_SECRET is not set in .env.local');
  if (!CHROME) throw new Error('CHROME_EXECUTABLE_PATH is not set in .env.local');

  const order = await api<ParityWorkOrder>('/api/pricing/ingest');

  // The daily grid waits for a civilised hour so the sample time is stable —
  // comparing a 03:00 scrape to yesterday's 09:00 scrape adds noise for free.
  const gridAfter = process.env.PARITY_GRID_AFTER ?? '08:00';
  const gridWanted = order.gridDue && pragueNowHHMM() >= gridAfter;

  const gridSlots: WorkSlot[] = gridWanted
    ? PARITY_GRID.map(({ leadDays, nights }) => ({
        checkIn: addDays(order.today, leadDays),
        checkOut: addDays(order.today, leadDays + nights),
        nights,
      }))
    : [];

  const customSlots: WorkSlot[] = order.pendingRequests.map((r) => ({
    checkIn: r.checkIn,
    checkOut: addDays(r.checkIn, r.nights),
    nights: r.nights,
    requestId: r.id,
  }));

  const allSlots = [...gridSlots, ...customSlots];
  if (allSlots.length === 0) {
    console.log(`[runner] nothing to do (gridDue=${order.gridDue}, after=${gridAfter}, pending=0)`);
    return;
  }
  console.log(
    `[runner] work order: ${gridSlots.length} grid slot(s), ${customSlots.length} custom check(s) → ${BASE_URL}`,
  );

  const browser: Browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: process.env.RUNNER_HEADFUL === '1' ? false : true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1440,1200'],
  });

  try {
    // Booking.com — one property-page load per slot, all units on the page.
    const bookingBySlot = await scrapeBookingSlots(browser, allSlots);

    // Airbnb — one pass per configured listing across every slot.
    const airbnbByUnit = new Map<string, ParityOffer[]>();
    for (const unit of PARITY_UNITS) {
      if (!unit.airbnb) continue;
      console.log(`[runner] airbnb ${unit.id} (${unit.airbnb.listingId}) — ${allSlots.length} slot(s)`);
      const offers = await scrapeAirbnbViaBrowser(browser, unit.airbnb.listingId, allSlots);
      airbnbByUnit.set(unit.id, offers);
    }

    const toSlotResult = (slot: WorkSlot, index: number): ParitySlotResult => {
      const offers: ParitySlotResult['offers'] = {};
      for (const unit of PARITY_UNITS) {
        const entry: ParitySlotResult['offers'][string] = {};
        if (unit.booking) entry.booking = bookingBySlot[index]?.[unit.id];
        if (unit.airbnb) entry.airbnb = airbnbByUnit.get(unit.id)?.[index];
        offers[unit.id] = entry;
      }
      return { checkIn: slot.checkIn, nights: slot.nights, requestId: slot.requestId, offers };
    };

    const stamp = new Date().toISOString();
    const runTag = stamp.replace(/[-:TZ.]/g, '').slice(0, 14);

    if (gridSlots.length > 0) {
      const payload: ParityIngestPayload = {
        runId: `grid-${runTag}`,
        source: 'grid',
        capturedAt: stamp,
        runner: RUNNER_VERSION,
        slots: gridSlots.map((s, i) => toSlotResult(s, i)),
      };
      const res = await api<{ inserted: number; alerts: number }>('/api/pricing/ingest', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      console.log(`[runner] grid ingested: ${res.inserted} rows, ${res.alerts} alert(s)`);
    }

    if (customSlots.length > 0) {
      const payload: ParityIngestPayload = {
        runId: `custom-${runTag}`,
        source: 'custom',
        capturedAt: stamp,
        runner: RUNNER_VERSION,
        slots: customSlots.map((s, i) => toSlotResult(s, gridSlots.length + i)),
      };
      const res = await api<{ inserted: number; alerts: number }>('/api/pricing/ingest', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      console.log(`[runner] custom ingested: ${res.inserted} rows, ${res.alerts} alert(s)`);
    }
  } finally {
    await browser.close().catch(() => null);
  }
}

main().catch((err) => {
  console.error('[runner] FAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

/**
 * Parity runner — the local half of the price parity monitor.
 *
 * Runs on the operator's Mac (launchd, every 15 minutes, skipping Prague
 * night hours — see docs/pricing-runner.md). Each invocation:
 *
 *   1. Asks the reporting app for a work order (GET /api/pricing/ingest):
 *      is today's grid run still due (server sends the concrete slot plan —
 *      an availability-aware sweep of the next 60 days), and which custom
 *      checks are queued.
 *   2. If there is nothing to do, exits silently — most invocations do this.
 *   3. Scrapes Booking.com + Airbnb in the local real Chrome (residential IP;
 *      Vercel datacenter IPs are bot-walled by Booking.com). Airbnb loads are
 *      skipped for units the plan says cannot sell the stay. Competitor
 *      listings from data/parityConfig ride along on grid runs.
 *   4. POSTs observations back; the server adds the Beds24 Web column for the
 *      WHOLE window (the occupancy board), computes expected prices, stores
 *      history, and fires parity alerts.
 *
 * Requires in .env.local: PRICING_INGEST_SECRET, CHROME_EXECUTABLE_PATH.
 * Optional: PARITY_INGEST_URL (defaults to production), RUNNER_HEADFUL=1 to
 * watch the browser work, PARITY_GRID_AFTER=HH:MM Prague gate for the daily
 * grid run (default 08:00), PARITY_FORCE_GRID=1 to re-run today's grid,
 * PARITY_FULL_SWEEP=1 for a one-off backfill that scrapes EVERY sellable
 * 2-night check-in in the window instead of the daily rotation (~30 min).
 */
import '../_loadEnv';
import puppeteer, { type Browser } from 'puppeteer-core';
import { COMPETITORS, COMPETITOR_LEADS, PARITY_GRID, PARITY_UNITS } from '../../data/parityConfig';
import type {
  ParityIngestPayload,
  ParityOffer,
  ParitySlotResult,
  ParityWorkOrder,
} from '../../utils/parityTypes';
import { scrapeBookingSlots, scrapeCompetitorBooking } from './bookingScraper';
import { scrapeAirbnbViaBrowser } from './airbnbScraper';

const RUNNER_VERSION = 'parity-runner/2.0';

const BASE_URL = (process.env.PARITY_INGEST_URL ?? 'https://reporting.bakerhouseapartments.cz').replace(/\/$/, '');
const SECRET = process.env.PRICING_INGEST_SECRET ?? '';
const CHROME = process.env.CHROME_EXECUTABLE_PATH ?? '';
const FULL_SWEEP = process.env.PARITY_FULL_SWEEP === '1';
const FORCE_GRID = process.env.PARITY_FORCE_GRID === '1' || FULL_SWEEP;

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

function pragueTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date());
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
  /** Unit ids the plan believes sellable; undefined = scrape everything. */
  units?: string[];
  requestId?: number;
}

async function main() {
  if (!SECRET) throw new Error('PRICING_INGEST_SECRET is not set in .env.local');
  if (!CHROME) throw new Error('CHROME_EXECUTABLE_PATH is not set in .env.local');

  // Quiet hours: exit BEFORE calling the API — the work-order poll itself
  // queries Postgres, and Neon bills compute time whenever the database is
  // awake (it auto-suspends after ~5 idle minutes). Nothing scrapes at night
  // anyway (grid gates on PARITY_GRID_AFTER). Override: PARITY_QUIET_HOURS
  // ("start-end" in Prague hours, default 0-7, "off" disables); manual
  // force/full runs skip the gate.
  const quiet = process.env.PARITY_QUIET_HOURS ?? '0-7';
  if (!FORCE_GRID && quiet !== 'off') {
    const [qStart, qEnd] = quiet.split('-').map((n) => parseInt(n, 10));
    const hour = parseInt(
      new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hour: '2-digit', hour12: false }).format(new Date()),
      10,
    );
    const inQuiet = qStart <= qEnd ? hour >= qStart && hour < qEnd : hour >= qStart || hour < qEnd;
    if (Number.isFinite(qStart) && Number.isFinite(qEnd) && inQuiet) return;
  }

  const startedAtMs = Date.now();
  const order = await api<ParityWorkOrder>(
    `/api/pricing/ingest${FORCE_GRID ? `?plan=1${FULL_SWEEP ? '&full=1' : ''}` : ''}`,
  );

  // The daily grid waits for a civilised hour so the sample time is stable —
  // comparing a 03:00 scrape to yesterday's 09:00 scrape adds noise for free.
  const gridAfter = process.env.PARITY_GRID_AFTER ?? '08:00';
  const gridWanted = FORCE_GRID || (order.gridDue && pragueNowHHMM() >= gridAfter);

  // Server-planned sweep; fall back to the fixed relative grid when talking
  // to an older deployment that sent no plan.
  const gridSlots: WorkSlot[] = gridWanted
    ? (order.slots ?? PARITY_GRID.map(({ leadDays, nights }) => ({
        checkIn: addDays(order.today, leadDays),
        nights,
        units: undefined,
      }))).map((s) => ({
        checkIn: s.checkIn,
        checkOut: addDays(s.checkIn, s.nights),
        nights: s.nights,
        units: 'units' in s ? s.units : undefined,
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
    `[runner] work order v${order.configVersion ?? '?'}: ${gridSlots.length} grid slot(s), ${customSlots.length} custom check(s), ${gridWanted ? COMPETITORS.length : 0} competitor(s) → ${BASE_URL}`,
  );

  const launchBrowser = (): Promise<Browser> =>
    puppeteer.launch({
      executablePath: CHROME,
      headless: process.env.RUNNER_HEADFUL === '1' ? false : true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1440,1200'],
    });
  let browser: Browser = await launchBrowser();

  // Chrome can die mid-run (Airbnb's heavy pages have crashed the renderer
  // ~25 loads into a listing — observed twice on 2026-08-31). One phase's
  // death must not lose the whole run: relaunch the browser and carry on with
  // 'error' offers for whatever was lost; the POST still delivers everything
  // else, and the server's channel-empty health alert flags a total loss.
  const reviveBrowser = async () => {
    if (browser.connected) return;
    console.log('[runner] browser died — relaunching');
    await browser.close().catch(() => null);
    browser = await launchBrowser();
  };

  const ERROR_OFFER: ParityOffer = { price: null, originalPrice: null, labels: [], availability: 'error' };

  try {
    // Booking.com — one property-page load per slot (skipped when the plan
    // says no unit on the page can sell the stay).
    let bookingBySlot: Record<string, ParityOffer>[];
    try {
      bookingBySlot = await scrapeBookingSlots(
        browser,
        allSlots,
        allSlots.map((s) => s.units),
      );
    } catch (err) {
      console.log(`[runner] booking phase failed entirely: ${err instanceof Error ? err.message : err}`);
      bookingBySlot = allSlots.map(() =>
        Object.fromEntries(PARITY_UNITS.filter((u) => u.booking).map((u) => [u.id, { ...ERROR_OFFER }])),
      );
      await reviveBrowser();
    }

    // Airbnb — one pass per configured listing, only over slots where the
    // plan says that unit can actually sell the stay.
    const airbnbByUnit = new Map<string, Map<number, ParityOffer>>();
    for (const unit of PARITY_UNITS) {
      if (!unit.airbnb) continue;
      const indices = allSlots
        .map((s, i) => (s.units === undefined || s.units.includes(unit.id) ? i : -1))
        .filter((i) => i >= 0);
      if (indices.length === 0) continue;
      console.log(`[runner] airbnb ${unit.id} (${unit.airbnb.listingId}) — ${indices.length}/${allSlots.length} slot(s)`);
      try {
        await reviveBrowser();
        const offers = await scrapeAirbnbViaBrowser(
          browser,
          unit.airbnb.listingId,
          indices.map((i) => allSlots[i]),
        );
        airbnbByUnit.set(unit.id, new Map(indices.map((slotIdx, k) => [slotIdx, offers[k]])));
      } catch (err) {
        console.log(`[runner] airbnb ${unit.id} failed entirely: ${err instanceof Error ? err.message : err}`);
        airbnbByUnit.set(unit.id, new Map(indices.map((slotIdx) => [slotIdx, { ...ERROR_OFFER }])));
        await reviveBrowser();
      }
    }

    const toSlotResult = (slot: WorkSlot, index: number): ParitySlotResult => {
      const offers: ParitySlotResult['offers'] = {};
      for (const unit of PARITY_UNITS) {
        const entry: ParitySlotResult['offers'][string] = {};
        if (unit.booking) entry.booking = bookingBySlot[index]?.[unit.id];
        if (unit.airbnb) {
          const scraped = airbnbByUnit.get(unit.id)?.get(index);
          // Skipped-by-plan = the stay was unsellable per Beds24 — record it
          // as such rather than leaving a hole in the board.
          entry.airbnb = scraped ?? { price: null, originalPrice: null, labels: [], availability: 'not_available' };
        }
        offers[unit.id] = entry;
      }
      return { checkIn: slot.checkIn, nights: slot.nights, requestId: slot.requestId, offers };
    };

    // A Mac that sleeps mid-scrape resumes the process hours later and would
    // post a stale mix (and, worse, pile on top of the day's real grid run —
    // three Telegram pings inside 30 minutes on 2026-08-31). If the run took
    // implausibly long or the Prague date moved on, throw the data away; the
    // work order machinery re-runs cleanly on the next poll.
    if (pragueTodayIso() !== order.today || Date.now() - startedAtMs > 3 * 3_600_000) {
      console.log(
        `[runner] abandoning stale run: work order for ${order.today}, now ${pragueTodayIso()}, ` +
          `${Math.round((Date.now() - startedAtMs) / 60_000)} min elapsed (slept mid-run?)`,
      );
      return;
    }

    const stamp = new Date().toISOString();
    const runTag = stamp.replace(/[-:TZ.]/g, '').slice(0, 14);

    if (gridSlots.length > 0) {
      const slots = gridSlots.map((s, i) => toSlotResult(s, i));

      // Competitor pricing rides along on grid runs only.
      if (COMPETITORS.length > 0) {
        const compSlots = COMPETITOR_LEADS.map(({ leadDays, nights }) => ({
          checkIn: addDays(order.today, leadDays),
          checkOut: addDays(order.today, leadDays + nights),
          nights,
        }));
        for (const comp of COMPETITORS) {
          const key = `comp:${comp.id}`;
          const booking = comp.booking ? await scrapeCompetitorBooking(browser, comp, compSlots) : null;
          const airbnb = comp.airbnb
            ? await scrapeAirbnbViaBrowser(browser, comp.airbnb.listingId, compSlots)
            : null;
          compSlots.forEach((cs, i) => {
            let slot = slots.find((s) => s.checkIn === cs.checkIn && s.nights === cs.nights);
            if (!slot) {
              slot = { checkIn: cs.checkIn, nights: cs.nights, offers: {} };
              slots.push(slot);
            }
            const entry: Partial<Record<'airbnb' | 'booking', ParityOffer>> = {};
            if (booking) entry.booking = booking[i];
            if (airbnb) entry.airbnb = airbnb[i];
            slot.offers[key] = entry;
          });
        }
      }

      const payload: ParityIngestPayload = {
        runId: `grid-${runTag}`,
        source: 'grid',
        capturedAt: stamp,
        runner: RUNNER_VERSION,
        slots,
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

/**
 * Booking.com scraper — structured extraction from the server-rendered room
 * table (.hprt-table), NOT innerText archaeology.
 *
 * Why this works where the Vercel scraper died: it runs in a real Chrome on a
 * residential IP (the operator's Mac), which Booking serves the full page to.
 * And instead of walking innerText lines, it reads the stable structure the
 * page ships: `room_type_id_*` anchors identify the room, each rate row's
 * price block carries explicit "Original price X / Current price Y" text, and
 * %-off badges sit inside the row. Deal-name matching is scoped to the ROW, so
 * page-wide marketing copy can't leak in (the old scraper's false-positive
 * problem).
 */
import type { Browser } from 'puppeteer-core';
import { PARITY_UNITS } from '../../data/parityConfig';
import type { ParityOffer } from '../../utils/parityTypes';

const BOOKING_BASE = 'https://www.booking.com';

const NO_OFFER: ParityOffer = {
  price: null,
  originalPrice: null,
  labels: [],
  availability: 'not_available',
};

interface RawRateRow {
  roomTypeId: string;
  price: number | null;
  originalPrice: number | null;
  maxPersons: number | null;
  pctOff: number | null;
  dealNames: string[];
}

/**
 * Scrape one property page for one stay. Returns offers keyed by unit id for
 * every PARITY_UNITS entry whose booking config points at this page.
 */
export async function scrapeBookingSlots(
  browser: Browser,
  slots: { checkIn: string; checkOut: string }[],
): Promise<Record<string, ParityOffer>[]> {
  const configured = PARITY_UNITS.filter((u) => u.booking !== null);
  const pagePaths = [...new Set(configured.map((u) => u.booking!.pagePath))];

  const page = await browser.newPage();
  // tsx/esbuild rewrites named inline functions to reference a `__name` helper
  // that does not exist inside the browser context — polyfill it on every
  // document or every page.evaluate() with a named callback throws.
  await page.evaluateOnNewDocument('window.__name = (fn) => fn;');
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-GB,en;q=0.9' });
  await page.setViewport({ width: 1440, height: 1200 });

  const results: Record<string, ParityOffer>[] = [];

  for (const slot of slots) {
    const slotResult: Record<string, ParityOffer> = {};
    for (const unit of configured) slotResult[unit.id] = { ...NO_OFFER };

    for (const pagePath of pagePaths) {
      const unitsOnPage = configured.filter((u) => u.booking!.pagePath === pagePath);
      const url =
        `${BOOKING_BASE}${pagePath}?checkin=${slot.checkIn}&checkout=${slot.checkOut}` +
        `&group_adults=2&no_rooms=1&group_children=0&selected_currency=CZK`;

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page
          .evaluate(() => {
            document
              .querySelector<HTMLElement>('#onetrust-accept-btn-handler, [data-testid="accept-cookies-button"]')
              ?.click();
          })
          .catch(() => null);
        const tableReady = await page
          .waitForSelector('.hprt-table', { timeout: 15_000 })
          .then(() => true)
          .catch(() => false);

        if (!tableReady) {
          const diag = await page.evaluate(() => ({
            title: document.title,
            bodyLen: (document.body?.innerText ?? '').length,
            soldOut: /no availability|sold out|change your dates/i.test(document.body?.innerText ?? ''),
            challenge: /captcha|are you a human|verify|robot/i.test(document.body?.innerText ?? ''),
          }));
          console.log(
            `[runner] booking ${slot.checkIn}: no room table (soldOut=${diag.soldOut} challenge=${diag.challenge} bodyLen=${diag.bodyLen} title=${JSON.stringify(diag.title)})`,
          );
          if (diag.challenge) {
            for (const unit of unitsOnPage) slotResult[unit.id] = { ...NO_OFFER, availability: 'error' };
          }
          continue;
        }
        await new Promise((r) => setTimeout(r, 1200));

        const rawRows: RawRateRow[] = await page.evaluate(() => {
          const parseAmount = (raw: string): number | null => {
            const cleaned = raw.replace(/ /g, ' ');
            const m = cleaned.match(/(\d[\d ,.]{0,15})\s*(?:Kč|CZK)/);
            if (!m) return null;
            const token = m[1].trim();
            const hasCents = /[.,]\d{2}$/.test(token);
            const digits = token.replace(/[^\d]/g, '');
            if (!digits) return null;
            const n = parseInt(digits, 10);
            return hasCents ? Math.round(n / 100) : n;
          };

          // Deal names are matched inside ONE rate row only. Bare "Genius" is
          // included: within a row it is the programme badge, not help copy.
          const DEAL_PATTERNS: [string, RegExp][] = [
            ['Early Booker Deal', /Early\s*(?:\d{4}\s*)?Booker?\s*Deal|Early\s*Booker/i],
            ['Getaway Deal', /Getaway\s*Deal/i],
            ['Last Minute Deal', /Last[- ]?Minute\s*Deal/i],
            ['Smart Deal', /Smart\s*Deal/i],
            ['Weekly rate', /Weekly\s*(?:rate|deal|discount)/i],
            ['Monthly rate', /Monthly\s*(?:rate|deal|discount)/i],
            ['Mobile-only', /Mobile[- ]?only/i],
            ['Genius', /Genius/i],
            ['Limited-time Deal', /Limited[- ]?time\s*Deal/i],
          ];

          const table = document.querySelector('.hprt-table');
          if (!table) return [];
          const out: {
            roomTypeId: string;
            price: number | null;
            originalPrice: number | null;
            maxPersons: number | null;
            pctOff: number | null;
            dealNames: string[];
          }[] = [];

          let currentRoomId = '';
          for (const tr of Array.from(table.querySelectorAll('tbody tr'))) {
            const anchor = tr.querySelector('[id^="room_type_id_"]');
            if (anchor) currentRoomId = anchor.id.replace('room_type_id_', '');
            if (!currentRoomId) continue;

            const priceBlock = tr.querySelector<HTMLElement>('.hprt-price-block');
            const priceText = (priceBlock?.innerText ?? '').replace(/\s+/g, ' ');
            if (!/\d/.test(priceText)) continue;

            // Preferred: the explicit accessible labels Booking renders.
            let originalPrice: number | null = null;
            let price: number | null = null;
            const origM = priceText.match(/Original price[:\s]*([\d ,. ]+\s*(?:Kč|CZK))/i);
            const currM = priceText.match(/Current price[:\s]*([\d ,. ]+\s*(?:Kč|CZK))/i);
            if (origM) originalPrice = parseAmount(origM[1]);
            if (currM) price = parseAmount(currM[1]);

            // Fallback: strikethrough element + first non-struck amount.
            if (price === null && priceBlock) {
              const struck = priceBlock.querySelector<HTMLElement>('s, del, [class*="strikethrough" i]');
              if (struck) originalPrice = parseAmount(struck.innerText ?? '');
              price = parseAmount(priceText.replace(/Original price[^K]*(?:Kč|CZK)/i, ''));
            }
            if (price === null) continue;
            if (originalPrice !== null && originalPrice <= price) originalPrice = null;

            const occText = tr.querySelector<HTMLElement>('.hprt-occupancy-occupancy-info')?.innerText ?? '';
            const occM = occText.match(/Max\s*persons?:?\s*(\d+)/i) ?? occText.match(/(\d+)\s*(?:adults?|guests?)/i);
            // A bare occupancy cell full of person icons still means the row
            // is bookable; unknown counts as null and is kept.
            const maxPersons = occM ? parseInt(occM[1], 10) : null;

            const rowText = (tr as HTMLElement).innerText ?? '';
            const pctM = rowText.match(/(\d{1,2})\s*%\s*off/i);
            const dealNames: string[] = [];
            for (const [label, re] of DEAL_PATTERNS) {
              if (re.test(rowText) && !dealNames.includes(label)) dealNames.push(label);
            }

            out.push({
              roomTypeId: currentRoomId,
              price,
              originalPrice,
              maxPersons,
              pctOff: pctM ? parseInt(pctM[1], 10) : null,
              dealNames,
            });
          }
          return out;
        });

        console.log(`[runner] booking ${slot.checkIn}→${slot.checkOut}: ${rawRows.length} rate rows`);

        for (const unit of unitsOnPage) {
          const roomRows = rawRows.filter((r) => r.roomTypeId === unit.booking!.roomTypeId);
          if (roomRows.length === 0) continue; // stays not_available

          // The customer-view price: cheapest rate a 2-adult stay can book.
          // Rows priced for 1 person are excluded when 2-person rows exist.
          const twoPerson = roomRows.filter((r) => r.maxPersons === null || r.maxPersons >= 2);
          const eligible = twoPerson.length > 0 ? twoPerson : roomRows;
          eligible.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
          const best = eligible[0];

          const labels = [...best.dealNames];
          if (best.pctOff !== null && labels.length === 0) labels.push(`${best.pctOff}% off`);

          slotResult[unit.id] = {
            price: best.price,
            originalPrice: best.originalPrice,
            labels,
            availability: 'available',
          };
          console.log(
            `[runner]   ${unit.id}: ${best.price} Kč${best.originalPrice ? ` (was ${best.originalPrice})` : ''}${labels.length ? ` [${labels.join(', ')}]` : ''}`,
          );
        }
      } catch (err) {
        console.log(`[runner] booking ${slot.checkIn} failed: ${err instanceof Error ? err.message : err}`);
        for (const unit of unitsOnPage) slotResult[unit.id] = { ...NO_OFFER, availability: 'error' };
      }
    }
    results.push(slotResult);
  }

  await page.close();
  return results;
}

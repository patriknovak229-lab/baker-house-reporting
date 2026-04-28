import chromium from '@sparticuz/chromium';
import puppeteer, { type Browser } from 'puppeteer-core';

// ─────────────────────────────────────────────
// Listing identifiers
// ─────────────────────────────────────────────

export const AIRBNB_K201_ID = '1635011413648373253'; // K.201 — 2KK Deluxe
// 1KK is two separate Airbnb listings (same room type, one qty=2 block on Booking.com).
// We scrape both and take whichever is available / cheapest.
export const AIRBNB_K202_ID = '1560149310755564258'; // K.202 — 1KK Deluxe unit 1
export const AIRBNB_K203_ID = '1557243344995462947'; // K.203 — 1KK Deluxe unit 2

const BOOKING_URL =
  'https://www.booking.com/hotel/cz/baker-house-apartments-brno-mesto.en-gb.html';

// Beds24 Web-column prices are fetched via API on Vercel (see TODO below).

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type DiscountLine = {
  name: string;        // e.g. "Weekly rate", "Early Booker Deal"
  amountKc: number;    // positive deduction amount in CZK
  pp: number;          // percentage points of original price (sum across lines ≈ total %)
};

export type Offer = {
  price: number | null;          // actual total CZK for the stay
  originalPrice: number | null;  // strikethrough price if a discount applies
  labels: string[];              // discount badges / rate plan features
  discountBreakdown?: DiscountLine[];
  unparsedDiscount?: boolean;    // true when % off exists but we couldn't attribute it
  availability?: 'available' | 'not_available' | 'error';
};

const NULL_OFFER: Offer = { price: null, originalPrice: null, labels: [] };

export type RoomOffers = {
  k201: Offer;
  oneKK: Offer;
};

export type PricingRoomResult = {
  roomLabel: '1KK Deluxe' | '2KK Deluxe';
  web: Offer;
  airbnb: Offer;
  bookingCom: Offer;
  spread: number | null;
};

export type PricingRun = {
  checkIn: string;
  checkOut: string;
  nights: 2 | 7;
  rooms: PricingRoomResult[];
};

export type PricingResult = {
  timestamp: string;
  runs: PricingRun[];
};

// ─────────────────────────────────────────────
// Date slot generation
// ─────────────────────────────────────────────

export function generateDateSlots(): Array<{ checkIn: string; checkOut: string; nights: 2 | 7 }> {
  // Override window via env vars (useful for local testing against known-available dates)
  const envStart = process.env.PRICING_DATE_START;
  const envEnd = process.env.PRICING_DATE_END;

  let start: Date;
  let end: Date;

  if (envStart && envEnd) {
    start = new Date(envStart + 'T00:00:00Z');
    end = new Date(envEnd + 'T00:00:00Z');
  } else {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dow = today.getDay();
    const daysUntilFriday = ((5 - dow + 7) % 7) || 7;
    start = new Date(today.getTime() + Math.max(daysUntilFriday, 3) * 86400_000);
    end = new Date(today.getTime() + 65 * 86400_000);
  }

  // Three check-in dates evenly spaced across the window
  const windowDays = Math.floor((end.getTime() - start.getTime()) / 86400_000);
  const checkInOffsets = windowDays >= 28
    ? [0, Math.floor(windowDays / 3), Math.floor((2 * windowDays) / 3)]
    : [0, Math.floor(windowDays / 2)];

  const slots: Array<{ checkIn: string; checkOut: string; nights: 2 | 7 }> = [];
  for (const offset of checkInOffsets) {
    const ci = new Date(start.getTime() + offset * 86400_000);
    for (const nights of [2, 7] as const) {
      const co = new Date(ci.getTime() + nights * 86400_000);
      if (co <= end) {
        slots.push({
          checkIn: ci.toISOString().slice(0, 10),
          checkOut: co.toISOString().slice(0, 10),
          nights,
        });
      }
    }
  }

  return slots;
}

// ─────────────────────────────────────────────
// Airbnb scraping (fetch + __NEXT_DATA__ parsing)
// ─────────────────────────────────────────────

// Parses a tooltip/panel innerText block into { originalPrice, total, discounts[] }.
// Handles TWO-COLUMN flex layout where label and amount are often rendered on
// separate innerText lines:
//    "Total"
//    "21,077.45 Kč"
// As well as single-line layouts:
//    "Total    21,077.45 Kč"
function parseTooltipBreakdown(
  text: string,
): { originalPrice: number | null; total: number | null; discounts: Array<{ name: string; amountKc: number }> } {
  const normalized = text
    // Unify inline "CZK 1000"/"Kč 1000" → "1000 Kč". CRITICAL: use [ \t] (not
    // \s) so we never match across a newline — otherwise "X Kč\nY Kč" gets
    // stitched into "X Y Kč Kč" on a single line and the downstream
    // greedy amount-matcher concatenates the two numbers.
    .replace(/(?:CZK|Kč)[ \t\u00a0]+(\d[\d ,.\u00a0]{2,20})/gi, '$1 Kč')
    .replace(/\u00a0/g, ' ');

  const parseAmount = (raw: string): number | null => {
    const stripped = raw.replace(/[^\d]/g, '');
    if (!stripped) return null;
    const n = parseInt(stripped, 10);
    const hasCents = /[.,]\d{2}(?!\d)/.test(raw);
    return hasCents ? Math.round(n / 100) : n;
  };

  const AMOUNT_RE = /([−\-–]?)\s*(\d[\d ,.\u00a0]{2,20}\s*Kč)/;

  // Walk lines. Each line either contains an amount or is a text label.
  // An amount line pairs with either:
  //   (a) the text preceding the amount on the same line, OR
  //   (b) the previous non-amount line as its label
  const rawLines = normalized.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  type Item = { label: string; amount: number; negative: boolean };
  const items: Item[] = [];
  let pendingLabel = '';

  for (const line of rawLines) {
    const am = line.match(AMOUNT_RE);
    if (!am) {
      pendingLabel = line;
      continue;
    }
    const amountStart = am.index ?? 0;
    const before = line.slice(0, amountStart).trim().replace(/[\-−–]\s*$/, '').trim();
    const label = before.length >= 2 ? before : pendingLabel;
    const amount = parseAmount(am[2]);
    const negative = am[1] === '-' || am[1] === '−' || am[1] === '–';
    if (amount !== null) items.push({ label, amount, negative });
    pendingLabel = '';
  }

  // Classify
  let total: number | null = null;
  let subtotal: number | null = null;
  const discounts: Array<{ name: string; amountKc: number }> = [];

  for (const { label, amount, negative } of items) {
    const lc = label.toLowerCase();
    if (/^total\b|^celkem\b/.test(lc) && !negative) {
      total = amount;
    } else if (negative) {
      const clean = label.trim().replace(/\s+/g, ' ');
      if (clean && clean.length <= 80 && !/×|x\s*\d|nights?\b/i.test(clean)) {
        discounts.push({ name: clean, amountKc: amount });
      }
    } else if (/\d+\s*(?:nights?|noc[ií])?\s*[×x]/i.test(label) || /nights?\s*[×x]/i.test(label)) {
      subtotal = amount;
    }
  }

  // Safety: total must exceed every discount (otherwise we've misclassified a
  // discount line as the total — e.g. "Early booking discount -3,719.55 Kč" was
  // matched as a total because the next line was literally "Total").
  if (total !== null && discounts.some((d) => d.amountKc >= total!)) {
    total = null;
  }

  // Derive original price. NB: "2 nights × 12,398 Kč" lists the per-night rate,
  // not the subtotal — so `subtotal` captured from that line is usually the per-
  // night rate and is LESS than `total`. Only trust it when it's ≥ total.
  // Otherwise use the largest positive amount that exceeds total.
  let originalPrice: number | null = null;
  if (subtotal !== null && total !== null && subtotal >= total) {
    originalPrice = subtotal;
  } else {
    const positives = items.filter((i) => !i.negative).map((i) => i.amount);
    const maxPos = positives.length ? Math.max(...positives) : null;
    if (maxPos && total !== null && maxPos > total) originalPrice = maxPos;
  }
  if (originalPrice !== null && total !== null && originalPrice <= total) {
    originalPrice = null; // no real discount
  }

  return { originalPrice, total, discounts };
}

async function scrapeAirbnbViaBrowser(
  browser: Browser,
  listingId: string,
  slots: Array<{ checkIn: string; checkOut: string; nights: 2 | 7 }>,
): Promise<Offer[]> {
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  // Force CZK currency regardless of geo
  await page.setCookie({
    name: 'currency',
    value: 'CZK',
    domain: '.airbnb.com',
  });

  const results: Offer[] = [];
  const shortId = listingId.slice(-6);

  for (const slot of slots) {
    const tag = `Airbnb ${shortId} ${slot.checkIn}`;
    // Cache-busting param defeats Airbnb's edge cache so recent host edits
    // (weekly-discount %, nightly rate, etc.) are reflected. Without this,
    // anonymous scraper sessions can receive a stale rate plan that the live
    // authenticated browser sees corrected.
    const cacheBust = Date.now();
    const url =
      `https://www.airbnb.com/rooms/${listingId}` +
      `?check_in=${slot.checkIn}&check_out=${slot.checkOut}&adults=2&_cb=${cacheBust}`;
    try {
      // networkidle2 (instead of domcontentloaded) waits for XHR-driven price
      // recalcs to finish — matters on 7-night slots where the weekly
      // discount is applied in a second pass after initial hydration.
      await withTimeout(
        page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 }),
        35_000,
        `${tag} goto`,
      );
      // Wait for the Reserve button to appear — that anchors the booking panel.
      // If it never shows up, the listing is not bookable for these dates.
      const reserveReady = await page
        .waitForFunction(
          () => {
            const btns = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'));
            return btns.some((b) => /^\s*(reserve|check availability|rezervovat)\s*$/i.test(b.innerText || ''));
          },
          { timeout: 12_000 },
        )
        .then(() => true)
        .catch(() => false);
      await new Promise((r) => setTimeout(r, 1000));

      // Single-source-of-truth extraction: operate ONLY inside the Reserve panel.
      // 1. Find the Reserve button, walk up to the panel container.
      // 2. Hover every small element inside the panel until the Price details
      //    popover opens.
      // 3. Parse that popover with parseTooltipBreakdown — its Total IS the answer.
      const panelResult: {
        reserveFound: boolean;
        panelText: string;
        tooltipText: string;
        strikeTooltipText: string;
        panelKcTotal: number | null;
        panelStrikethrough: number | null;
      } = await page.evaluate(async () => {
        const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

        // Locate the Reserve button and walk up to the booking panel card
        const reserveBtn = Array.from(
          document.querySelectorAll<HTMLElement>('button, [role="button"]'),
        ).find((b) => /^\s*(reserve|check availability|rezervovat)\s*$/i.test(b.innerText || ''));
        if (!reserveBtn) {
          return {
            reserveFound: false,
            panelText: '',
            tooltipText: '',
            strikeTooltipText: '',
            panelKcTotal: null,
            panelStrikethrough: null,
          };
        }
        // Find the TIGHTEST container that is the booking card: smallest
        // ancestor of the Reserve button whose text contains both a per-night
        // price token and a total/Kč indicator, and whose width looks like a
        // sidebar card (< ~520px). This stops us from climbing up into the
        // banner above the card (where phrases like "Special offer" live).
        let panel: HTMLElement | null = reserveBtn.parentElement;
        for (let i = 0; i < 12 && panel; i++) {
          const r = panel.getBoundingClientRect();
          const txt = (panel.textContent || '').slice(0, 3000);
          const hasNight = /\/\s*(night|noc)\b/i.test(txt);
          const hasTotal = /\b(total|celkem)\b/i.test(txt);
          const hasKc = /\d[\d ,.\u00a0]{2,20}\s*Kč/.test(txt);
          const looksLikeCard = r.width > 240 && r.width < 560 && r.height > 280;
          if (looksLikeCard && hasNight && hasTotal && hasKc) break;
          panel = panel.parentElement;
        }
        if (!panel) panel = reserveBtn.parentElement as HTMLElement;

        // DO NOT click arbitrary Kč-containing elements in the panel. On slots
        // where Airbnb renders an "Add a night for X Kč — Extend to <date>"
        // upsell banner, that banner is itself a clickable button whose text
        // contains a Kč amount. An indiscriminate click-bomb ends up accepting
        // the upsell and mutating the booking's dates (the panel then shows
        // "Your dates and price were changed" and the scraper reads the
        // shifted total). The breakdown tooltip is opened via the info-icon
        // hover pass further below — that's sufficient and safe.

        const panelText = (panel.innerText || '').slice(0, 6000);

        // Parse panel text for the total: try both "X Kč total" (single line)
        // and "Total\nX Kč" (two-column flex layout) variants.
        const parsePanelAmount = (raw: string): number => {
          const stripped = raw.replace(/[^\d]/g, '');
          const hasCents = /[.,]\d{2}(?!\d)/.test(raw);
          const n = parseInt(stripped, 10);
          return hasCents ? Math.round(n / 100) : n;
        };
        const totalMatch =
          panelText.match(/(\d[\d ,.\u00a0]{2,20})\s*Kč[ \t]+total\b/i) ??
          panelText.match(/\b(?:total|celkem)\b\s*\n\s*(\d[\d ,.\u00a0]{2,20})\s*Kč/i);
        const panelKcTotal = totalMatch ? parsePanelAmount(totalMatch[1]) : null;

        // Strikethrough detection: ONLY trust prices that are actually rendered
        // with line-through styling in the DOM. Earlier versions picked any
        // Kč amount larger than the total, which incorrectly flagged
        // alternative rate plans (e.g. "Refundable · 5,719 Kč" shown alongside
        // "Non-refundable · 5,147 Kč") as discounts. A different rate plan is
        // NOT a strikethrough.
        let panelStrikethrough: number | null = null;
        const strikeEls = new Set<HTMLElement>();
        panel.querySelectorAll<HTMLElement>('s, del').forEach((el) => strikeEls.add(el));
        panel.querySelectorAll<HTMLElement>('*').forEach((el) => {
          const cs = window.getComputedStyle(el);
          const deco = (cs.textDecorationLine || cs.textDecoration || '');
          if (deco.includes('line-through')) strikeEls.add(el);
        });
        for (const el of strikeEls) {
          const txt = (el.innerText || el.textContent || '').trim();
          const m = txt.match(/(\d[\d ,.\u00a0]{2,20})\s*Kč/);
          if (!m) continue;
          const n = parsePanelAmount(m[1]);
          if (panelKcTotal && n > panelKcTotal && n < panelKcTotal * 3) {
            panelStrikethrough = panelStrikethrough == null ? n : Math.max(panelStrikethrough, n);
          }
        }

        // Hover info icons inside the panel until a Price details popover appears
        const captureDialog = (): string | null => {
          const candidates = [
            ...Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')),
            ...Array.from(document.querySelectorAll<HTMLElement>('[role="tooltip"]')),
            ...Array.from(document.querySelectorAll<HTMLElement>('[data-testid*="price" i][data-testid*="breakdown" i]')),
          ];
          for (const d of candidates) {
            const txt = (d.innerText || '').trim();
            if (txt.length < 20) continue;
            if (!/Kč|CZK/.test(txt)) continue;
            // Must look like the Price details panel: needs "total" and at least 2 prices
            if (!/total|celkem/i.test(txt)) continue;
            return txt.slice(0, 4000);
          }
          return null;
        };
        const fireHover = (el: HTMLElement) => {
          const opts = { bubbles: true, cancelable: true, view: window };
          el.dispatchEvent(new MouseEvent('mouseover', opts));
          el.dispatchEvent(new MouseEvent('mouseenter', opts));
          el.dispatchEvent(new PointerEvent('pointerenter', opts));
        };
        const clearHover = (el: HTMLElement) => {
          const opts = { bubbles: true, cancelable: true, view: window };
          el.dispatchEvent(new MouseEvent('mouseleave', opts));
          el.dispatchEvent(new MouseEvent('mouseout', opts));
        };

        let tooltipText = '';

        // IMPORTANT: on Airbnb the price breakdown is opened by CLICKING (not
        // hovering) a specific control — the "Show price breakdown" link that
        // sits directly below the total. Hover alone doesn't open it. We must
        // also avoid the "Add a night for X Kč" upsell banner, which is a
        // clickable element that accepts the upsell and mutates dates.

        // 1. Identify the "Add a night" upsell banner (if present) so we can
        //    exclude it and its descendants from every candidate list.
        const upsellRoot: HTMLElement | null = (() => {
          const leaves = Array.from(panel.querySelectorAll<HTMLElement>('*'))
            .filter((el) => el.children.length === 0);
          const marker = leaves.find((el) =>
            /add\s*\d*\s*nights?|extend\s*to|special\s*offer/i.test((el.textContent || '').trim()),
          );
          if (!marker) return null;
          // Walk up to find the clickable banner container
          let node: HTMLElement | null = marker.parentElement;
          for (let i = 0; i < 8 && node; i++) {
            const r = node.getBoundingClientRect();
            if (r.height > 50 && r.width > 200) return node;
            node = node.parentElement;
          }
          return marker.parentElement;
        })();
        const isUpsell = (el: HTMLElement): boolean =>
          !!upsellRoot && (el === upsellRoot || upsellRoot.contains(el));

        // 2. Primary trigger: the "Show price breakdown" button/link. This is
        //    Airbnb's stable, purpose-built opener for the breakdown modal.
        const showBreakdownBtn = Array.from(panel.querySelectorAll<HTMLElement>('*'))
          .filter((el) => el.children.length === 0 && !isUpsell(el))
          .find((el) => /^\s*(show\s*price\s*breakdown|zobrazit\s*rozpis)\s*$/i.test((el.textContent || '').trim()));
        const primaryTrigger: HTMLElement | null = (() => {
          if (!showBreakdownBtn) return null;
          // Walk up to the actual clickable ancestor (button/[role="button"]/a)
          let node: HTMLElement | null = showBreakdownBtn;
          for (let i = 0; i < 6 && node; i++) {
            if (/^(BUTTON|A)$/.test(node.tagName) || node.getAttribute('role') === 'button' || node.hasAttribute('tabindex')) {
              return node;
            }
            node = node.parentElement;
          }
          return showBreakdownBtn;
        })();

        if (primaryTrigger) {
          try {
            primaryTrigger.scrollIntoView({ block: 'center' });
            await delay(60);
            primaryTrigger.click();
            for (let attempt = 0; attempt < 10; attempt++) {
              await delay(120);
              const txt = captureDialog();
              if (txt) { tooltipText = txt; break; }
            }
          } catch { /* fall through */ }
        }

        // 3. Fallback: hover + click small info-icon-like triggers inside the
        //    Total row (a narrow scope, NOT the whole panel, to keep us clear
        //    of guest steppers, calendar nav, and — critically — the upsell
        //    banner, which is explicitly filtered out).
        const findTotalRow = (): HTMLElement | null => {
          const leaves = Array.from(panel.querySelectorAll<HTMLElement>('*'))
            .filter((el) => el.children.length === 0 && !isUpsell(el));
          const totalEl = leaves.find((el) => /^\s*(total|celkem)\s*$/i.test(el.textContent || ''));
          if (!totalEl) return null;
          let row: HTMLElement | null = totalEl.parentElement;
          for (let i = 0; i < 6 && row; i++) {
            const r = row.getBoundingClientRect();
            if (r.width > 150 && r.height < 120) break;
            row = row.parentElement;
          }
          return row;
        };
        const totalRow = findTotalRow();

        const gatherTriggers = (scope: HTMLElement): HTMLElement[] => {
          return Array.from(
            scope.querySelectorAll<HTMLElement>(
              'button, [role="button"], [aria-describedby], span[tabindex], svg',
            ),
          ).filter((t) => {
            if (isUpsell(t)) return false;
            const r = t.getBoundingClientRect();
            return r.width > 0 && r.width <= 60 && r.height > 0 && r.height <= 60;
          });
        };

        const rowTriggers = totalRow ? gatherTriggers(totalRow) : [];
        const describedBy = Array.from(
          panel.querySelectorAll<HTMLElement>('button[aria-describedby], [role="button"][aria-describedby]'),
        ).filter((el) => !isUpsell(el));
        const panelCandidates = !tooltipText
          ? [...new Set([...rowTriggers, ...describedBy])]
          : [];

        for (const trg of panelCandidates) {
          try {
            trg.scrollIntoView({ block: 'center' });
            await delay(40);
            fireHover(trg);
            try { trg.click(); } catch { /* ignore */ }
            await delay(350);
            const txt = captureDialog();
            if (txt) {
              tooltipText = txt;
              break;
            }
            clearHover(trg);
          } catch {
            /* skip */
          }
        }

        // Second capture: hover the strikethrough (original) price. On Airbnb,
        // this opens a small tooltip explaining the discount — e.g. "Special
        // offer", "Early booking discount", or "The owner decreased their
        // prices". The main Total tooltip doesn't always include this label,
        // so we grab it separately.
        // Clear any dialog from the first hover so captureAnyDialog below only
        // sees the new one.
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 1 }));
        for (let i = 0; i < 8; i++) {
          if (!document.querySelector('[role="dialog"], [role="tooltip"]')) break;
          await delay(80);
        }

        const captureAnyDialog = (): string | null => {
          const nodes = [
            ...Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')),
            ...Array.from(document.querySelectorAll<HTMLElement>('[role="tooltip"]')),
          ];
          for (const d of nodes) {
            const r = d.getBoundingClientRect();
            if (r.width < 5 || r.height < 5) continue;
            const txt = (d.innerText || '').trim();
            if (txt.length < 4) continue;
            return txt.slice(0, 2000);
          }
          return null;
        };

        let strikeTooltipText = '';
        const strikes = Array.from(
          panel.querySelectorAll<HTMLElement>('s, del, [style*="line-through"]'),
        );
        // Walk ancestors a step or two to the likely hover target if the raw
        // strike tag is too small to catch the pointer.
        const strikeTargets = new Set<HTMLElement>();
        for (const s of strikes) {
          strikeTargets.add(s);
          if (s.parentElement) strikeTargets.add(s.parentElement);
          if (s.parentElement?.parentElement) strikeTargets.add(s.parentElement.parentElement);
        }
        for (const trg of strikeTargets) {
          try {
            trg.scrollIntoView({ block: 'center' });
            await delay(40);
            fireHover(trg);
            try { trg.click(); } catch { /* ignore */ }
            for (let attempt = 0; attempt < 6; attempt++) {
              await delay(120);
              const txt = captureAnyDialog();
              if (txt && !/total|celkem/i.test(txt)) {
                strikeTooltipText = txt;
                break;
              }
            }
            if (strikeTooltipText) break;
            clearHover(trg);
          } catch {
            /* skip */
          }
        }

        return {
          reserveFound: true,
          panelText,
          tooltipText,
          strikeTooltipText,
          panelKcTotal,
          panelStrikethrough,
        };
      });

      console.log(
        `[pricing] ${tag} reserveFound=${panelResult.reserveFound} panelKcTotal=${panelResult.panelKcTotal} strike=${panelResult.panelStrikethrough} tooltipLen=${panelResult.tooltipText.length} strikeTooltipLen=${panelResult.strikeTooltipText.length}`,
      );
      if (panelResult.panelText) {
        console.log(`  panel-text[0:500]: ${JSON.stringify(panelResult.panelText.slice(0, 500))}`);
      }
      if (panelResult.tooltipText) {
        console.log(`  tooltip-text: ${JSON.stringify(panelResult.tooltipText.slice(0, 400))}`);
      }
      if (panelResult.strikeTooltipText) {
        console.log(`  strike-tooltip: ${JSON.stringify(panelResult.strikeTooltipText.slice(0, 300))}`);
      }

      // If Reserve button didn't render, listing is not available for these dates.
      if (!panelResult.reserveFound || (!panelResult.panelKcTotal && !panelResult.tooltipText)) {
        const availability: Offer['availability'] = reserveReady
          ? 'not_available'
          : 'not_available';
        results.push({ ...NULL_OFFER, availability });
        continue;
      }

      let price: number | null = null;
      let originalPrice: number | null = null;
      let breakdown: Array<{ name: string; amountKc: number; pp: number }> = [];
      let selectionPath = 'none';

      if (panelResult.tooltipText) {
        const parsed = parseTooltipBreakdown(panelResult.tooltipText);
        if (parsed.total) {
          price = parsed.total;
          originalPrice = parsed.originalPrice ?? panelResult.panelStrikethrough ?? null;
          if (originalPrice && originalPrice > 0) {
            breakdown = parsed.discounts.map((d) => ({
              name: d.name,
              amountKc: d.amountKc,
              pp: Math.round((d.amountKc / originalPrice!) * 1000) / 10,
            }));
          }
          selectionPath = 'tooltip';
        }
      }

      // Tooltip unavailable — fall back to the panel's own "X Kč total" text
      if (price === null && panelResult.panelKcTotal) {
        price = panelResult.panelKcTotal;
        originalPrice = panelResult.panelStrikethrough;
        selectionPath = 'panel-kc-total';
      }

      // Extract human-readable discount labels from (a) panel innerText and
      // (b) the strike-tooltip. Airbnb surfaces phrases like "Early booking
      // discount", "Special offer", "The owner decreased their prices",
      // "Weekly discount", "Monthly discount". Always check both sources
      // since some listings only show the label on hover.
      const extractLabels = (text: string): string[] => {
        const out: string[] = [];
        const patterns: Array<RegExp> = [
          /Early[\s-]?booking\s*discount/i,
          /Last[- ]?minute\s*(?:discount|deal)/i,
          /Weekly\s*stay\s*discount/i,
          /Weekly\s*(?:discount|rate)/i,
          /Monthly\s*stay\s*discount/i,
          /Monthly\s*(?:discount|rate)/i,
          /New[- ]?listing\s*promotion/i,
          /(?:The\s*)?owner\s*decreased\s*(?:their|the)?\s*price(?:s)?/i,
          /(?:Host|Owner)\s*discount/i,
          // Deliberately NOT matching bare "Special offer" — Airbnb renders
          // that phrase in a banner above the booking card on many listings,
          // which is outside the reservation box and not specific enough to
          // attribute to a real discount on the current dates.
        ];
        for (const p of patterns) {
          const m = text.match(p);
          if (m) {
            const cleaned = m[0].replace(/\s+/g, ' ').trim();
            if (!out.some((l) => l.toLowerCase() === cleaned.toLowerCase())) out.push(cleaned);
          }
        }
        return out;
      };
      const labels = [
        ...extractLabels(panelResult.panelText),
        ...extractLabels(panelResult.strikeTooltipText),
        ...extractLabels(panelResult.tooltipText),
      ].filter((l, i, arr) => arr.findIndex((x) => x.toLowerCase() === l.toLowerCase()) === i);

      // If we have labels but no breakdown-with-amount, still mark the discount
      // as meaningful (so the UI shows the label instead of "unbreakable").
      const hasDiscount = originalPrice !== null && price !== null && originalPrice > price;
      const unparsedDiscount = hasDiscount && breakdown.length === 0;

      const offer: Offer = price !== null
        ? {
            price,
            originalPrice,
            labels,
            discountBreakdown: breakdown.length > 0 ? breakdown : undefined,
            unparsedDiscount: unparsedDiscount || undefined,
            availability: 'available',
          }
        : { ...NULL_OFFER, availability: 'not_available' };

      console.log(
        `[pricing] ${tag} path=${selectionPath} → ${offer.price ?? offer.availability}${offer.originalPrice ? ` (was ${offer.originalPrice})` : ''}${labels.length ? ` labels=[${labels.join(', ')}]` : ''}${breakdown.length ? ` breakdown=${breakdown.map((b) => `${b.name}(-${b.amountKc}Kč, -${b.pp}pp)`).join(', ')}` : ''}`,
      );
      results.push(offer);
    } catch (err) {
      console.log(`[pricing] ${tag} failed: ${err instanceof Error ? err.message : err}`);
      results.push({ ...NULL_OFFER, availability: 'error' });
    }
  }

  await page.close();
  return results;
}

// ─────────────────────────────────────────────
// Puppeteer-based scraping (shared browser across all platforms)
// ─────────────────────────────────────────────

async function launchBrowser(): Promise<Browser> {
  const localChrome = process.env.CHROME_EXECUTABLE_PATH;
  if (localChrome) {
    // Local dev: use system Chrome with minimal args
    return puppeteer.launch({
      executablePath: localChrome,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true,
    });
  }
  // Production (Vercel serverless): use @sparticuz/chromium
  return puppeteer.launch({
    args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
    executablePath: await chromium.executablePath(),
    headless: true,
  });
}

// Wrap a promise with a hard timeout so a single slot cannot hang the whole run
function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${tag} timed out after ${ms}ms`)), ms)),
  ]);
}

// Booking.com: single browser, sequential nav through slots
async function scrapeBookingCom(
  browser: Browser,
  slots: Array<{ checkIn: string; checkOut: string }>,
): Promise<RoomOffers[]> {
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  const results: RoomOffers[] = [];

  for (const slot of slots) {
    const url =
      `${BOOKING_URL}?checkin=${slot.checkIn}&checkout=${slot.checkOut}` +
      `&group_adults=2&no_rooms=1&selected_currency=CZK`;

    console.log(`[pricing] Booking.com ${slot.checkIn}→${slot.checkOut} …`);
    try {
      await withTimeout(
        page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 }),
        25_000,
        `Booking.com goto ${slot.checkIn}`,
      );
      await page
        .evaluate(() => {
          document
            .querySelector<HTMLElement>(
              '#onetrust-accept-btn-handler, [data-testid="accept-cookies-button"]',
            )
            ?.click();
        })
        .catch(() => null);
      // Give JS a moment to render the price table without waiting for full network idle
      await page.waitForSelector('.hprt-table, [data-block="property_main_content"]', { timeout: 10_000 }).catch(() => null);
      await new Promise((r) => setTimeout(r, 1500));

      // Text-based extraction: find room headings, collect price-line pairs
      // (strikethrough + actual) and nearby discount labels, pick cheapest-actual.
      // Also scans hidden HTML (tooltips, aria labels) for deal-name text that
      // isn't rendered in innerText — Booking.com hides "Early Booker Deal" etc.
      // in the price-breakdown tooltip.
      const roomData = await page.evaluate(() => {
        const lines = (document.body?.innerText ?? '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);

        // Deep scan of the full HTML for deal names that live in hidden tooltips
        // (Booking.com's price-breakdown popup, aria-labels, data-* attributes).
        const fullHtml = document.documentElement.outerHTML;
        const dealNamePatterns = [
          /Early\s*Booker?\s*Deal/gi,
          /Early\s*\d{4}\s*Deal/gi,
          /Last[- ]Minute\s*(?:Deal|Discount)?/gi,
          /Weekly\s*(?:Deal|Discount|Stay|Rate)/gi,
          /Monthly\s*(?:Deal|Discount|Stay|Rate)/gi,
          /Getaway\s*Deal/gi,
          /Smart\s*Deal/gi,
          /Mobile[- ]?only\s*(?:Deal|Discount|Rate)?/gi,
          /Bonus\s*Savings/gi,
        ];
        // Find room heading positions in HTML so we can split deals by room
        const roomHeadingHtmlRegex = /(Deluxe|Two[-\s]?Bedroom|One[-\s]?Bedroom|Studio)[^<]{0,80}(?:Apartment|Suite|Room)/gi;
        const headingHtmlMatches = [...fullHtml.matchAll(roomHeadingHtmlRegex)];
        // Known discount line items in the price-breakdown tooltip.
        // Booking.com renders each as: "<Name>  -X,XXX.XX Kč" in the tooltip body.
        const breakdownDiscounts = [
          { name: 'Weekly rate', regex: /Weekly\s*(?:rate|discount)/i },
          { name: 'Monthly rate', regex: /Monthly\s*(?:rate|discount)/i },
          { name: 'Early Booker Deal', regex: /Early\s*Booker?\s*Deal/i },
          { name: 'Last Minute Deal', regex: /Last[- ]?Minute\s*(?:Deal|Discount)?/i },
          { name: 'Mobile-only Deal', regex: /Mobile[- ]?(?:only)?\s*(?:Deal|Price|Rate)/i },
        ];

        const getRoomChunk = (roomName: string): { chunk: string; found: boolean } => {
          const normalized = roomName.toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
          let idx = -1;
          for (let k = 0; k < headingHtmlMatches.length; k++) {
            const h = headingHtmlMatches[k][0].toLowerCase();
            if (normalized.includes(h.slice(0, 20)) || h.includes(normalized.slice(0, 20))) {
              idx = k;
              break;
            }
          }
          if (idx < 0) return { chunk: '', found: false };
          const startIdx = headingHtmlMatches[idx].index ?? 0;
          const endIdx = idx + 1 < headingHtmlMatches.length
            ? (headingHtmlMatches[idx + 1].index ?? fullHtml.length)
            : Math.min(startIdx + 25000, fullHtml.length);
          return { chunk: fullHtml.slice(startIdx, endIdx), found: true };
        };

        const dealsByRoomIdx = (roomName: string): string[] => {
          const { chunk } = getRoomChunk(roomName);
          const dealsFound = new Set<string>();
          const scan = (text: string) => {
            for (const p of dealNamePatterns) {
              const m = text.match(p);
              if (m) for (const s of m) dealsFound.add(s.trim());
            }
          };
          if (chunk) scan(chunk);
          // Fallback to full document if per-room chunk found nothing
          if (dealsFound.size === 0) scan(fullHtml);
          return [...dealsFound];
        };

        // Build thousand-separator-insensitive pattern for a price integer.
        // "31826" → matches "31,826", "31 826", "31826" (all with optional decimals).
        const priceAnchorRegex = (price: number): RegExp => {
          const s = String(price);
          const withSep = s.replace(/\B(?=(\d{3})+(?!\d))/g, '[\\s,]?');
          return new RegExp(`${withSep}(?:[.,]\\d{1,2})?\\s*(?:CZK|Kč)`, 'gi');
        };

        const extractBreakdownFromHtml = (html: string, originalPrice: number): DiscountLineRaw[] => {
          const plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
          // Each tooltip window = 1500 chars before + 2500 chars after the originalPrice mention.
          // The breakdown rows (name + amount pairs) always follow the "X Kč × N nights = originalPrice" header.
          const anchorRegex = priceAnchorRegex(originalPrice);
          const windows: string[] = [];
          for (const m of plain.matchAll(anchorRegex)) {
            const start = Math.max(0, (m.index ?? 0) - 1500);
            const end = Math.min(plain.length, (m.index ?? 0) + 2500);
            windows.push(plain.slice(start, end));
          }
          // If no anchor hit in stripped text, fall back to raw HTML anchors
          if (windows.length === 0) {
            for (const m of html.matchAll(anchorRegex)) {
              const start = Math.max(0, (m.index ?? 0) - 1500);
              const end = Math.min(html.length, (m.index ?? 0) + 2500);
              windows.push(html.slice(start, end));
            }
          }
          // Last resort — scan the whole document
          if (windows.length === 0) windows.push(plain);

          const lines: DiscountLineRaw[] = [];
          const seen = new Set<string>();
          for (const win of windows) {
            for (const d of breakdownDiscounts) {
              if (seen.has(d.name)) continue;
              // Iterate all matches; accept the first one that has a valid amount within 800 chars
              for (const m of win.matchAll(new RegExp(d.regex.source, 'gi'))) {
                const ahead = win.slice(m.index ?? 0, (m.index ?? 0) + 800);
                const amt = ahead.match(/[−\-–]\s*(\d[\d ,.\u00a0]{2,20})\s*(?:CZK|Kč)/);
                if (!amt) continue;
                const raw = parseInt(amt[1].replace(/[^\d]/g, ''), 10);
                const hasCents = /[.,]\d{2}\s*(?:CZK|Kč)/.test(ahead);
                const amount = hasCents ? Math.round(raw / 100) : raw;
                if (amount <= 0) continue;
                if (amount >= originalPrice) continue;
                const pp = Math.round((amount / originalPrice) * 1000) / 10;
                lines.push({ name: d.name, amountKc: amount, pp });
                seen.add(d.name);
                break;
              }
            }
            if (lines.length > 0) break;
          }
          return lines;
        };

        const breakdownByRoom = (roomName: string, originalPrice: number | null): DiscountLineRaw[] => {
          if (!originalPrice) return [];
          // Anchor-based extraction works equally well on per-room chunk or full document,
          // so just use full document — avoids chunking miss when tooltip is React-portalled.
          return extractBreakdownFromHtml(fullHtml, originalPrice);
        };

        const majorHeading = /^(deluxe|two[\s-]?bedroom|one[\s-]?bedroom|studio|suite|standard|superior|\b[12]kk\b)/i;
        const priceRegex = /(\d[\d ,.\u00a0]{2,20})\s*(?:CZK|Kč)/i;
        // NOTE: We deliberately do NOT regex-scan for "label" text on Booking.com anymore.
        // The property page mentions every discount name across all rate plans — any loose
        // text match produces false positives (e.g. "Last Minute Deal" showing on a Jun 20
        // booking because the phrase appears in help copy elsewhere on the page).
        //
        // The ONLY trustworthy signal is a discount NAME appearing close to a NEGATIVE CZK
        // amount inside the price-breakdown tooltip. That's what `extractBreakdownFromHtml`
        // captures, anchored on originalPrice. Everything else is noise.

        type DiscountLineRaw = { name: string; amountKc: number; pp: number };
        type Block = {
          name: string;
          price: number;
          originalPrice: number | null;
          labels: string[];
          allPairs: Array<{ price: number; original: number | null }>;
          rawContext: string[];
          hiddenDeals: string[];
          breakdown: DiscountLineRaw[];
        };
        const results: Block[] = [];

        // For each room heading, take ONLY the first rate row (the cheapest —
        // Booking.com orders rate plans by price ascending). That's a pair of
        // prices within the first few lines after the heading: first price is
        // the strikethrough (original), second is the actual. If there's only
        // one price, no discount.
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.length < 10 || line.length > 100) continue;
          if (!majorHeading.test(line)) continue;

          const blockEnd = Math.min(i + 60, lines.length);
          const firstTwo: Array<{ idx: number; price: number }> = [];
          for (let j = i + 1; j < blockEnd && firstTwo.length < 2; j++) {
            if (majorHeading.test(lines[j]) && j > i + 3) break;
            const m = lines[j].match(priceRegex);
            if (!m) continue;
            const price = parseInt(m[1].replace(/[^\d]/g, ''), 10);
            if (Number.isNaN(price)) continue;
            firstTwo.push({ idx: j, price });
          }
          if (firstTwo.length === 0) continue;

          const [a, b] = firstTwo;
          const hasStrikethrough = b && b.idx - a.idx <= 3 && a.price > b.price;
          const price = hasStrikethrough ? b.price : a.price;
          const originalPrice = hasStrikethrough ? a.price : null;

          const breakdown = breakdownByRoom(line, originalPrice);
          const hiddenDeals = dealsByRoomIdx(line);

          results.push({
            name: line,
            price,
            originalPrice,
            labels: [],
            allPairs: [{ price, original: originalPrice }],
            rawContext: [],
            hiddenDeals,
            breakdown,
          });
        }
        return results;
      });
      console.log(`[pricing] Booking.com ${slot.checkIn} → ${roomData.length} rooms (text pass)`);

      // Click-to-reveal pass: for each room heading, find the first rate row
      // (cheapest — Booking.com orders rate plans ascending) and open the
      // price-breakdown tooltip. Captures are associated with their heading
      // text so we can match directly back to the room (no price-collision
      // risk when two rooms share similar totals).
      const clickPassResult: {
        collected: Array<{ heading: string; text: string }>;
        misses: Array<{ heading: string; triggers: number; cellFound: boolean }>;
      } = await page.evaluate(async () => {
        const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const collected: Array<{ heading: string; text: string }> = [];
        const misses: Array<{ heading: string; triggers: number; cellFound: boolean }> = [];

        // Booking.com renders the price-breakdown popup as a portal under
        // document.body — not always tagged with role="dialog"/tooltip. Cast
        // a wider net: explicit roles, breakdown test-ids, BUI component
        // tooltips, aria-live polite regions, and anything with an inline
        // z-index that's likely a floating overlay.
        const listDialogs = (): HTMLElement[] => {
          const out = new Set<HTMLElement>();
          const selectors = [
            '[role="dialog"]',
            '[role="tooltip"]',
            '[data-testid*="breakdown" i]',
            '[data-testid*="price" i]',
            '[class*="tooltip" i]',
            '[class*="popover" i]',
            '[data-component*="tooltip" i]',
            '.bui-tooltip',
            '[aria-live="polite"]',
          ];
          for (const s of selectors) {
            for (const el of Array.from(document.querySelectorAll<HTMLElement>(s))) out.add(el);
          }
          return [...out];
        };

        const looksLikeBreakdown = (txt: string): boolean => {
          if (!txt || txt.length < 20) return false;
          if (!/Kč|CZK/.test(txt)) return false;
          // At least one price-like token plus either a nights/discount marker
          const hasPrice = /\d[\d ,.\u00a0]{2,20}\s*Kč/.test(txt);
          const hasBreakdownKeyword =
            /nights?|noc[ií]|total|celkem|deal|discount|rate|%\s*off|early|weekly|monthly|last[- ]?minute/i.test(txt);
          return hasPrice && hasBreakdownKeyword;
        };

        const visibleDialog = (excludeIds?: Set<HTMLElement>): HTMLElement | null => {
          for (const d of listDialogs()) {
            if (excludeIds && excludeIds.has(d)) continue;
            const r = d.getBoundingClientRect();
            if (r.width < 5 || r.height < 5) continue;
            const txt = (d.innerText || '').trim();
            if (!looksLikeBreakdown(txt)) continue;
            return d;
          }
          return null;
        };

        // Last-resort scan: any element that (a) wasn't in preExisting
        // dialogs, (b) is visible, (c) has breakdown-shaped text. Catches
        // Booking popovers that don't match any of our selectors.
        const scanForNewBreakdown = (preExisting: Set<HTMLElement>): HTMLElement | null => {
          const candidates = Array.from(document.querySelectorAll<HTMLElement>('div, section, aside'));
          for (const el of candidates) {
            if (preExisting.has(el)) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 120 || r.width > 600) continue;
            if (r.height < 60 || r.height > 500) continue;
            const txt = (el.innerText || '').trim();
            if (!looksLikeBreakdown(txt)) continue;
            // Must include a negative amount or rate-plan keyword to avoid matching the whole page body
            if (!/[−\-–]\s*\d|deal|discount|weekly|monthly|early|last[- ]?minute/i.test(txt)) continue;
            if (txt.length > 2000) continue;
            return el;
          }
          return null;
        };

        const fireHoverAndClick = (el: HTMLElement) => {
          const opts = { bubbles: true, cancelable: true, view: window };
          el.dispatchEvent(new MouseEvent('mouseover', opts));
          el.dispatchEvent(new MouseEvent('mouseenter', opts));
          el.dispatchEvent(new PointerEvent('pointerenter', opts));
          try { el.click(); } catch { /* skip */ }
        };

        const dismissAll = async () => {
          // Press Escape, then click a neutral spot (top-left of body) to close
          // any tooltip that doesn't respond to Escape. Poll until gone.
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 1 }));
          for (let i = 0; i < 10; i++) {
            if (!visibleDialog()) return;
            await delay(80);
          }
        };

        const headingRegex = /(Deluxe|Two[-\s]?Bedroom|One[-\s]?Bedroom|Studio|Suite|[12]KK)/i;
        const headings = Array.from(document.querySelectorAll<HTMLElement>('h2, h3, h4, a'))
          .filter((h) => headingRegex.test(h.innerText || ''));

        // De-dupe headings by visible text (Booking sometimes renders the same
        // heading twice — one for desktop, one for mobile variant).
        const seenHeadings = new Set<string>();
        const uniqueHeadings: HTMLElement[] = [];
        for (const h of headings) {
          const key = (h.innerText || '').trim().toLowerCase();
          if (!key || seenHeadings.has(key)) continue;
          seenHeadings.add(key);
          uniqueHeadings.push(h);
        }

        const all = Array.from(document.querySelectorAll<HTMLElement>('*'));
        const usedCells = new Set<HTMLElement>();

        for (const h of uniqueHeadings) {
          const headingText = (h.innerText || '').trim();
          const startIdx = all.indexOf(h);
          if (startIdx < 0) continue;

          // Walk forward to find this heading's first price cell
          let cell: HTMLElement | null = null;
          for (let i = startIdx + 1; i < Math.min(startIdx + 400, all.length); i++) {
            const el = all[i];
            if (headingRegex.test(el.innerText || '') && el !== h && /^(H2|H3|H4|A)$/i.test(el.tagName)) break;
            if (usedCells.has(el)) continue;
            const txt = el.textContent ?? '';
            const r = el.getBoundingClientRect();
            if (/\d[\d ,.\u00a0]{2,20}\s*Kč/.test(txt) && r.width > 60 && r.width < 400 && r.height > 0) {
              cell = el;
              break;
            }
          }
          if (!cell) {
            misses.push({ heading: headingText, triggers: 0, cellFound: false });
            continue;
          }
          usedCells.add(cell);

          // Snapshot dialogs AND all existing DOM elements BEFORE we touch
          // the cell. The scanForNewBreakdown fallback uses pre-existing DOM
          // to distinguish newly-portalled Booking tooltip containers.
          const preExisting = new Set(listDialogs());
          const preExistingAll = new Set(Array.from(document.querySelectorAll<HTMLElement>('div, section, aside')));

          // Gather info-icon-like triggers. Search the CELL first, then walk
          // up one level to catch icons rendered as the cell's sibling
          // (Booking.com frequently places the ⓘ trigger outside the strict
          // price wrapper). Also look for explicit breakdown-icon selectors.
          const gatherTriggersFrom = (scope: HTMLElement): HTMLElement[] => {
            return Array.from(
              scope.querySelectorAll<HTMLElement>(
                'button, [role="button"], svg, [aria-describedby], span[tabindex], '
                + '[data-testid*="breakdown" i], [data-testid*="tooltip" i], '
                + '[data-testid*="info" i], [aria-label*="price" i], '
                + '[aria-label*="breakdown" i], [aria-label*="what" i]',
              ),
            ).filter((t) => {
              const r = t.getBoundingClientRect();
              return r.width > 0 && r.width <= 80 && r.height > 0 && r.height <= 80;
            });
          };
          const inCellTriggers = gatherTriggersFrom(cell);
          const parentTriggers = cell.parentElement ? gatherTriggersFrom(cell.parentElement) : [];
          const triggers = [...new Set([...inCellTriggers, ...parentTriggers])];

          let capturedText: string | null = null;
          for (const trg of triggers) {
            try {
              trg.scrollIntoView({ block: 'center' });
              await delay(60);
              fireHoverAndClick(trg);
              // Wait for a NEW dialog (not one that was already there) to render
              for (let attempt = 0; attempt < 8; attempt++) {
                await delay(90);
                const d = visibleDialog(preExisting);
                if (d) {
                  capturedText = (d.innerText || '').trim().slice(0, 4000);
                  break;
                }
              }
              if (capturedText) break;
            } catch { /* skip */ }
          }

          // Fallback: no recognised dialog opened — scan DOM for ANY newly
          // portalled element whose text looks like a breakdown. Booking's
          // tooltip container sometimes matches none of our selectors.
          if (!capturedText) {
            const novel = scanForNewBreakdown(preExistingAll);
            if (novel) {
              capturedText = (novel.innerText || '').trim().slice(0, 4000);
            }
          }

          if (capturedText) {
            collected.push({ heading: headingText, text: capturedText });
          } else {
            misses.push({ heading: headingText, triggers: triggers.length, cellFound: true });
          }

          // Fully dismiss before next heading so the next iteration's
          // "new dialog" detection is reliable
          await dismissAll();
        }

        return { collected, misses };
      });
      const tooltipCaptures = clickPassResult.collected;
      console.log(`[pricing] Booking.com ${slot.checkIn} tooltips captured: ${tooltipCaptures.length}`);
      tooltipCaptures.forEach((t, i) => {
        console.log(`  tooltip[${i}] heading="${t.heading.slice(0, 40)}" (${t.text.length} chars): ${JSON.stringify(t.text.slice(0, 260))}`);
      });
      clickPassResult.misses.forEach((m) => {
        console.log(`  tooltip MISS heading="${m.heading.slice(0, 40)}" cellFound=${m.cellFound} triggers=${m.triggers}`);
      });

      // Parse each tooltip and keep the heading association for direct matching
      const tooltipBreakdowns = tooltipCaptures.map((c) => {
        const parsed = parseTooltipBreakdown(c.text);
        return { ...parsed, heading: c.heading };
      });

      // Match each room to its tooltip by heading text (exact or substring) and
      // fall back to price match only if the heading link isn't available.
      for (const r of roomData) {
        const roomHeadingLc = r.name.toLowerCase();
        let tt = tooltipBreakdowns.find((b) => {
          const bh = b.heading.toLowerCase();
          return bh.includes(roomHeadingLc.slice(0, 20)) || roomHeadingLc.includes(bh.slice(0, 20));
        });
        if (!tt) {
          const matchesPrice = (n: number) => Math.abs(n - r.price) <= 20;
          const matchesOriginal = (n: number) =>
            r.originalPrice !== null && Math.abs(n - r.originalPrice) <= 20;
          tt = tooltipBreakdowns.find((b) => {
            if (b.total !== null && matchesPrice(b.total)) return true;
            if (b.originalPrice !== null && matchesOriginal(b.originalPrice)) return true;
            return false;
          });
        }
        if (!tt || !r.originalPrice) continue;

        const originalForPp = tt.originalPrice ?? r.originalPrice;
        r.breakdown = tt.discounts.map((d) => ({
          name: d.name,
          amountKc: d.amountKc,
          pp: Math.round((d.amountKc / originalForPp) * 1000) / 10,
        }));
      }

      for (const r of roomData) {
        console.log(`  ${r.name.slice(0, 45)}: ${r.price}${r.originalPrice ? ` (was ${r.originalPrice})` : ''}`);
        console.log(`    breakdown: ${r.breakdown.map((b) => `${b.name}(-${b.amountKc}Kč, -${b.pp}pp)`).join(', ') || 'none'}`);
      }

      // Pick cheapest offer per room type
      const toOffer = (r: typeof roomData[0]): Offer => {
        let unparsedDiscount = false;
        let verifiedBreakdown: typeof r.breakdown | undefined = undefined;

        if (r.originalPrice && r.originalPrice > r.price) {
          const totalPct = ((r.originalPrice - r.price) / r.originalPrice) * 100;
          const breakdownSum = r.breakdown.reduce((s, b) => s + b.pp, 0);
          // Trust breakdown if PPs sum within 3pp of observed total %. Widened from 2
          // to allow for rounding / decimal-cent edge cases while still catching
          // wildly wrong extractions (e.g. scraper picked up 30pp of discounts when
          // reality is only 10%).
          const breakdownMatches =
            r.breakdown.length > 0 && Math.abs(totalPct - breakdownSum) <= 3;
          if (breakdownMatches) {
            verifiedBreakdown = r.breakdown;
          } else if (totalPct > 3) {
            unparsedDiscount = true;
            if (r.breakdown.length > 0) {
              console.log(`[pricing] Booking.com breakdown rejected: total=${totalPct.toFixed(1)}% sum=${breakdownSum.toFixed(1)}pp lines=${JSON.stringify(r.breakdown)}`);
            }
          }
        }

        return {
          price: r.price,
          originalPrice: r.originalPrice,
          labels: r.labels,
          discountBreakdown: verifiedBreakdown,
          unparsedDiscount: unparsedDiscount || undefined,
        };
      };

      let k201Offer: Offer = NULL_OFFER;
      let oneKKOffer: Offer = NULL_OFFER;
      for (const r of roomData) {
        const n = r.name.toLowerCase();
        const is2KK = /2kk|2-bed|two-bed|2 bed/i.test(n);
        const is1KK = /1kk|1-bed|one-bed|1 bed|studio/i.test(n);
        if (is2KK && (k201Offer.price === null || r.price < (k201Offer.price ?? Infinity))) k201Offer = toOffer(r);
        else if (is1KK && !is2KK && (oneKKOffer.price === null || r.price < (oneKKOffer.price ?? Infinity))) oneKKOffer = toOffer(r);
      }

      results.push({ k201: k201Offer, oneKK: oneKKOffer });
    } catch (err) {
      console.error(`[pricing] Booking.com ${slot.checkIn} failed:`, err instanceof Error ? err.message : err);
      results.push({ k201: NULL_OFFER, oneKK: NULL_OFFER });
    }
  }

  await page.close();
  return results;
}

// TODO(vercel): For the Web column, call the Beds24 API (same pattern as
// app/api/price-check/route.ts). The API returns the same prices the widget
// displays, without the scraping fragility. Implement once deployed where
// BEDS24_REFRESH_TOKEN is configured.

// ─────────────────────────────────────────────
// Spread + orchestrator
// ─────────────────────────────────────────────

function calcSpread(prices: (number | null)[]): number | null {
  const valid = prices.filter((p): p is number => p !== null && p > 0);
  if (valid.length < 2) return null;
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  return Math.round(((max - min) / min) * 100);
}

export async function runFullPricingCheck(
  customSlots?: Array<{ checkIn: string; checkOut: string; nights: 2 | 7 }>,
): Promise<PricingResult> {
  const slots = customSlots ?? generateDateSlots();
  console.log(`[pricing] Starting run — ${slots.length} slot(s)`);

  const browser = await launchBrowser();
  console.log(`[pricing] Browser launched`);

  let bookingResults: RoomOffers[] = [];
  // Web prices are populated via Beds24 API on Vercel (see TODO above).
  const webResults: RoomOffers[] = slots.map(() => ({ k201: NULL_OFFER, oneKK: NULL_OFFER }));
  let airbnbK201: Offer[] = [];
  let airbnb1kk: Offer[] = [];

  try {
    bookingResults = await scrapeBookingCom(browser, slots);
    airbnbK201 = await scrapeAirbnbViaBrowser(browser, AIRBNB_K201_ID, slots);
    // 1KK: both K.202 and K.203 are priced identically, so checking one is enough.
    // Try K.202 first; only scrape K.203 for slots where K.202 returned no price.
    const airbnbK202 = await scrapeAirbnbViaBrowser(browser, AIRBNB_K202_ID, slots);
    const fallbackSlots: Array<{ idx: number; slot: typeof slots[0] }> = [];
    airbnbK202.forEach((o, i) => {
      if (o.price === null) fallbackSlots.push({ idx: i, slot: slots[i] });
    });
    airbnb1kk = [...airbnbK202];
    if (fallbackSlots.length > 0) {
      const fallbackResults = await scrapeAirbnbViaBrowser(
        browser,
        AIRBNB_K203_ID,
        fallbackSlots.map((f) => f.slot),
      );
      fallbackSlots.forEach((f, i) => {
        if (fallbackResults[i].price !== null) airbnb1kk[f.idx] = fallbackResults[i];
      });
    }
  } finally {
    await browser.close().catch(() => null);
    console.log(`[pricing] Browser closed`);
  }
  console.log(`[pricing] All scrapers done`);

  const runs: PricingRun[] = slots.map((slot, i) => ({
    checkIn: slot.checkIn,
    checkOut: slot.checkOut,
    nights: slot.nights,
    rooms: [
      {
        roomLabel: '1KK Deluxe',
        web: webResults[i].oneKK,
        airbnb: airbnb1kk[i],
        bookingCom: bookingResults[i].oneKK,
        spread: calcSpread([webResults[i].oneKK.price, airbnb1kk[i].price, bookingResults[i].oneKK.price]),
      },
      {
        roomLabel: '2KK Deluxe',
        web: webResults[i].k201,
        airbnb: airbnbK201[i],
        bookingCom: bookingResults[i].k201,
        spread: calcSpread([webResults[i].k201.price, airbnbK201[i].price, bookingResults[i].k201.price]),
      },
    ],
  }));

  return { timestamp: new Date().toISOString(), runs };
}

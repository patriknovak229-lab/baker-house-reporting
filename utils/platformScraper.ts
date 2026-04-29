import chromium from '@sparticuz/chromium';
import puppeteer, { type Browser } from 'puppeteer-core';

// ─────────────────────────────────────────────
// Listing identifiers
// ─────────────────────────────────────────────

export const AIRBNB_K201_ID = '1635011413648373253'; // K.201 — 2KK Deluxe (single listing)
// 1KK has been consolidated to a single Airbnb listing fed by the Beds24
// virtual room (qty=2). The previous K.203 standalone listing
// (1557243344995462947) is no longer used. Same VR also drives Booking.com.
export const AIRBNB_1KK_ID = '1560149310755564258'; // 1KK Deluxe (Beds24 VR, qty=2)

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

/**
 * Computes the look-ahead window: defaults to "next reasonable Friday or
 * 3 days from now" → 65 days out. Override via env vars for testing.
 */
function computeWindow(): { start: Date; end: Date } {
  const envStart = process.env.PRICING_DATE_START;
  const envEnd = process.env.PRICING_DATE_END;
  if (envStart && envEnd) {
    return {
      start: new Date(envStart + 'T00:00:00Z'),
      end: new Date(envEnd + 'T00:00:00Z'),
    };
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay();
  const daysUntilFriday = ((5 - dow + 7) % 7) || 7;
  return {
    start: new Date(today.getTime() + Math.max(daysUntilFriday, 3) * 86400_000),
    end: new Date(today.getTime() + 65 * 86400_000),
  };
}

/**
 * Fallback when Beds24 is unavailable — picks the first 2-night and
 * 7-night windows from the start date without availability validation.
 * Equivalent to the old behavior. Production should use the
 * Beds24-driven `discoverAvailableSlots` instead.
 */
export function generateDateSlots(): Array<{ checkIn: string; checkOut: string; nights: 2 | 7 }> {
  const { start, end } = computeWindow();
  const ci = start;
  const slots: Array<{ checkIn: string; checkOut: string; nights: 2 | 7 }> = [];
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
  // cs-CZ first nudges Airbnb's locale routing toward Czech rates / language
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'cs-CZ,cs;q=0.9,en;q=0.8' });
  // Force CZK currency. Set on every plausible domain — Airbnb is fussy
  // about which exact host the cookie is bound to. Safe to set on any
  // page (cookies persist across goto navigations).
  for (const domain of ['.airbnb.com', '.airbnb.cz', 'www.airbnb.com']) {
    await page.setCookie({ name: 'currency', value: 'CZK', domain }).catch(() => null);
  }

  const results: Offer[] = [];
  const shortId = listingId.slice(-6);

  for (const slot of slots) {
    const tag = `Airbnb ${shortId} ${slot.checkIn}`;
    // Cache-busting param defeats Airbnb's edge cache so recent host edits
    // (weekly-discount %, nightly rate, etc.) are reflected. Without this,
    // anonymous scraper sessions can receive a stale rate plan that the live
    // authenticated browser sees corrected.
    const cacheBust = Date.now();
    // currency=CZK URL param + display_currency=CZK belt-and-suspenders.
    // Some Airbnb edge variants honor the URL param even when the cookie
    // isn't sticking (Vercel datacenter IPs frequently get USD via cookie).
    const url =
      `https://www.airbnb.com/rooms/${listingId}` +
      `?check_in=${slot.checkIn}&check_out=${slot.checkOut}&adults=2&_cb=${cacheBust}` +
      `&currency=CZK&display_currency=CZK&locale=cs`;
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
        currencyDetected: 'CZK' | 'USD' | null;
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
            currencyDetected: null,
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
          const hasNight = /\b(?:nights?|noc[ií]?|\/\s*night)\b/i.test(txt);
          const hasTotal = /\b(total|celkem)\b/i.test(txt);
          // Accept either Kč (preferred) OR $ as the price indicator —
          // Vercel datacenter IPs sometimes get USD pricing despite the
          // currency cookie/URL param.
          const hasPrice = /\d[\d ,.\u00a0]{2,20}\s*Kč/.test(txt) || /\$\s*\d[\d ,.\u00a0]{1,15}/.test(txt);
          const looksLikeCard = r.width > 240 && r.width < 560 && r.height > 280;
          if (looksLikeCard && hasNight && hasTotal && hasPrice) break;
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
        // and "Total\nX Kč" (two-column flex layout) variants. If neither
        // hits, fall back to USD parsing — Airbnb sometimes serves USD
        // from Vercel datacenter IPs even with currency=CZK cookie set.
        const FX_USD_TO_CZK = 24.0; // approximate; updated as needed
        const parsePanelAmount = (raw: string): number => {
          const stripped = raw.replace(/[^\d]/g, '');
          const hasCents = /[.,]\d{2}(?!\d)/.test(raw);
          const n = parseInt(stripped, 10);
          return hasCents ? Math.round(n / 100) : n;
        };
        const parseUsdAmount = (raw: string): number => {
          // "$1,541.97" → 1541.97 (in dollars)
          const stripped = raw.replace(/[^\d.]/g, '');
          const n = parseFloat(stripped);
          return Number.isFinite(n) ? n : 0;
        };

        let panelKcTotal: number | null = null;
        let currencyDetected: 'CZK' | 'USD' | null = null;
        const kcTotalMatch =
          // EN: "X Kč total" inline
          panelText.match(/(\d[\d ,.\u00a0]{2,20})\s*Kč[ \t]+(?:total|celkem)\b/i) ??
          // EN/CZ: "Total/Celkem X Kč" — allow space, tab OR newline between
          // (Czech rate plan rows are "...· Celkem 4 290,30 Kč" on one line;
          // the previous newline-only pattern missed them)
          panelText.match(/\b(?:total|celkem)\b[ \t\n]+(\d[\d ,.\u00a0]{2,20})\s*Kč/i) ??
          // CZ: "X Kč za N nocí" (headline price → "for N nights")
          panelText.match(/(\d[\d ,.\u00a0]{2,20})\s*Kč\s+za\s+\d+\s+noc[ií]?/i);
        if (kcTotalMatch) {
          panelKcTotal = parsePanelAmount(kcTotalMatch[1]);
          currencyDetected = 'CZK';
        } else {
          // USD fallback. Patterns we've seen on Vercel:
          //   "$1,541.97 total"
          //   "$1,541 for 7 nights"
          //   "Non-refundable · $1,541.97 total"
          const usdMatch =
            panelText.match(/\$\s*([\d,.]+)\s+total\b/i) ??
            panelText.match(/\$\s*([\d,.]+)\s+for\s+\d+\s+nights?\b/i) ??
            panelText.match(/non-refundable[^$]{0,30}\$\s*([\d,.]+)/i);
          if (usdMatch) {
            const usd = parseUsdAmount(usdMatch[1]);
            if (usd > 0) {
              panelKcTotal = Math.round(usd * FX_USD_TO_CZK);
              currencyDetected = 'USD';
            }
          }
        }

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
          const kcM = txt.match(/(\d[\d ,.\u00a0]{2,20})\s*Kč/);
          const usdM = !kcM ? txt.match(/\$\s*([\d,.]+)/) : null;
          let n: number | null = null;
          if (kcM) n = parsePanelAmount(kcM[1]);
          else if (usdM && currencyDetected === 'USD') n = Math.round(parseUsdAmount(usdM[1]) * FX_USD_TO_CZK);
          if (n !== null && panelKcTotal && n > panelKcTotal && n < panelKcTotal * 3) {
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
          currencyDetected,
        };
      });

      console.log(
        `[pricing] ${tag} reserveFound=${panelResult.reserveFound} panelKcTotal=${panelResult.panelKcTotal} strike=${panelResult.panelStrikethrough} currency=${panelResult.currencyDetected ?? 'null'} tooltipLen=${panelResult.tooltipText.length} strikeTooltipLen=${panelResult.strikeTooltipText.length}`,
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

      // If Reserve button didn't render, dump page state so we can see WHY
      // (CAPTCHA / "Hold on while we verify your browser" / blank shell /
      // geo-block) — distinguishes anti-bot blocks from genuine unavailability.
      if (!panelResult.reserveFound || (!panelResult.panelKcTotal && !panelResult.tooltipText)) {
        const availability: Offer['availability'] = reserveReady
          ? 'not_available'
          : 'not_available';
        try {
          const diag = await page.evaluate(() => ({
            title: document.title,
            url: location.href,
            bodyLen: (document.body?.innerText ?? '').length,
            bodyHead: (document.body?.innerText ?? '').slice(0, 600),
            hasCaptcha: /captcha|robot|hold\s*on\s*while|verify\s*your\s*browser|are\s*you\s*human|access\s*denied|blocked/i.test(
              document.body?.innerText ?? '',
            ),
          }));
          console.log(
            `[pricing] ${tag} EMPTY: title=${JSON.stringify(diag.title)} url=${diag.url} bodyLen=${diag.bodyLen} captchaHint=${diag.hasCaptcha}`,
          );
          console.log(`  body[0:600]: ${JSON.stringify(diag.bodyHead)}`);
        } catch {
          /* page may already be closed — best effort */
        }
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
        // Match a CZK amount NOT followed by per-night markers (slash-night,
        // "/noc", "per night", "average price per night"). Booking renders
        // the per-night rate right under the stay total — without this guard
        // the text scanner picks up the smaller per-night number.
        const priceRegex = /(\d[\d ,.\u00a0]{2,20})\s*(?:CZK|Kč)(?!\s*(?:\/|per\s|average\s|.\s*(?:is\s*the\s*average\s*)?price\s*per)?\s*(?:night|noc))/i;
        // A line is per-night if either the line itself OR the next 1-2 lines
        // contain night-rate markers ("X Kč/night" sometimes spans wrappers
        // and renders to innerText as "X Kč" then "/night" on the next line).
        const isPerNightLine = (idx: number): boolean => {
          for (let k = 0; k < 3 && idx + k < lines.length; k++) {
            const l = lines[idx + k];
            if (/\b(?:per\s*night|\/\s*night|\/\s*noc|noc[ií]|average\s*price\s*per)/i.test(l)) {
              return true;
            }
          }
          return false;
        };
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
            // Skip lines that are per-night rates — the scanner's looking
            // for stay totals only.
            if (isPerNightLine(j)) continue;
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

      // When text pass returns nothing, dump page state once so we can see
      // why on Vercel (likely CAPTCHA/anti-bot/cookie wall vs locally).
      // Skip the click pass and the rest of the slot — there's nothing to
      // hover anyway, and that path costs ~10s per empty slot which is what
      // pushed us over the 120s function timeout in the first run.
      if (roomData.length === 0) {
        const diag = await page.evaluate(() => ({
          title: document.title,
          url: location.href,
          bodyLen: (document.body?.innerText ?? '').length,
          bodyHead: (document.body?.innerText ?? '').slice(0, 600),
          hasCaptcha: /captcha|robot|are\s*you\s*human|access\s*denied|blocked/i.test(
            document.body?.innerText ?? '',
          ),
        }));
        console.log(
          `[pricing] Booking.com EMPTY for ${slot.checkIn}: title=${JSON.stringify(diag.title)} url=${diag.url} bodyLen=${diag.bodyLen} captchaHint=${diag.hasCaptcha}`,
        );
        console.log(`  body[0:600]: ${JSON.stringify(diag.bodyHead)}`);
        results.push({ k201: NULL_OFFER, oneKK: NULL_OFFER });
        continue;
      }

      // Diagnostic: log every parsed room row so we can spot when text-pass
      // returned data but the values look off (cell-walker matched wrong
      // element on Vercel's Booking variant, locale-specific markup, etc.)
      roomData.forEach((r, idx) => {
        console.log(
          `[pricing] Booking.com ${slot.checkIn} parsed[${idx}]: name=${JSON.stringify(r.name.slice(0, 50))} price=${r.price} original=${r.originalPrice ?? 'null'}`,
        );
      });

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

      // Match each room to its tooltip by heading text. The tooltip's
      // Total/Original/discount values are the AUTHORITATIVE numbers — the
      // text-pass picks them up from card-level rendering which is fragile
      // (per-night rates, locale-specific markup, etc.). When we have a
      // tooltip match, override r.price / r.originalPrice from the tooltip.
      for (const r of roomData) {
        const roomHeadingLc = r.name.toLowerCase();
        let tt = tooltipBreakdowns.find((b) => {
          const bh = b.heading.toLowerCase();
          return bh.includes(roomHeadingLc.slice(0, 20)) || roomHeadingLc.includes(bh.slice(0, 20));
        });
        if (!tt) {
          // No heading match — try matching by either of the prices the
          // text-pass found (defensive: handles tooltip showing rounded
          // values that don't exactly match the card).
          const matchesPrice = (n: number) => Math.abs(n - r.price) <= 200;
          const matchesOriginal = (n: number) =>
            r.originalPrice !== null && Math.abs(n - r.originalPrice) <= 200;
          tt = tooltipBreakdowns.find((b) => {
            if (b.total !== null && matchesPrice(b.total)) return true;
            if (b.originalPrice !== null && matchesOriginal(b.originalPrice)) return true;
            return false;
          });
        }
        if (!tt) continue;

        // Tooltip wins when present
        if (tt.total !== null && tt.total > 0) r.price = tt.total;
        if (tt.originalPrice !== null && tt.originalPrice > r.price) {
          r.originalPrice = tt.originalPrice;
        }

        const originalForPp = r.originalPrice ?? tt.total ?? r.price;
        r.breakdown = tt.discounts.map((d) => ({
          name: d.name,
          amountKc: d.amountKc,
          pp: originalForPp > 0 ? Math.round((d.amountKc / originalForPp) * 1000) / 10 : 0,
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

// ─────────────────────────────────────────────
// Web column + Beds24 availability gate
// ─────────────────────────────────────────────
//
// Web prices come from Beds24 GET /inventory/rooms/offers — the SAME
// endpoint the rental site (Cursor/rental-site/src/lib/beds24-offers.ts)
// uses to render its booking widget. Returns the final bookable
// `totalPrice` with all multipliers, length-of-stay rules, and channel
// rate plans applied. Naturally returns nothing for unavailable dates,
// so the same call that gives us the Web price ALSO tells us whether to
// run the (expensive) puppeteer scrapers for that slot at all.
//
// Slots where neither room has an offer are dropped before scraping —
// saves Vercel function time and reduces anti-bot exposure.

const BEDS24_API_BASE = 'https://beds24.com/api/v2';
const BEDS24_PROPERTY_ID = 311322;
const SELL_ROOM_2KK = 656437; // K.201
const SELL_ROOM_1KK = 648816; // virtual 1KK (qty=2 → K.202 + K.203)

let beds24CachedToken: string | null = null;
let beds24TokenExpiresAt = 0;

async function getBeds24Token(): Promise<string | null> {
  const refreshToken = process.env.BEDS24_REFRESH_TOKEN;
  if (!refreshToken) return null;

  const now = Date.now();
  if (beds24CachedToken && now < beds24TokenExpiresAt - 60_000) {
    return beds24CachedToken;
  }
  const res = await fetch(`${BEDS24_API_BASE}/authentication/token`, {
    headers: { refreshToken },
    cache: 'no-store',
  });
  if (!res.ok) {
    console.log(`[pricing] Beds24 token refresh failed ${res.status}`);
    return null;
  }
  const json = await res.json();
  beds24CachedToken = json.token as string;
  beds24TokenExpiresAt = now + (json.expiresIn as number) * 1000;
  return beds24CachedToken;
}

/** Pick a numeric total from a Beds24 offer object — totalPrice preferred. */
function parseOfferAmount(first: unknown): number | null {
  if (first === null || typeof first !== 'object') return null;
  const obj = first as { totalPrice?: unknown; price?: unknown };
  const raw =
    obj.totalPrice != null && obj.totalPrice !== ''
      ? obj.totalPrice
      : obj.price != null && obj.price !== ''
        ? obj.price
        : null;
  const n = typeof raw === 'string' ? parseFloat(raw.replace(',', '.')) : Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/**
 * One /inventory/rooms/offers call per slot — returns offers for all
 * rooms at the property. Maps each sellable room to its first offer's
 * totalPrice, or null if no offer (= unavailable for those dates).
 */
async function fetchOffersForSlot(
  token: string,
  arrival: string,
  departure: string,
): Promise<{ k201: number | null; oneKK: number | null }> {
  const params = new URLSearchParams({
    propertyId: String(BEDS24_PROPERTY_ID),
    arrival,
    departure,
    numAdults: '2',
    numChildren: '0',
  });
  const res = await fetch(`${BEDS24_API_BASE}/inventory/rooms/offers?${params.toString()}`, {
    headers: { token },
    cache: 'no-store',
  });
  if (!res.ok) {
    console.log(`[pricing] Beds24 offers ${arrival}→${departure} failed ${res.status}`);
    return { k201: null, oneKK: null };
  }
  const data = await res.json().catch(() => null);
  const rows: unknown[] = Array.isArray((data as { data?: unknown[] } | null)?.data)
    ? ((data as { data: unknown[] }).data)
    : Array.isArray(data)
      ? (data as unknown[])
      : [];

  const out: { k201: number | null; oneKK: number | null } = { k201: null, oneKK: null };
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const rid = Number((row as { roomId?: unknown }).roomId);
    const offers = (row as { offers?: unknown }).offers;
    if (!Array.isArray(offers) || offers.length === 0) continue;
    const total = parseOfferAmount(offers[0]);
    if (total === null) continue;
    if (rid === SELL_ROOM_2KK) out.k201 = total;
    else if (rid === SELL_ROOM_1KK) out.oneKK = total;
  }
  return out;
}

// ─────────────────────────────────────────────
// Beds24-driven slot discovery
// ─────────────────────────────────────────────
//
// Probes /inventory/rooms/offers directly (not /calendar). Why: /calendar
// reports raw numAvail, but /offers also enforces min-stay rules,
// channel-specific rate plan availability, and length-of-stay
// configuration. A date can be "numAvail=1" in calendar but produce no
// offer — picking such a date results in empty Web/Booking/Airbnb cells.
//
// Strategy: walk candidate start dates in 2-day steps. For each, call
// /offers at the requested stay length. Prefer windows where BOTH rooms
// have offers (Web column populated for both rooms in the table).
// Settle for "any room has offer" only if no both-rooms window exists.
// Cache hits so the downstream gate doesn't re-call.

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type OfferProbe = { k201: number | null; oneKK: number | null };

/**
 * Walks candidate start dates in `stepDays` increments, probing /offers
 * for the given stay length. Prefers slots where both rooms produce an
 * offer; falls back to single-room availability if nothing fully
 * available. Returns null if absolutely nothing was bookable in window.
 */
async function findFirstOfferableWindow(
  token: string,
  windowStart: Date,
  windowEnd: Date,
  nights: 2 | 7,
  stepDays: number,
  cache: Map<string, OfferProbe>,
  excludeDateStr?: string, // exclude an exact checkIn (for 2nd slot dedup)
): Promise<{ checkIn: string; checkOut: string; nights: 2 | 7; probe: OfferProbe } | null> {
  const lastValidStart = windowEnd.getTime() - nights * 86_400_000;
  let bothRoomsHit: { checkIn: string; checkOut: string; probe: OfferProbe } | null = null;
  let anyRoomHit: { checkIn: string; checkOut: string; probe: OfferProbe } | null = null;

  for (let t = windowStart.getTime(); t <= lastValidStart; t += stepDays * 86_400_000) {
    const checkIn = ymd(new Date(t));
    if (excludeDateStr && checkIn === excludeDateStr) continue;
    const checkOut = ymd(new Date(t + nights * 86_400_000));
    const cacheKey = `${checkIn}|${checkOut}`;
    let probe = cache.get(cacheKey);
    if (!probe) {
      probe = await fetchOffersForSlot(token, checkIn, checkOut);
      cache.set(cacheKey, probe);
    }

    if (probe.k201 !== null && probe.oneKK !== null) {
      // Best case: both rooms bookable
      bothRoomsHit = { checkIn, checkOut, probe };
      break;
    }
    if (!anyRoomHit && (probe.k201 !== null || probe.oneKK !== null)) {
      anyRoomHit = { checkIn, checkOut, probe };
      // Don't break — keep looking for a both-rooms hit
    }
  }

  const winner = bothRoomsHit ?? anyRoomHit;
  if (!winner) return null;
  return { ...winner, nights };
}

export type DiscoveryResult = {
  slots: Array<{ checkIn: string; checkOut: string; nights: 2 | 7 }>;
  /** Pre-fetched offers keyed by `${checkIn}|${checkOut}` so the gate doesn't re-call /offers. */
  offersCache: Map<string, OfferProbe>;
};

/**
 * Production slot picker — probes /offers across the look-ahead window
 * and returns the first 2-night and first 7-night windows that produce
 * actual bookable offers. Falls back to fixed-date generation when the
 * Beds24 token is unavailable (local dev) or no offerable windows exist.
 */
export async function discoverAvailableSlots(): Promise<DiscoveryResult> {
  const token = await getBeds24Token();
  const offersCache = new Map<string, OfferProbe>();

  if (!token) {
    console.log(`[pricing] No Beds24 token — falling back to fixed-date slot generator`);
    return { slots: generateDateSlots(), offersCache };
  }

  const { start, end } = computeWindow();
  console.log(`[pricing] Probing offers ${ymd(start)} → ${ymd(end)} for available slots`);

  const slots: Array<{ checkIn: string; checkOut: string; nights: 2 | 7 }> = [];

  // 2-night first. Step 2 days so we don't hammer the API but still
  // sample finely enough to find narrow availability gaps.
  const win2 = await findFirstOfferableWindow(token, start, end, 2, 2, offersCache);
  if (win2) {
    slots.push({ checkIn: win2.checkIn, checkOut: win2.checkOut, nights: 2 });
    console.log(
      `[pricing] Picked 2-night slot: ${win2.checkIn} → ${win2.checkOut} (K.201=${win2.probe.k201 ?? '—'}, 1KK=${win2.probe.oneKK ?? '—'})`,
    );
  } else {
    console.log(`[pricing] No 2-night offerable window found`);
  }

  // 7-night search starts after the 2-night checkout for diversity, but
  // step 3 days to keep the probe count low. Excludes the 2-night
  // checkIn day to avoid an identical-start window.
  const search7Start = win2
    ? new Date(new Date(win2.checkOut + 'T00:00:00Z').getTime())
    : start;
  const win7 = await findFirstOfferableWindow(
    token,
    search7Start,
    end,
    7,
    3,
    offersCache,
    win2?.checkIn,
  );
  if (win7) {
    slots.push({ checkIn: win7.checkIn, checkOut: win7.checkOut, nights: 7 });
    console.log(
      `[pricing] Picked 7-night slot: ${win7.checkIn} → ${win7.checkOut} (K.201=${win7.probe.k201 ?? '—'}, 1KK=${win7.probe.oneKK ?? '—'})`,
    );
  } else {
    console.log(`[pricing] No 7-night offerable window found`);
  }

  if (slots.length === 0) {
    console.log(`[pricing] No offerable windows discovered — falling back to fixed dates`);
    return { slots: generateDateSlots(), offersCache };
  }

  return { slots, offersCache };
}

export type AvailabilityGated = {
  /** Slots that have at least one room available (kept for scraping). */
  availableSlots: Array<{ checkIn: string; checkOut: string; nights: 2 | 7 }>;
  /** Web column results indexed by ORIGINAL slot index. */
  webResults: RoomOffers[];
  /** Map availableSlot index → original slot index, for stitching scraper output back. */
  availableToOriginalIdx: number[];
};

/**
 * Single source of truth for Web prices + availability:
 *   - One /offers call per slot.
 *   - First offer's totalPrice → Web column (matches rental site).
 *   - Slots where neither room has an offer → dropped from scraping.
 */
async function fetchWebPricesAndAvailability(
  slots: Array<{ checkIn: string; checkOut: string; nights: 2 | 7 }>,
  offersCache?: Map<string, OfferProbe>,
): Promise<AvailabilityGated> {
  const token = await getBeds24Token();
  if (!token) {
    console.log(`[pricing] Beds24 token unavailable — Web column empty, skipping availability filter`);
    return {
      availableSlots: slots,
      webResults: slots.map(() => ({ k201: NULL_OFFER, oneKK: NULL_OFFER })),
      availableToOriginalIdx: slots.map((_, i) => i),
    };
  }

  console.log(`[pricing] Beds24 offers + availability check for ${slots.length} slot(s)`);
  const webResults: RoomOffers[] = [];
  const availableSlots: Array<{ checkIn: string; checkOut: string; nights: 2 | 7 }> = [];
  const availableToOriginalIdx: number[] = [];

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    let webRow: RoomOffers = { k201: NULL_OFFER, oneKK: NULL_OFFER };
    try {
      const cacheKey = `${slot.checkIn}|${slot.checkOut}`;
      let res = offersCache?.get(cacheKey);
      if (!res) {
        res = await fetchOffersForSlot(token, slot.checkIn, slot.checkOut);
      } else {
        console.log(`[pricing] Beds24 ${slot.checkIn}→${slot.checkOut}: using cached offers from discovery`);
      }
      const toOffer = (price: number | null): Offer =>
        price !== null
          ? { price, originalPrice: null, labels: [], availability: 'available' }
          : { ...NULL_OFFER, availability: 'not_available' };
      webRow = { k201: toOffer(res.k201), oneKK: toOffer(res.oneKK) };
      console.log(
        `[pricing] Beds24 ${slot.checkIn}→${slot.checkOut}: K.201=${res.k201 ?? '—'} 1KK=${res.oneKK ?? '—'}`,
      );
      if (res.k201 !== null || res.oneKK !== null) {
        availableSlots.push(slot);
        availableToOriginalIdx.push(i);
      } else {
        console.log(`[pricing] Beds24 ${slot.checkIn} → no rooms available, dropping slot`);
      }
    } catch (err) {
      console.log(`[pricing] Beds24 ${slot.checkIn} failed: ${err instanceof Error ? err.message : err}`);
      availableSlots.push(slot);
      availableToOriginalIdx.push(i);
    }
    webResults.push(webRow);
  }

  console.log(
    `[pricing] Availability filter: ${availableSlots.length}/${slots.length} slots kept`,
  );
  return { availableSlots, webResults, availableToOriginalIdx };
}

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
  // Production: discover available dates from Beds24 and pick from those.
  // Custom (operator-provided) slots bypass discovery — operator knows the
  // dates they want to compare.
  let slots: Array<{ checkIn: string; checkOut: string; nights: 2 | 7 }>;
  let offersCache: Map<string, OfferProbe> | undefined;
  if (customSlots) {
    slots = customSlots;
  } else {
    const discovery = await discoverAvailableSlots();
    slots = discovery.slots;
    offersCache = discovery.offersCache;
  }
  console.log(`[pricing] Starting run — ${slots.length} slot(s)`);

  // STEP 1: Beds24 availability gate. Reuses the offers cache from
  // discovery so we don't re-call /offers for the same slots.
  const { availableSlots, webResults, availableToOriginalIdx } =
    await fetchWebPricesAndAvailability(slots, offersCache);

  // STEP 2: Scrape Airbnb + Booking ONLY for surviving slots
  let bookingScraped: RoomOffers[] = [];
  let airbnbK201Scraped: Offer[] = [];
  let airbnb1kkScraped: Offer[] = [];

  if (availableSlots.length > 0) {
    const browser = await launchBrowser();
    console.log(`[pricing] Browser launched (scraping ${availableSlots.length} slot(s))`);
    try {
      bookingScraped = await scrapeBookingCom(browser, availableSlots);
      airbnbK201Scraped = await scrapeAirbnbViaBrowser(browser, AIRBNB_K201_ID, availableSlots);
      airbnb1kkScraped = await scrapeAirbnbViaBrowser(browser, AIRBNB_1KK_ID, availableSlots);
    } finally {
      await browser.close().catch(() => null);
      console.log(`[pricing] Browser closed`);
    }
  } else {
    console.log(`[pricing] No available slots — skipping all scrapers`);
  }
  console.log(`[pricing] All scrapers done`);

  // STEP 3: Stitch scraper results back to original slot positions.
  // Slots that were dropped get NULL_OFFER for Airbnb/Booking (Web stays
  // as not_available from the gate, which is correct).
  const bookingResults: RoomOffers[] = slots.map(() => ({ k201: NULL_OFFER, oneKK: NULL_OFFER }));
  const airbnbK201Full: Offer[] = slots.map(() => NULL_OFFER);
  const airbnb1kkFull: Offer[] = slots.map(() => NULL_OFFER);
  availableToOriginalIdx.forEach((origIdx, scrapeIdx) => {
    if (bookingScraped[scrapeIdx]) bookingResults[origIdx] = bookingScraped[scrapeIdx];
    if (airbnbK201Scraped[scrapeIdx]) airbnbK201Full[origIdx] = airbnbK201Scraped[scrapeIdx];
    if (airbnb1kkScraped[scrapeIdx]) airbnb1kkFull[origIdx] = airbnb1kkScraped[scrapeIdx];
  });

  const runs: PricingRun[] = slots.map((slot, i) => ({
    checkIn: slot.checkIn,
    checkOut: slot.checkOut,
    nights: slot.nights,
    rooms: [
      {
        roomLabel: '1KK Deluxe',
        web: webResults[i].oneKK,
        airbnb: airbnb1kkFull[i],
        bookingCom: bookingResults[i].oneKK,
        spread: calcSpread([webResults[i].oneKK.price, airbnb1kkFull[i].price, bookingResults[i].oneKK.price]),
      },
      {
        roomLabel: '2KK Deluxe',
        web: webResults[i].k201,
        airbnb: airbnbK201Full[i],
        bookingCom: bookingResults[i].k201,
        spread: calcSpread([webResults[i].k201.price, airbnbK201Full[i].price, bookingResults[i].k201.price]),
      },
    ],
  }));

  return { timestamp: new Date().toISOString(), runs };
}

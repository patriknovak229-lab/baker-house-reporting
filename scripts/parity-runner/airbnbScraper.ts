/**
 * Airbnb scraper — verbatim port of the proven Reserve-panel extraction from
 * utils/platformScraper.ts (deleted with the Vercel scraping pipeline; this
 * module is its only survivor). Runs in real Chrome on the operator's Mac.
 *
 * The approach: anchor on the Reserve button's booking panel, read the stay
 * total from the panel text (Czech and English layouts, USD fallback), open
 * the "Show price breakdown" dialog for itemised discounts, and hover the
 * strikethrough for the discount label. Every heuristic in here earned its
 * place against a real regression — trim with care.
 */
import type { Browser } from 'puppeteer-core';
import type { ParityOffer } from '../../utils/parityTypes';

type Offer = ParityOffer;
const NULL_OFFER: Offer = { price: null, originalPrice: null, labels: [], availability: 'not_available' };

// Wrap a promise with a hard timeout so a single slot cannot hang the whole run
function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${tag} timed out after ${ms}ms`)), ms)),
  ]);
}

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

export async function scrapeAirbnbViaBrowser(
  browser: Browser,
  listingId: string,
  slots: Array<{ checkIn: string; checkOut: string; nights: number }>,
): Promise<Offer[]> {
  const page = await browser.newPage();
  // tsx/esbuild `__name` helper polyfill — see bookingScraper.ts for why.
  await page.evaluateOnNewDocument('window.__name = (fn) => fn;');
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
        panelKcStrikeFromText: number | null;
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
            panelKcStrikeFromText: null,
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
        let panelKcStrikeFromText: number | null = null;
        let currencyDetected: 'CZK' | 'USD' | null = null;

        // Two-amount pattern FIRST: when Airbnb's Czech panel renders a
        // discount, it stacks BOTH prices below "Celkem", typically with a
        // "Zobrazit rozpis ceny" link between them, e.g.
        //   "Celkem\nZobrazit rozpis ceny\n16 949 Kč\n15 255 Kč"
        // Capture both — smaller is the bookable total, larger is the
        // strikethrough original. Window 200 chars to tolerate inline labels.
        const twoKcMatch = panelText.match(
          /\b(?:total|celkem)\b[\s\S]{0,200}?(\d[\d ,.\u00a0]{2,20})\s*Kč[\s\S]{0,80}?(\d[\d ,.\u00a0]{2,20})\s*Kč/i,
        );
        const kcTotalMatch =
          // EN: "X Kč total" inline
          panelText.match(/(\d[\d ,.\u00a0]{2,20})\s*Kč[ \t]+(?:total|celkem)\b/i) ??
          // EN/CZ: "Total/Celkem X Kč" — single price after the label.
          // \s allows newlines so we also catch panels where the price
          // renders on the line(s) below "Celkem" (no-discount layouts).
          panelText.match(/\b(?:total|celkem)\b\s{1,200}(\d[\d ,.\u00a0]{2,20})\s*Kč/i) ??
          // CZ: "X Kč za N nocí" (headline price → "for N nights")
          panelText.match(/(\d[\d ,.\u00a0]{2,20})\s*Kč\s+za\s+\d+\s+noc[ií]?/i);
        if (twoKcMatch) {
          const a = parsePanelAmount(twoKcMatch[1]);
          const b = parsePanelAmount(twoKcMatch[2]);
          if (a > 0 && b > 0) {
            panelKcTotal = Math.min(a, b);
            if (Math.max(a, b) > Math.min(a, b)) {
              panelKcStrikeFromText = Math.max(a, b);
            }
            currencyDetected = 'CZK';
          }
        }
        if (panelKcTotal === null && kcTotalMatch) {
          panelKcTotal = parsePanelAmount(kcTotalMatch[1]);
          currencyDetected = 'CZK';
        }
        if (panelKcTotal === null) {
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
          .find((el) => /^\s*(show\s*price\s*breakdown|zobrazit\s*rozpis(?:\s*ceny)?)\s*$/i.test((el.textContent || '').trim()));
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
          panelKcStrikeFromText,
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

      // Tooltip unavailable — fall back to the panel's own "X Kč total" text.
      // Prefer DOM-detected strikethrough; fall back to the second Kč figure
      // captured by the two-amount panel regex (the Czech panel layout
      // doesn't always tag the original price with a <s>/<del> wrapper).
      if (price === null && panelResult.panelKcTotal) {
        price = panelResult.panelKcTotal;
        originalPrice =
          panelResult.panelStrikethrough ?? panelResult.panelKcStrikeFromText;
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
          /Sleva\s*za\s*brzkou\s*rezervaci/i, // CZ: early booking
          /Last[- ]?minute\s*(?:discount|deal)/i,
          /Sleva\s*na\s*posledn[ií]\s*chv[ií]li/i, // CZ: last-minute
          /Weekly\s*stay\s*discount/i,
          /Weekly\s*(?:discount|rate)/i,
          /T[ýy]denn[ií]\s*sleva/i, // CZ: weekly
          /Monthly\s*stay\s*discount/i,
          /Monthly\s*(?:discount|rate)/i,
          /M[ěe]s[ií]?[čc]n[ií]\s*sleva/i, // CZ: monthly
          /New[- ]?listing\s*promotion/i,
          /Nov[áa]\s*nab[ií]dka/i, // CZ: new listing
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

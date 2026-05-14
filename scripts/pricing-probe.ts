/* eslint-disable */
/**
 * Standalone probe for the pricing scrapers.
 *
 * Runs `runFullPricingCheck` against a fixed slot so we can validate scraper
 * output against what a real browser shows. Bypasses the Next.js route layer.
 *
 * Usage:
 *   pnpm dlx tsx scripts/pricing-probe.ts
 *   pnpm dlx tsx scripts/pricing-probe.ts 2026-10-15 2026-10-17
 *
 * Reads CHROME_EXECUTABLE_PATH from .env.local automatically.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Manual .env.local loader — Next.js auto-loads it for routes, but a CLI
// script needs to pull it in itself.
function loadEnv() {
  try {
    const raw = readFileSync(resolve(__dirname, '..', '.env.local'), 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.replace(/^"|"$/g, '');
    }
  } catch {
    /* file may be missing in CI */
  }
}
loadEnv();

// tsx (esbuild) injects a `__name(fn, "Name")` helper around named arrow
// functions when transpiling. When the scraper passes a callback to
// `page.evaluate(...)`, the callback is serialised to source and run inside
// Puppeteer's browser context — where `__name` is undefined. We polyfill it
// on every newly-opened page so the probe runs end-to-end locally.
import puppeteerCore from 'puppeteer-core';
const origLaunch = puppeteerCore.launch.bind(puppeteerCore);
(puppeteerCore as unknown as { launch: typeof origLaunch }).launch = async (
  ...args: Parameters<typeof origLaunch>
) => {
  const browser = await origLaunch(...args);
  const origNewPage = browser.newPage.bind(browser);
  browser.newPage = async () => {
    const page = await origNewPage();
    await page.evaluateOnNewDocument(() => {
      (window as unknown as { __name: (fn: unknown) => unknown }).__name = (fn) => fn;
    });
    return page;
  };
  return browser;
};

async function main() {
  const checkIn = process.argv[2] ?? '2026-10-15';
  const checkOut = process.argv[3] ?? '2026-10-17';
  const nightsArg = Number(process.argv[4] ?? '2') as 1 | 2 | 7 | 28;

  const { runFullPricingCheck } = await import('../utils/platformScraper');

  const started = Date.now();
  console.log(
    `\n=== probe ${checkIn} → ${checkOut} (${nightsArg}n) ===\n`,
  );
  const result = await runFullPricingCheck([
    { checkIn, checkOut, nights: nightsArg },
  ]);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\n=== result (${elapsed}s) ===`);
  for (const run of result.runs) {
    console.log(
      `\nSlot ${run.checkIn} → ${run.checkOut} (${run.nights}n)`,
    );
    for (const room of run.rooms) {
      const f = (o: { price: number | null; originalPrice: number | null }) =>
        o.price == null
          ? '—'
          : `${o.price} Kč${o.originalPrice ? ` (was ${o.originalPrice})` : ''}`;
      console.log(`  ${room.roomLabel}`);
      console.log(`    Web:       ${f(room.web)}`);
      console.log(
        `    Airbnb:    ${f(room.airbnb)}  labels=[${room.airbnb.labels.join(', ')}]`,
      );
      if (room.airbnb.discountBreakdown?.length) {
        console.log(
          `               breakdown: ${room.airbnb.discountBreakdown
            .map((d) => `${d.name}(-${d.amountKc} Kč, -${d.pp}pp)`)
            .join(', ')}`,
        );
      }
      console.log(
        `    Booking:   ${f(room.bookingCom)}  labels=[${room.bookingCom.labels.join(', ')}]`,
      );
      if (room.bookingCom.discountBreakdown?.length) {
        console.log(
          `               breakdown: ${room.bookingCom.discountBreakdown
            .map((d) => `${d.name}(-${d.amountKc} Kč, -${d.pp}pp)`)
            .join(', ')}`,
        );
      }
    }
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Probe failed:', err);
  process.exit(1);
});

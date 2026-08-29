import type { NextConfig } from "next";

/**
 * Routes that launch headless Chromium — every PDF export plus the price
 * scraper.
 *
 * `@sparticuz/chromium` ships the browser as brotli archives under `bin/` that
 * nothing imports statically, so file tracing cannot see them. Unless the route
 * is named here its function bundle deploys WITHOUT them and dies at runtime on
 * "The input directory /var/task/node_modules/@sparticuz/chromium/bin does not
 * exist" — a failure that no build step catches, because the build is happy and
 * only the user clicking Export ever finds out.
 *
 * Historically this list held just send-invoice and platform-prices, so every
 * other PDF feature (commission statements, owner emails, invoice-to-Drive, the
 * due-invoice cron) shipped broken. `utils/pdfTracing.test.ts` now fails the
 * suite if a route reaches Chromium without being listed here.
 *
 * KEYS are route paths, per the Next 16 docs (`/api/hello`), not source paths.
 * Turbopack currently accepts the older `app/api/…/route` spelling too, but the
 * documented form is the one to keep.
 */
export const CHROMIUM_ROUTES = [
  "/api/send-invoice",
  "/api/cron/send-due-invoices",
  "/api/transactions/invoice-to-drive",
  "/api/commission/pdf",
  "/api/commission/annual-pdf",
  "/api/commission/email",
  "/api/platform-prices",
];

const CHROMIUM_FILES = ["./node_modules/@sparticuz/chromium/bin/**/*"];

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    ...Object.fromEntries(CHROMIUM_ROUTES.map((route) => [route, CHROMIUM_FILES])),
    // AI reply composer reads the property knowledge base at runtime — make
    // sure the markdown ships inside the webhook's serverless bundle.
    "/api/webhook/beds24-message": ["./data/ai-knowledge-base.md"],
  },
};

export default nextConfig;

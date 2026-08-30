# Parity runner — local price scraper

The Pricing tab's **Parity check** view is fed by a small job on the operator's
Mac, not by Vercel. Booking.com bot-challenges datacenter IPs (the old
serverless scraper returned empty Booking columns for months because of it);
a real Chrome on a residential IP gets the full page. Same pattern as the
iCloud invoice import: the Mac is the trusted local half of the pipeline.

## How it works

```
launchd (every 5 min)
  └─ scripts/parity-runner/run.ts
       1. GET  /api/pricing/ingest      ── work order (secret header)
          · gridDue? → the server sends today's SLOT PLAN: an
            availability-aware sweep of the next 60 days (2-night stays daily
            for ~3 weeks out + a 1-in-3 rotation beyond; 7-night stays on a
            1-in-7 rotation), planned from the PriceLabs availability
            snapshot so unsellable stays are never scraped. Once per day
            after 08:00 Prague. PARITY_SWEEP in data/parityConfig tunes it.
          · pendingRequests → custom checks queued in the UI
       2. Scrape Booking.com (structured .hprt-table parse, all room types)
          + Airbnb (Reserve-panel logic, per configured listing, only for
          units the plan says can sell the stay) + competitor listings from
          data/parityConfig COMPETITORS (grid runs only)
       3. POST /api/pricing/ingest      ── observations
          · server adds the Web column from Beds24 offers for EVERY 2-night
            check-in in the window (the occupancy board), scraped or not
          · computes expected prices from data/parityConfig economics
          · appends to price_snapshots (history), closes custom requests
          · Telegram alerts: Booking≤Airbnb, gap>30%, expected-price drift,
            whole-channel-empty (scraper health)
```

Most invocations exit in ~1 s with "nothing to do". A grid run takes
~10–15 min (roughly 40 Booking + 60 Airbnb page loads). `PARITY_FORCE_GRID=1
npm run parity:run` re-runs today's grid by hand.

## Setup (once per Mac)

1. `.env.local` must contain:
   ```
   CHROME_EXECUTABLE_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
   PRICING_INGEST_SECRET=<same value as the Vercel env var>
   # optional — defaults to https://reporting.bakerhouseapartments.cz
   # PARITY_INGEST_URL=http://localhost:3000
   ```
2. Vercel must have `PRICING_INGEST_SECRET` set to the same value (the ingest
   endpoint refuses everything until it is).
3. Install the launchd job:
   ```bash
   cp scripts/parity-runner/com.bakerhouse.parity-runner.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.bakerhouse.parity-runner.plist
   ```
4. Watch it: `tail -f ~/Library/Logs/parity-runner.log`

Manual run any time:

```bash
npm run parity:run
```

Useful env toggles for a manual run: `RUNNER_HEADFUL=1` shows the browser;
`PARITY_GRID_AFTER=00:00` lets the grid run before 08:00 Prague;
`PARITY_INGEST_URL=http://localhost:3000` targets a dev server.

## Coverage & config

Everything lives in `data/parityConfig.ts`:

- **Units ↔ channels.** Booking.com room-type ids were verified live
  2026-08-29 (1541267401 = 1KK Deluxe, 1541267405 = K.201, 1541267403 =
  O.308). The Urban studios are not on the main Booking property page; O.308
  and Urban have no Airbnb listing wired. Fill those in when they exist —
  the UI deliberately shows the gaps as "—" rather than hiding the rows.
- **The grid** (`PARITY_GRID`): lead times × stay lengths. Changing it changes
  tomorrow's sample, never the stored history.
- **Expected prices** (`PARITY_ECONOMICS`): channel markup % + always-on
  discount stack per unit. All markups start `null` = feature dormant. Copy
  the real values from Beds24 channel settings / Booking promotions / Airbnb
  discounts to arm the drift alert (>2% observed-vs-expected).

## Failure modes

- **Mac asleep / offline** → no runs; the Parity view shows an amber "runner
  has not reported today" banner after 26 h. Nothing else breaks; the Radar
  view is independent.
- **Booking wall reappears even locally** → the run ingests `error`/empty
  offers and the server fires the 🛑 whole-channel-empty Telegram alert. Try
  `RUNNER_HEADFUL=1` (headless Chrome fingerprints differently), and if that
  is not enough the fallback is a scraping API (Zyte/ScrapingBee) — see
  docs/pricing-rework-proposal.md.
- **Secret mismatch** → every poll logs HTTP 401; fix the env var on either
  side.

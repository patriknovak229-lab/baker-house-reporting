# Pricing section — review & rework proposal

> **Implementation status (2026-08-29):** BUILT the same day the proposal was
> approved, local-runner variant. Product A (Radar) and Product B (parity
> pipeline: `price_snapshots`, ingest API, local runner, new Parity view,
> Telegram alerts) are in main; the Vercel scraper, its cron and
> `utils/platformScraper.ts` are deleted. Operational setup lives in
> `docs/pricing-runner.md`. Remaining manual steps: `PRICING_INGEST_SECRET`
> on Vercel, `launchctl load` of the runner plist, and calibrating
> `PARITY_ECONOMICS` markups to arm expected-price drift alerts.

Reviewed 2026-08-29 against the live system: code, production Redis snapshot,
live probes of Booking.com (plain HTTP + real browser) and the PriceLabs API.
Nothing was changed; this is analysis and a build plan.

**Verdict up front:** the Pricing tab conflates two different jobs — *"what does
a customer see on each channel"* (needs scraping) and *"are we priced right for
the dates that matter"* (needs no scraping at all — the data is already in
Postgres, refreshed daily, and mostly ignored). The scraping half is
structurally broken on Vercel and can't be patched into reliability there. The
market half can ship a demand calendar this week with ~2 new columns.

---

## 1. How it is built today

```
Vercel cron 07:00 UTC ──► POST /api/platform-prices        (maxDuration 300s)
                             │
                             ├─ discoverAvailableSlots()    Beds24 /offers probing:
                             │                              first 2-night + first 7-night
                             │                              bookable window ≤65 days out
                             ├─ fetchWebPricesAndAvailability()
                             │                              Beds24 /offers totalPrice → Web column
                             ├─ scrapeBookingCom()          puppeteer + @sparticuz/chromium,
                             │                              innerText line-walking + regex,
                             │                              click-pass for breakdown tooltips
                             ├─ scrapeAirbnbViaBrowser()×2  Reserve-panel innerText parsing,
                             │                              Czech/English regex, USD fallback
                             │                              with hardcoded FX 24.0
                             ▼
                        Redis key `platform-prices:latest`, TTL 36 h  ──► PricingPage.tsx
```

- `utils/platformScraper.ts` — **1,913 lines**, almost all of it DOM-heuristic
  text parsing.
- Storage is one overwritten Redis key. No history, no trend, no alerting.
- Only **2 of 4** sellable unit types monitored (1KK Deluxe, K.201). Urban
  Studios (3 units) and O.308 are invisible.
- 11 commits since March, **8 of them `fix(pricing)`** — a maintenance
  treadmill, and it still fails.

## 2. Findings — why it doesn't work

### F1 — Booking.com returns nothing in production (the main complaint)

Today's scheduled run (2026-08-29 12:22 UTC), straight from production Redis:
every Booking.com cell is `null` for both rooms and both slots, while Web and
Airbnb are populated. This is not a parsing bug; the page never renders.

Root cause verified: Booking.com bot-challenges non-browser traffic. A plain
`curl` of the property page **from a residential IP** returns HTTP 202 with a
challenge script (3.9 KB, no room table). From a Vercel datacenter IP with
headless `@sparticuz/chromium` the odds are strictly worse. The scraper's own
diagnostics (`hasCaptcha`) were built because of this. **No amount of selector
work fixes an execution environment the target refuses to serve.**

Meanwhile the same page in a real browser from this Mac renders everything:
13 rate rows across all 4 room types, with structured `data-block-id`
attributes, explicit "Original price / Current price" text and %-off badges.

### F2 — Discount reporting is best-effort text archaeology

- Breakdown lines are regex-matched from tooltip innerText, verified by "do the
  percentage points sum within 3pp", and **discarded** otherwise
  (`unparsedDiscount: true` → the UI shows "(unbreakable)").
- Code comments document past false positives ("Last Minute Deal" matched from
  help copy elsewhere on the page) and the countermeasures are heuristics on
  top of heuristics (price-anchored HTML windows, ±3% tooltip tolerance).
- Airbnb has a hardcoded USD→CZK rate (24.0) for when Vercel gets served USD
  despite three currency-forcing mechanisms — i.e. currency itself is flaky.
- Real, current example the tool missed entirely: for 20–22 Sep the cheapest
  2KK rate on Booking.com is **5,459 Kč (was 7,563, −27.8 %)** vs Airbnb
  7,025 Kč — Booking undercuts Airbnb by 22 % and no alert exists to say so.

### F3 — No memory, no comparability, no alerts

Each run samples *different dates* (first bookable windows), so day-over-day
results aren't comparable even when they succeed. The single Redis key expires
after 36 h — one failed cron and the tab is empty. Nothing watches for "Booking
< Airbnb", "scrape returned nothing 2 days running", or "price dropped 30 %".

### F4 — The paid market data is unused by this tab

PriceLabs (~$4/mo, integrated 2026-08) already lands in Postgres daily at 06:30
(`market_daily`: per-date market occupancy, pickup, cancellations, supply,
price percentiles p25–p90, median booked price, our live + recommended price).
The Pricing tab reads none of it.

## 3. What I verified live (the basis for the redesign)

### PriceLabs can answer "low/high demand dates" directly — today

`POST /v1/listing_prices` (the call the daily cron **already makes**) returns
per date, even with `reason: false`:

| field | content | example |
|---|---|---|
| `demand_desc` | 5-level classification | Low / Normal / Good / **High Demand** / Unavailable |
| `demand_color` | their calendar hex | `#2b8cbe78` = High |
| `min_stay`, `occupancy`, `ADR`, `booking_status` | per date | |

One call = **366 days × all 4 listings, 1.1 s, 516 KB**. Next-12-month counts
right now: ~37 High-Demand and ~50 Good-Demand days per listing. The refresh
cron currently throws these fields away.

With `reason: true` (worth storing for a shorter horizon, e.g. 90 days):
`market_factors` — Seasonality (+26 %), Demand Factor (+20 %, split into
`hotel_demand` +1 % / `str_demand` +19 %), plus `nhood_occ` (market occupancy
that night) and a human-readable `summary` sentence per date.

### Events — confirmed working via Report Builder

Verified live against the account (official docs: developers.pricelabs.co):

- `POST /v1/report_builder/data {"template_id": 6701}` → `request_id`, then
  `POST /v1/report_builder/poll` (~10 s). The **Events Pickup** report returns
  92 rows (rolling ~3 months) with per date: **`Events` (name!)**, our
  `Occupancy Pickup 3/7`, `Average Market Occupancy Pickup 3/7`, recommended
  price. Live sample: `2026-09-25..27 "St. Wenceslas Day"`,
  `2026-10-27..29 "Indep. CZ State Day"`.
- **Caveat:** their event set is essentially *public holidays*. MSV (Oct 5–9,
  the strongest business week of the year) is NOT flagged — so the curated
  `DEMAND_EVENTS` config (MotoGP, MSV, Easter, Christmas) stays the primary
  overlay, PriceLabs holidays complement it.
- `listing_prices`' own `demand_desc`/`demand_factor` catches *unnamed* spikes
  (concerts, congresses) regardless; a derived flag — market p50 or occupancy
  ≥ X % above the surrounding 7-day median — labels them "market spike".
- Template 6950 (*Historical Event Performance Analysis*) exists for the
  retrospective view via the same flow.

### Other confirmed PriceLabs facts that shape the design

- Rate limits: 60 req/min, 1,000 req/hour — the daily refresh uses a handful.
- No per-competitor prices anywhere in the API (percentiles/aggregates only).
  Comp-set granularity is the ceiling; label it as such in the UI.
- Bonus endpoints worth a later look: `GET /v1/listings` returns
  `channel_listing_details[]` (the Airbnb/Booking listing IDs per unit — can
  auto-discover the missing Urban/O.308 Airbnb listings instead of hardcoding);
  `GET /v1/listing_optimizer/ranking` returns our **Airbnb search rank, page
  and price per guest-count×LOS segment** with 90-day history — a scrape-free
  "how visible are we vs competitors" signal.
- `listing_prices` also carries per-date `weekly_discount` / `monthly_discount`
  — direct inputs for the expected-price engine in B3.

### Booking.com is scrapable — from the right place, the right way

In a real browser session from a residential IP, the room table is fully
server-rendered with machine-readable structure:

- `data-block-id="1541267401_425519900_2_0_0"` = roomId_ratePlanId_occupancy…
  (1541267401 = Deluxe 1KK, 1541267405 = 2KK Deluxe w/ Balcony, + Urban + O.308)
- Explicit `Original price 5,861 Kč / Current price 4,232 Kč` per rate row,
  plus `20% off` / `28% off` badge elements — **no innerText guessing needed**.
- All rate plans per room visible (the current code already picks cheapest).
- `/dml/graphql` (`AvailabilityCalendar`) responds in-session — a whole-month
  min-price sweep is capturable later via network interception; optimization,
  not a dependency.

## 4. Proposed architecture — split the two jobs

### Product A — **Price Radar** (no scraping; ship first)

*"Which dates are hot, and how do we sit against the market on them?"*

**Data (backend, small):**
1. Add to `market_daily`: `demand_level` (int 0–3 or text), `demand_color`,
   `min_stay`, `n_bookings` (comp-set bookings/night — already in
   `neighborhood_data → Future Percentile Prices → N_Bookings`, unstored).
2. Extraction: ~10 lines in `marketRefresh.ts` — the payloads are already
   fetched daily. Optionally a second `listing_prices` call with
   `reason: true` for the next 90 days to store `demand_factor_pct` and
   `seasonality_pct`.
3. Everything stays Postgres-read on page load, matching the analytics rule.

**UI (new default view of the Pricing tab):**
- **12-month demand calendar** per unit (heatmap by `demand_level`), overlaid
  with: curated events, derived market-spike flags, and our availability.
- **High-demand table**: every upcoming Good/High date with — our live price,
  PriceLabs recommendation, market p50/p90, median booked price, min-stay, and
  a position badge (below p25 · p25–50 · p50–75 · p75–90 · above p90).
- **Mispricing flags** (pure SQL, no ML):
  - High/Good demand & live < p50 → *underpriced candidate*
  - Low demand & live > p75 → *overpriced candidate*
  - High demand & unavailable=blocked (not booked) → *blocked hot date*
- Same flags pushed to Telegram weekly (existing bot), not just rendered.

Effort: ~1–2 days. Zero new fragility; the PriceLabs caveat (comp set =
Airbnb/VRBO view of Brno) is already labelled in the Analytics UI and applies
here identically.

### Product B — **Parity Monitor** (scraping, rebuilt)

*"What does an anonymous customer actually see on each channel, and does it
match what we intended?"*

**B1. Execution environment — the decisive fix.** Two viable options:

| | Local Mac runner (recommended) | Scraping API (Zyte / ScrapingBee / ScraperAPI) |
|---|---|---|
| How | launchd job on this Mac: Playwright + installed Chrome, POSTs results to a new `/api/platform-prices/ingest` (shared secret) | Vercel cron calls the service; it returns rendered HTML/JSON |
| IP / fingerprint | Residential + real Chrome — verified working today | Managed residential pool, they handle challenges |
| Cost | 0 Kč | ~$30–50/mo at this volume |
| Dependency | Mac awake & online (same trade-off as the accepted iCloud invoice import) | External vendor |
| Failure mode | Ingest gap → visible staleness + Telegram nag | Vendor block-rate, billing |

Vercel serverless Chromium is retired either way — it is the root cause, and
300 s of function time per day stops being burned.

**B2. Extraction — structured, not textual.**
- Booking.com: parse `.hprt-table` rows by `data-block-id`; take
  original/current price and %-off badge per rate plan; open the breakdown
  tooltip only to *name* the deals (Early Booker / Getaway / Weekly). Covers
  **all 4 room types** in one page load per date-slot.
- Airbnb: keep the working Reserve-panel logic, but capture the price via the
  page's own XHR responses (network interception) first, DOM second. Add the
  two missing listings (Urban, O.308) if they exist on Airbnb.
- Web: unchanged (Beds24 /offers — already correct and API-based).

**B3. Expected-price verification — discounts become a diff, not a guess.**
Keep a small config of *intended* channel economics per unit: channel markup %,
active Booking campaign (e.g. Getaway 20 %), weekly/monthly discount %, Genius
opt-in. Then: `expected = beds24 base × markup × (1 − configured discounts)`;
compare to observed. The report stops trying to reverse-engineer Booking's
tooltip and instead answers the real question: **"is the discount stack we
think is configured the one customers actually get?"** Deviations > 2 % alert.

**B4. Persistence & sampling — make runs comparable.**
- New Postgres table `price_snapshots` (unit, channel, check_in, nights,
  lead_days, price, original_price, discounts jsonb, captured_at) — append-only.
- Fixed sampling grid instead of "first bookable window": lead times
  **3 / 7 / 14 / 30 / 60 days × 2 and 7 nights** per unit (+ optional 28n
  monthly probe). Same grid every day → real time-series, trend charts, and
  "price at lead-14 has drifted −18 % w/w" style signals.
- Custom date check stays (runs through the same ingest path).

**B5. Alerts (Telegram, existing bot):**
- Booking < Airbnb or channel gap outside 0–15 % band (the UI's own traffic-light rule, but pushed).
- Observed ≠ expected discount stack.
- Scraper health: any channel null for 2 consecutive runs.

### Rollout order

1. **Radar** (A): columns + extraction + calendar/table UI + flags. No risk.
2. **Ingest API + `price_snapshots`** (B4 skeleton) — Vercel side.
3. **Local runner** (B1a) with structured Booking extraction (B2) — parity
   restored, all 4 units.
4. Expected-price config + verification (B3) and alerts (B5).
5. Optional later: scraping-API fallback for runner outages; Booking
   AvailabilityCalendar sweep via intercepted GraphQL; PriceLabs holiday
   overlay via Events Pickup report (confirmed working); Airbnb search-rank
   card from `listing_optimizer/ranking`.

### Decisions needed

1. **Runner location:** local Mac (free, Mac-dependent) vs scraping API
   (~$30–50/mo, zero local dependency)? Recommendation: start local — the
   pattern already exists for iCloud invoices; add the paid service only if
   uptime disappoints.
2. Genius/mobile view: monitor anonymous-desktop only (current principle), or
   also a logged-in Genius snapshot as a separate labelled column?
3. Retire the old 1,913-line scraper wholesale, or keep the Airbnb half
   running on the local runner unchanged in phase 3? Recommendation: port, then
   delete — never run it on Vercel again.

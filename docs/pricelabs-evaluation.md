# PriceLabs Customer API — evaluation

Probed 2026-08-18 against the live Baker House account. Read-only; nothing was
written. Verdict up front: **valuable, but for the opposite half of the problem
than expected.**

---

## Access

| | |
|---|---|
| Base URL | `https://api.pricelabs.co/v1` |
| Auth | `X-API-Key: <key>` header |
| Key | `PRICELABS_API_KEY` in `.env.local` (gitignored). Rotate before Vercel. |
| Cost | $1 / listing / month for API syncing — 4 synced listings, so ~$4/mo |
| Listing IDs | `311322___<beds24RoomId>` — joins straight onto our room map |

**Gotcha:** Cloudflare fronts the API and rejects unrecognised user agents with
`error code: 1010`. Node/undici and browser fetch are fine; Python `urllib` is
blocked unless you set a `User-Agent`. Worth knowing when a call mysteriously
403s with an empty body.

### PriceLabs prices the SELLABLE units, not physical rooms

Four listings, not seven:

| PriceLabs listing | Covers | min | base | recommended | max |
|---|---|---|---|---|---|
| `311322___648816` | K.202 + K.203 (2 units) | 2 300 | 3 000 | 3 026 | — |
| `311322___656437` | K.201 | 3 000 | 4 600 | 4 600 | — |
| `311322___679714` | K.102 / K.103 / K.106 (3 units) | 2 000 | 2 600 | 2 577 | — |
| `311322___674672` | O.308 | 2 800 | 4 000 | 3 965 | — |

Base sits within ±35 Kč of PriceLabs' recommendation on all four — the engine is
being followed closely. No `max` is configured at listing level (the pricing
`reason` payload shows an effective ceiling of 30 000).

---

## ⚠️ The two findings that change the plan

### 1. PriceLabs' view of OUR OWN performance is unreliable — do not use it

`/v1/listing_metrics` trailing-90-day occupancy:

| Listing | Own occupancy | Market | MPI |
|---|---|---|---|
| K.201 | 86.7% | 68.0% | 1.28 |
| O.308 | 65.6% | 68.0% | 0.96 |
| Deluxe 1KK VR | **0.0%** | 68.0% | 0.00 |
| Urban VR | **0.0%** | 68.0% | 0.00 |

The two multi-unit virtual rooms report **zero**. `/v1/reservation_data` confirms
it: 106 reservations total against our archive's 395, and only **2** rows for the
Urban VR that actually holds K.102/K.103/K.106.

Bookings land on *physical* rooms in Beds24; PriceLabs syncs at the *sellable*
level and does not attribute them back. So five of our seven rooms are largely
invisible to it.

**Consequence:** `bookings_mirror` stays the sole source of truth for our own
performance. PriceLabs is a **market** data source only. Any chart that mixes them
must take own-side numbers from Postgres and market-side numbers from PriceLabs.

### 2. There is no own-STLY, because there is no last year

Every `stly_*` field at listing level returns `-2` (their no-data sentinel) — we
started trading February 2026. **Market** STLY, however, is fully populated. So
PriceLabs solves the benchmark problem but not the year-over-year problem; the
`asof_nights` reconstruction in the analytics section remains the only route to
our own historical pace.

---

## What is genuinely useful, ranked

### 1. Market Penetration Index — the benchmark the section lacks ⭐⭐⭐
`/v1/listing_metrics` → `mpi`, bucketed by horizon. MPI = our occupancy ÷ market
occupancy; 1.0 is exactly market.

| Listing | 7d | 30d | 60d | 90d | 180d | 360d |
|---|---|---|---|---|---|---|
| Deluxe 1KK VR | 2.03 | 2.21 | 1.47 | 1.25 | 1.06 | 0.87 |
| Urban VR | 1.84 | 1.77 | 1.45 | 1.24 | 1.01 | 0.84 |
| K.201 | 1.44 | 1.28 | 1.01 | 0.82 | 0.65 | 0.54 |
| O.308 | 1.74 | 1.47 | 0.98 | 0.81 | 0.65 | 0.53 |

**Read this carefully — it is the most actionable thing in the whole dataset.** We
crush the market inside 30 days (1.3–2.2×) and fall *below* it past 90 days
(0.5–0.9×). We are winning late demand and losing early demand.

That corroborates two independent findings from our own data: only 8% of a month's
nights are on the books 60 days out, and our median booking window is 7 days
against a **market booking window of 19–20 days**. The market books nearly three
times further ahead than we do.

### 2. Market occupancy, price percentiles and pickup by date ⭐⭐⭐
`/v1/neighborhood_data` — 540 days of daily market data from a 350-listing Brno
comp set (48 in the 2BR category), split by bedroom count:

- `Future Occ/New/Canc` — daily market occupancy, new bookings (pickup), cancelled
  bookings, plus **Occupancy_LY / Occupancy_STLY** and market supply then vs now.
- `Future Percentile Prices` — 25th / 50th / 75th / 90th percentile market price
  **and median booked price**, per stay date. This is the pricing headroom answer.
- `Market KPI` — 27 months of history: market **booking window**, **LOS**,
  revenue, booked days, 7-day pickup and its STLY.

### 3. Recommended vs live vs market price, per date ⭐⭐⭐
`POST /v1/listing_prices` — per date: `price` (recommendation), `user_price` (what
is actually live on Beds24, `-1` = unavailable), `uncustomized_price`, `min_stay`,
`unbookable`, `multi_unit_occupancy`. With `reason: true` it also returns a plain
sentence — *"Seasonality is pulling prices up (+27%) but Demand Factor is pushing
prices down (−35%)"* — plus the factor-by-factor breakdown.

### 4. Report Builder — 16 prebuilt templates ⭐⭐
`/v1/report_builder/templates`. Several overlap work we would otherwise build:
*Revenue On The Books*, *Pacing*, *Segment Pacing*, *Pickup Trends*, *Day of the
Week Performance*, *Booking Source Performance*, **Events Pickup**, **Historical
Event Performance Analysis**, *Goal Tracker*, *Opportunities*, *Leaderboard*.

The two event templates are the direct answer to the demand-calendar question —
better than scraping BVV, because they measure pickup around events rather than
just listing dates.

### 5. Not worth using
- `/v1/reservation_data` and `/v1/bookings_report` — incomplete (see finding 1).
  `bookings_report` does carry `lead_time` and a proper `booking_source`, but over
  the same partial set. `rental_revenue` arrives as a **string**, and
  `cancelled_on` uses `1970-01-01T00:00:00Z` as its null.
- `/v1/groups`, `/v1/nudges/available`, `/v1/listing_optimizer/summary` — empty on
  this account.

---

## Findings already visible

**Brno 2BR supply is up 42–62% year on year.** Market listings available for the
same nights: September 26 → 43, October 27 → 43, November 28 → 40, December 30 →
38. The competitive set is growing far faster than demand, which is the strongest
argument for pricing discipline in the dataset.

**We outperform the market on occupancy while sitting near its median price.**
K.201 trailing 90 days: 86.7% occupancy against a market 68.0%, at an ADR of
3 998 Kč while the 2BR market median price runs 3 300–3 900 Kč. High occupancy at
median price is the textbook signature of underpricing on ordinary dates.

**MSV fair week is already priced correctly — I was wrong to imply otherwise.**
Live prices for 6–9 October are 6 265–6 694 Kč against a market 50th percentile of
3 400–3 900 and a 90th of 6 900–7 200. We are at roughly the market 90th
percentile, and the market itself is only 28–42% booked for those nights. The low
on-the-books figure is the *market* being early, not our rate being wrong. My
earlier suggestion to review the MSV rate should be withdrawn.

**New Year is priced above the market 90th percentile.** 31 Dec live at 13 035 Kč
versus a market 90th of 11 748 and market occupancy of 2.9%. Defensible, but it is
the one date where nothing is booked and we are the most expensive listing in the
set.

---

## Recommended integration

Additive, and it does not disturb anything already built.

**Phase 1 — market overlay (small).** A `/api/analytics/market` route calling
`listing_metrics` + `neighborhood_data`, cached in Postgres (`market_snapshots`,
one row per listing per day — the payload is ~540 KB each, so store the extracted
series, not the blob). Adds to the existing sections:

- Overview: MPI beside occupancy; market ADR beside ours.
- Seasonality: market occupancy as a reference line on the monthly chart.
- Booking windows: **market booking window against ours** — the 19 d vs 7 d gap.
- A new *Pricing* card: our achieved ADR against market percentiles by date.

**Phase 2 — pricing quality.** `listing_prices` daily into a `rate_history` table:
recommended vs live vs eventually-achieved ADR. This replaces the
`rate_shop_history` idea entirely — better data, no scraping.

**Phase 3 — drop the hardcoded event calendar** in favour of the Events Pickup and
Historical Event Performance templates.

### Mapping caveat to handle in code
PriceLabs is per sellable unit, our archive is per physical room. Comparisons must
aggregate our physical rooms up to the sellable unit:
`648816 → K.202 + K.203`, `679714 → K.102 + K.103 + K.106`, `656437 → K.201`,
`674672 → O.308`. Only K.201 and O.308 compare 1:1.

### The blind spot, restated
The comp set is scraped from **Airbnb and VRBO**. Booking.com is 83% of our nights
and is not in it. Market occupancy and price percentiles are an Airbnb/VRBO view of
Brno. Directionally sound, and the only external benchmark available — but it must
be labelled everywhere it appears.

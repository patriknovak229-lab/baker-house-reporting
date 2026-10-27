# Analytics section

Five tabs at **`/analytics`**, reachable from the nav for `admin` / `super` /
`viewer` / `accountant`, plus a sixth, **Web funnel**, for `admin` only (§10). Reads
the Postgres bookings archive plus locally cached snapshots (PriceLabs market, the
rental site's funnel counts, GA4 traffic); never calls Beds24, PriceLabs, the rental
site or Google on a page load.

---

## 1. The five questions, in the order a revenue decision gets made

| Tab | Question | Basis |
|---|---|---|
| **Overview** | How much did we make? | stay |
| **Occupancy** | How full were we, and where did we run out? | stay |
| **Booking window** | When did it sell, and did it stick? | booked |
| **Rates** | Do the rate plans, deals and channels raise gross profit? Per 1KK / 2KK (§11) | stay |
| **Costs & commissions** | What did a night cost to sell and service? | stay revenue, checkout-date turnover cost |
| **Web funnel** (admin) | Who searched the website, where did they drop out, what dates did we turn away? | event date |

Booking window will not tie to Overview, and that is correct — they answer
different questions. Every response carries a `basis` field and each tab says so.

---

## 2. Why it is built this way

### It reads Postgres, never Beds24

Every own-side figure comes from `public.bookings_mirror` — the durable archive
written by `/api/bookings` when `WRITE_BOOKINGS_MIRROR=true`. That flag **is on in
production**.

1. A Beds24 sync costs API credits and seconds, and the operational tabs coalesce
   it behind a 90-second guard that analytics must not undermine.
2. `baker:beds24-bookings-cache` only holds arrival ±1 year and a full sync wipes
   it. It structurally cannot answer a question about the whole history of the
   business. The archive can — it is upsert-only.
3. Aggregation belongs next to the data. A month × unit × channel roll-up is a few
   KB out of Postgres; the alternative ships the whole reservation array to the
   browser, which is why the Performance tab cannot grow past a month at a time.

**Two exceptions, both deliberate.** The Costs tab reads Redis, because the
cleaning app's *rate cards* (cleaner fees, laundry prices, subscriptions, wear &
tear) never migrated. And the market snapshot is written by a daily cron rather
than read live — see §5.

### There is exactly one definition of a night

`data-access/analytics/shared.ts` defines "a sold room-night" and "an available
room-night" once, as composable SQL fragments:

```
stripe_fees      → per-reservation Stripe fee (the read-time roll-up, reproduced)
alloc            → booking × physical room, money split across linked rooms
nights           → ONE ROW PER SOLD ROOM-NIGHT  ← the grain everything uses
blackout_nights  → room-nights deliberately closed
room_online      → when each room first became sellable
room_days        → physical rooms × days, from each room's online date
available        → room_days minus blackouts  ← the denominator
asof_nights      → every night ever booked, with booked-on + cancelled-at
long_nights      → room-nights held by stays over TRANSIENT_LOS_MAX
transient_available → capacity that was genuinely on sale to short stays
```

---

## 3. Four modelling decisions that change the numbers

### The sellable unit, not the room, is the unit of analysis

K.102, K.103 and K.106 are **one product** — a single Beds24 room type sold
interchangeably, with Beds24 choosing which physical studio takes each booking.
Per-room occupancy therefore measures the allocator, not demand: one room can read
100% while its siblings have space, which says the allocator packed it first and
nothing about pricing.

| Unit | Rooms | PriceLabs listing |
|---|---|---|
| 1KK Urban Studios | K.102 · K.103 · K.106 | `311322___679714` |
| 1KK Deluxe Studios | K.202 · K.203 | `311322___648816` |
| K.201 — 2KK Deluxe | K.201 | `311322___656437` |
| O.308 — 2BR Deluxe | O.308 | `311322___674672` |

Two payoffs: **"sold out" becomes meaningful** (a unit with every room sold had
nothing left at any price), and the grain matches PriceLabs 1:1, so market
comparisons need no fudge. Per-room tables are still there, behind a disclosure,
labelled as wear-and-cleaning data rather than pricing data.

### Room-aware availability

The portfolio opened in stages: K.202/K.203 from Feb 2026, K.201 from Mar, the
Urban studios from late May, O.308 from mid-June. A flat `rooms × days` denominator
reports February against four rooms that did not exist — about 15% instead of the
true 69.6%. Override in `ROOM_ONLINE_OVERRIDES` when a room was *listed* earlier
than its first booking.

### Long stays are removed from the weekday and compression signals

A Monday night inside a 25-night booking was bought once, months earlier, at a
negotiated rate — and it then blocked that room against every later Monday
enquiry. It pushes Monday occupancy **up** and Monday ADR **down** at the same
time, so the two errors cannot cancel out.

Stays over `TRANSIENT_LOS_MAX` (7 nights) are therefore removed from the sold side
**and** their room-nights from the available side. 7 covers 97% of bookings and 85%
of room-nights; the ten stays above it hold 143 room-nights.

Reassuringly, the weekday shape survives the correction almost unchanged (Sunday
77.3% → 75.0%, Friday 97.7% → 97.4%) — so the pattern is real, and now it is also
clean.

### Test bookings and abandoned checkouts

34 archive rows named `Test`, `Test2`… are rental-site development against the live
Beds24 account; left in, direct-channel cancellation reads above 80%. Filtered once
in `alloc`, counted in the coverage banner.

A cancellation within `ABANDONED_CANCEL_MINUTES` (120) is an incomplete Stripe
session, not a guest changing plans. Both Overview and Booking window count guest
cancellations only, on **both** sides of the ratio. Headline rate 12.9%, not 24.5%.

Beds24 saves an unpaid booking-page checkout (e.g. the first Google Hotel Ads
"booking", BH-95080626) already cancelled with **no** `cancelTime` and
`modifiedTime = bookingTime`. With no `cancelTime`, the class falls back to
`modifiedTime` — an upper bound on when the cancellation happened — so such a row
is abandoned, while one last modified weeks later stays a guest cancellation.

---

## 4. File map

```
utils/analyticsTypes.ts              client-safe response contract (types only)
data/analyticsConfig.ts              operator-tunable business facts  ← EDIT THIS
utils/variableCostsEngine.ts         cost engine, extracted from the route
utils/priceLabs.ts                   PriceLabs client — READ-ONLY, server only
lib/db/schema/marketSnapshots.ts     market_daily / market_monthly / market_horizon
data-access/analytics/
  shared.ts                          the CTE stack — read this first
  meta.ts                            coverage + freshness + caveats
  overview.ts                        stay-basis performance, units, forward book
  occupancy.ts                       compression, transient weekday, month × unit
  bookingWindow.ts                   lead time, booking curve, cancellations
  rates.ts                           Rates reads (nights, bookings, capacity, turnover) → engine
  costs.ts                           commission, operating cost, unit economics
  market.ts                          MPI + market series (reads the snapshot)
  marketRefresh.ts                   the only caller of PriceLabs
  marketTypes.ts                     server-only import seam for the client
  webFunnel.ts                       Web funnel reader (Postgres only)
  webFunnelSync.ts                   rental-site Redis → Postgres copy, GA4 → Postgres
utils/webFunnel.ts                   Redis contract, parsing, funnel maths (client-safe)
utils/ratesAnalysis.ts               Rates engine: GP by plan/promo/channel, resale, per class (pure, tested)
utils/rateDescription.ts             Beds24 rateDescription → plan, promotion, Genius, cancelled value
utils/ga4.ts                         GA4 Data API client — READ-ONLY, server only
lib/db/schema/webFunnel.ts           web_funnel_daily / web_funnel_searches / web_traffic_daily
app/api/analytics/
  scope.ts                           shared auth + query validation
  {meta,overview,occupancy,booking-window,rates,costs,market}/route.ts
  market/refresh/route.ts            POST/GET — cron or admin/super
  web-funnel/route.ts                admin only
app/api/cron/web-funnel-sync         nightly copy of the site's counts (cron or admin)
app/api/cron/ga-traffic-sync         nightly GA4 pull (cron or admin; 503 until configured)
app/analytics/page.tsx               server component, role gate
components/analytics/
  kit.tsx                            formatters, Card/Tile/Table/heatmap
  AnalyticsPage.tsx                  shell, lazy sections, market fetch
  FilterBar.tsx                      period / room / channel
  {Overview,Occupancy,BookingWindow,Rates,Costs,WebFunnel}Section.tsx
```

---

## 5. The market benchmark

### What comes from where

Our side **always** comes from `bookings_mirror`. The market side **always** comes
from the PriceLabs snapshot. MPI is computed here from those two — never taken from
PriceLabs' own `mpi` field.

That is not fussiness. PriceLabs syncs at the sellable-listing level and does not
attribute Beds24's physical-room bookings back up, so its view of *our* occupancy
reads **0.0%** for both multi-unit virtual rooms. Its market data, by contrast,
checked out: for K.201, where we compare 1:1, its inferred trailing-90-day
occupancy was **86.7% against our archive's 86.7%**.

### The snapshot, and why it is a cron

`refreshMarketSnapshot()` pulls `listing_metrics`, `neighborhood_data` and
`listing_prices` per listing and flattens them into three small tables (~2 300 rows
total). The raw neighborhood payload is ~540 KB per listing; storing the extracted
series instead is the point. Every write is an upsert on a natural key, so
re-running is always safe.

Runs at 06:30 daily (`vercel.json`), or from the **Refresh market** button, which
only appears for `admin`/`super` because the call bills per synced listing. A
missing, failed or stale snapshot degrades the response — market fields go null and
the charts drop their reference lines — rather than failing the page.

### PriceLabs is never written to

`utils/priceLabs.ts` exposes reads only. `update_listing_data`,
`update_listing_date_overrides`, `delete_listing_date_overrides` and
`refresh_listing_pricing` are deliberately absent: PriceLabs is the property's live
pricing engine, and a reporting app should not be able to move rates.

### The blind spot, stated everywhere it appears

The comp set is scraped from **Airbnb and VRBO**. Booking.com — 83% of our nights —
is not in it.

- **Occupancy survives this.** A channel manager blocks the Airbnb calendar
  whichever channel books, which is why their inference reproduced our
  Booking.com-dominated K.201 figure exactly.
- **Price percentiles do not.** Those are Airbnb-*listed* prices carrying roughly a
  3% host fee where our Booking.com-facing rate absorbs about 17%, and
  Booking.com-only Brno listings are invisible. Position and change detector; never
  a target.

### Comp-set sizes are not uniform — and O.308 is misconfigured upstream

1-bedroom pool 283 listings, K.201's 2-bedroom pool 48, **O.308's only 17**. The UI
flags any set under 25.

**O.308 is registered in PriceLabs as a 1-bedroom listing despite having two
bedrooms.** Analytics works around it by reading the 2-bedroom category out of the
payload (which carries every category), so the benchmark here is right — but
PriceLabs' own *recommendation* for O.308 is still drawn from 1BR comps. Worth
fixing in the PriceLabs UI.

---

## 6. What the data says right now

All-time to date (2026-01-01 → 2026-08-18), all rooms, all channels.

| | |
|---|---|
| RevPAR | 2 213 Kč |
| Occupancy | 88.6% (781 / 881 nights) |
| ADR | 2 497 Kč |
| Net RevPAR | 1 868 Kč |
| GBV | 1 949 987 Kč · 280 bookings |
| Distribution take rate | 15.6% |
| Guest score | 9.71 / 10 (132 reviews) |
| MPI, next 30 days | 1.77× |

### The headline: there is almost no spare capacity

**123 of 194 nights (63%) sold out**, with a longest unbroken run of 15 nights.
Sold-out rate by unit: O.308 90%, K.201 86%, Urban 80%, Deluxe 77%. A sold-out
night could not have sold more at any price, so its rate never had to ration
demand.

By weekday (transient basis): Friday and Saturday sold out **89%** of the time,
Sunday only 29%.

| Day | Occupancy | ADR | Sold out | ADR sold-out | ADR with spare | Gap |
|---|---|---|---|---|---|---|
| Mon | 82.5% | 2 304 | 43% | 2 391 | 2 225 | +7% |
| Tue | 86.0% | 2 317 | 57% | 2 363 | 2 230 | +6% |
| Wed | 85.0% | 2 286 | 63% | 2 260 | 2 344 | −4% |
| Thu | 88.1% | 2 585 | 74% | 2 507 | 2 818 | **−11%** |
| Fri | 97.4% | 2 972 | 89% | 2 930 | 3 591 (3n) | — |
| Sat | 97.3% | 2 948 | 89% | 2 993 | 2 289 (3n) | — |
| Sun | 75.0% | 2 372 | 29% | 2 392 | 2 361 | +1% |

Thursday is the sturdiest inversion: the Thursdays that sold out earned **11% less**
than the Thursdays with rooms to spare. Friday and Saturday leave only three spare
nights each, so their gaps are withheld rather than presented as findings.

### The far-out premium is not being paid

The engine is configured so a stay booked ~90 days out costs about **+15%** more
than one booked ~21 days out. Achieved: **−12%**.

| Booked | Nights | ADR | vs 15–30d | Cancels | Risk-adjusted ADR |
|---|---|---|---|---|---|
| Same day | 57 | 2 251 | −16% | 6% | 2 122 |
| 1–3 days | 186 | 2 318 | −14% | 2% | 2 262 |
| 4–7 days | 89 | 2 275 | −16% | 7% | 2 116 |
| **8–14 days** | 114 | **2 780** | +3% | 3% | **2 698** |
| 15–30 days | 86 | 2 692 | — | 21% | 2 125 |
| 31–60 days | 199 | 2 528 | −6% | 23% | 1 950 |
| **61–90 days** | 41 | 2 375 | −12% | **47%** | **1 250** |
| 90+ days | 9 | 4 362 | +62% | 0% | 4 362 |

Two mechanisms: Booking.com's **Early Booker Deal** discounts exactly the far-out
bookings the engine is trying to charge more for, and the 61–90-day bucket cancels
**47%** of the time, so half of what does sell never arrives. Risk-adjusted, a
far-out night is worth about **half** a near-in one.

### Rate composition: 74% of nights arrive on a discount

| Promotion | Nights | Share | ADR | vs avg | Lead | Cancels |
|---|---|---|---|---|---|---|
| Early Booker Deal | 199 | 25.5% | 2 809 | +13% | 46 d | 28% |
| Last Minute Deal | 200 | 25.6% | 2 348 | −6% | 3 d | 2% |
| Mobile app rate | 121 | 15.5% | 2 636 | +6% | 9 d | 10% |
| Super Last Minute | 35 | 4.5% | 2 175 | −13% | 3 d | 5% |
| No promotion (Booking.com) | 66 | 8.5% | 2 308 | −8% | 11 d | 17% |

**Last-minute discounting is landing on the nights that sell out anyway** — Friday
and Saturday clear 89% of the time. Discounting a night that was going to sell is
the most expensive promotion there is.

Rate plans: Non-refundable 52.9% of nights and cancels **1.2%**; Standard 13.7% at
a higher ADR but cancels **41%**; Weekly rate 7.8% at −19% ADR and cancels 33%.

Genius covers **89%** of Booking.com nights, so it is effectively the standard rate.
The Genius/non-Genius ADR gap (−24%) is reported as a **mix** difference, not the
price of the programme — the two groups differ in plan, lead time and dates too.

### Forward position: we win late, cede early

| Horizon | Ours | Market | MPI |
|---|---|---|---|
| 7 d | 89.8% | 49.4% | **1.82** |
| 30 d | 72.4% | 40.9% | **1.77** |
| 60 d | 40.5% | 30.8% | 1.31 |
| 90 d | 27.8% | 24.9% | 1.11 |
| 180 d | 14.3% | 15.6% | 0.92 |
| 360 d | 7.1% | 9.5% | 0.76 |

**Correction to an earlier claim.** "The market books three times further ahead
than we do" compared our *median* (6 d) to their *mean* (15.3 d). Mean to mean we
are level — ours is 16.2 d. The real asymmetry is the shape: our book is far more
last-minute-heavy. Given the cancellation table above, that is not obviously the
weaker position.

### Other standing findings

- **91% of cancelled room-nights get re-sold** (135 of 149).
- Sunday is both the weakest night and the departure peak (64 check-outs) — the
  cleaning crunch and the soft night are the same day.
- **K.201 earns 1.44× portfolio RevPAR, O.308 1.16×**, Urban 0.89×, Deluxe 0.87×.
- One-night stays spend 831 Kč of 2 306 Kč net on turnover → 1 475 Kč/night against
  2 108 Kč for three-night.
- **Direct-Web contributes 2 019 Kč/night after all costs, Booking.com 1 774 Kč.**
- Commission cross-check reconciles within a few percent per channel-month.
- Brno 2BR supply is up 42–62% year on year — the comp set is growing faster than
  demand.

---

## 7. Deliberately not built

- **Nightly on-the-books snapshot table.** The booking curve is reconstructed from
  `reservation_date` + Beds24 `cancelTime` (present on 105 of 107 cancellations;
  the rest fall back to the booking time if abandoned, else `modifiedTime`),
  which is exact for cancellations and approximate for *modifications* — a modified
  booking replays in its final shape. A snapshot table would close that gap; not
  needed until the curve drives money.
- **`rate_shop_history`.** Superseded: `market_daily` now stores recommended, live
  and market percentile prices per night, which is better data and no scraping.
- **Event calendar from PriceLabs.** `DEMAND_EVENTS` is still hand-curated. Their
  Events Pickup and Historical Event Performance templates would replace it.
- **Materialised `nights`.** The CTE expands ~1 900 rows and queries return in
  300–500 ms. At roughly 100k nights, promote to a matview on a cron; no query
  changes.
- **Non-arrivals.** Excluded from revenue here; the Performance tab includes their
  retained value. Stated in the coverage banner rather than silently reconciled.

---

## 8. Tuning checklist

Everything below is a one-line edit in `data/analyticsConfig.ts`:

| Knob | What it does |
|---|---|
| `SELLABLE_UNITS` | which physical rooms make up each sold product, and its PriceLabs listing |
| `TRANSIENT_LOS_MAX` | the stay length above which a booking stops being transient demand |
| `CONFIGURED_FAR_OUT_PREMIUM` | the premium PriceLabs is set to charge, so the Rates tab can test it |
| `ROOM_ONLINE_OVERRIDES` | fix a room whose real listing date precedes its first booking |
| `DEMAND_EVENTS` | the Brno event calendar the occupancy view measures |
| `TEST_BOOKING_NAME_REGEX` | which guest names count as development noise |
| `ABANDONED_CANCEL_MINUTES` | the abandoned-vs-guest cancellation boundary |
| `EXPECTED_COMMISSION_RATES` | drift alerts on the Costs tab |
| `TURNOVER_COST_KEYS` | which costs are per-checkout rather than per-night |
| `PACE_MONTHS_AHEAD` | forward-book horizon |

`CONFIGURED_FAR_OUT_PREMIUM` is the one that goes stale silently — update it
whenever the PriceLabs far-out settings change, or the comparison drifts without
saying so.

## 9. Operational notes

- `PRICELABS_API_KEY` must be set in Vercel for the market tables to refresh. Without
  it the refresh route returns 503 and every own-side figure still works.
- The cron is `GET /api/analytics/market/refresh` at 06:30 — before the 07:00
  `platform-prices` job, so the two do not overlap.
- Three migrations add the market tables: `0009`, `0010`, `0011`. All additive; no
  existing table is touched.

---

## 10. Web funnel (admin only)

**Question:** of the people who searched bakerhouseapartments.cz, how many got as far
as Stripe and how many booked — and which stays did we turn away?

### Three sources, never mixed

| Source | What it is | Used for |
|---|---|---|
| The site's own counts | anonymous, cookie-free beacon per funnel step → rental-site Redis → `web_funnel_*` | every funnel volume, conversion and the demand view |
| `bookings_mirror` | Direct-Web reservations by `reservation_date`, test names and cancellations out | the last step ("Booked") and revenue |
| GA4 Data API | sessions / users / purchases per day × channel × source/medium → `web_traffic_daily` | traffic sources ONLY |

**Why not GA for the funnel?** Since the cookie banner (2026-10-26) GA only sees
visitors who press Accept and don't block Google, so its funnel is a sample. The
site's beacon carries no cookie, no localStorage, no visitor/session ID, no IP and no
user agent, so it needs no consent and sees everyone. The price: **no visitor ID, so
every rate is per search or step, not per person** — a guest who tries three date
ranges is three searches. Accepted by Patrik. GA also keeps event data for only two
months, another reason the counts live in Postgres.

### The pipeline

1. Rental site (`src/lib/analytics.ts`) → `navigator.sendBeacon('/api/funnel', …)` on
   `view_item_list`, `no_availability`, `select_item`, `begin_checkout`,
   `add_payment_info`, `purchase` (booking-success, confirmed view) and
   `generate_lead` (corporate form). Separate from `window.bhTrack`, which stays
   consent-gated.
2. `/api/funnel` (rental site) whitelists the payload, drops crawler UAs and cross-site
   posts, rate-limits site-wide (600/min, 20 000/day — per-visitor limits would need an
   ID), de-dupes confirmation-page reloads by a sha256 of the Stripe session id (7 d),
   and writes:
   - `bh:funnel:d:{day}` HASH — counters (`{event}`, `{event}|lang=cs`,
     `{event}|room=679714`, `{event}|combo`, `select_item|method=user`,
     `{event}|value`, `_accepted`, `_dropped|bot|invalid|rate|cap|dupe`)
   - `bh:funnel:s:{day}` LIST — one record per search: arrival, departure, adults,
     children, offers shown, offered room ids, page language. No time of day. Capped
     at 3 000/day, append-only, so a record's position is a stable key.
   - Keys expire after 180 days. `astro dev` writes `bh:funnel:dev:*` instead.
3. `/api/cron/web-funnel-sync` (01:15 UTC nightly) reads those keys with a
   **read-only** token and upserts `web_funnel_daily (day, metric)` and
   `web_funnel_searches (day, seq)`. Default window: last 3 days through today, so a
   missed night heals itself. Backfill: `?from=YYYY-MM-DD&to=YYYY-MM-DD` (≤ 180 days).
   An expired Redis day deletes nothing: Postgres is the archive.
4. `/api/cron/ga-traffic-sync` (01:30 UTC) pulls the 4 days up to yesterday (GA keeps
   revising ~48 h) into `web_traffic_daily`. Backfill from `2026-03-28` (GA's first
   day) with `?from=2026-03-28&to=…`. Answers **503** until the key is set.

Both crons export GET, are exempted in `proxy.ts`, gate on `utils/cronAuth`, write a
heartbeat and are in `WATCHED_CRON_JOBS`. "Not configured" is recorded as a completed
no-op, so the watchdog stays quiet until the env vars exist. The tab's **Copy now**
button runs both for an admin and includes today so far.

### Reading the tab

- **Searches** = `view_item_list + no_availability`; **Saw offers** = `view_item_list`.
- **Chose an offer** counts every card picked (switching cards adds one each), so it
  can exceed "Saw offers" on a day.
- **Confirmed page** is the site's view of a finished payment; **Booked (archive)** is
  the truth. A gap means guests closed the tab before the success page.
- **Dates guests wanted** groups searches by requested arrival. "Nothing available" =
  no bookable offer at all — sold out, minimum stay, or a party over 4 (no single
  booking on the site fits more).
- Basis is the **event date**. Room and channel filters do not apply.
- **GA table = consent-only sample.** Users are summed per day. The footnote compares
  GA purchases with archive bookings so the sample's coverage is visible.

### Setup (Patrik, once)

**a) Database.** `npm run db:migrate` applies `0021` (three new tables, nothing else
touched). Do this before the push, or the cron and the tab fail on missing tables.

**b) Rental-site Redis, read-only** (Vercel → baker-house-reporting → Settings →
Environment Variables, Production):
1. console.upstash.com → Redis → the **rental site's** database (the one whose
   endpoint matches the rental-site project's `UPSTASH_REDIS_REST_URL` — NOT this
   app's own) → *REST API* section.
2. Copy the REST URL → `RENTAL_SITE_REDIS_REST_URL`.
3. Switch the token view to **Read-Only Token**, copy it →
   `RENTAL_SITE_REDIS_REST_TOKEN`. Never the read/write token.
4. Redeploy. Optional `FUNNEL_KEY_PREFIX` exists only for testing
   (`bh:funnel:dev`); leave it unset in production.

**c) GA4 service account** (the repo is public — the key lives only in Vercel):
1. console.cloud.google.com → project picker (top bar) → pick the project that holds
   the "Reporting Sign In" OAuth client (or create a new one).
2. *APIs & Services → Library* → search **Google Analytics Data API** → **Enable**.
3. *IAM & Admin → Service Accounts* → **+ Create service account** → name
   `bha-reporting-ga4` → **Create and continue** → skip the role step → **Done**.
4. Open it → **Keys** tab → **Add key → Create new key → JSON → Create**. A `.json`
   file downloads; keep it out of every repo and chat.
5. Copy the account's e-mail (`bha-reporting-ga4@<project>.iam.gserviceaccount.com`).
6. analytics.google.com (patriknovak229@gmail.com) → **Admin** (gear, bottom left) →
   property **529936917** → **Property access management** → **+ → Add users** →
   paste the e-mail → untick "Notify new users by email" → role **Viewer** → **Add**.
7. Vercel → baker-house-reporting → Settings → Environment Variables → add
   `GA4_SERVICE_ACCOUNT_JSON` = the whole file contents (raw JSON or base64), mark it
   **Sensitive**, Production → Save → redeploy.
8. Check: Analytics → Web funnel → **Copy now** should report "GA4: n rows". Backfill
   while signed in as admin: open
   `/api/cron/ga-traffic-sync?from=2026-03-28&to=<yesterday>` in the browser.

**Done 2026-10-26** — the account lives in the `baker-house-reporting` Cloud project,
which sits in the `bakerhouseapartments.cz` organisation. That organisation enforces
`iam.disableServiceAccountKeyCreation` (Google's secure-by-default), so step 4 failed
with "Service account key creation is disabled". What worked, as info@:
1. Organisation → IAM → pencil on info@ → add role **Organization Policy
   Administrator** (Organization Administrator alone cannot change policies).
2. Project `baker-house-reporting` → IAM & Admin → Organization Policies →
   `iam.disableServiceAccountKeyCreation` (NOT the `iam.managed.…` one) → Manage
   policy → Override parent's policy → rule Off → Set policy → create the key.
3. Same policy → Inherit parent's policy → Set policy. The policy only blocks
   creating keys; the existing key keeps working.
Rotating the key later means repeating 2–3. Leave "Service account key exposure
response" on — it disables a key that leaks publicly.

---

## 11. Rates — plans, deals, cancellations, direct (in gross profit)

Rebuilt 2026-10-27. Four questions, each answered in **gross profit**, per room
**class** — 1KK studios (Urban K.102/K.103/K.106 + Deluxe K.202/K.203) and 2KK
apartments (K.201, O.308) — because the two have different prices, seasons and
guests and a blended plan or channel comparison mostly measures which class each
one sold in. The tab opens on a 1KK | 2KK | both table; every card below follows
a class switch (default 1KK).

**Gross profit** on this tab = gross − OTA commission − payment fees − the stay's
**turnover** cost (cleaning + laundry + consumables, logged at checkout, spread
over its nights). Subscriptions and wear & tear are the same whichever rate sold
the night, so they stay on the Costs tab. Stays with no logged checkout (future,
legacy, unlogged — 29 of 448 on 2026-10-27) use their unit's average turnover:
Urban 823 Kč, Deluxe 866 Kč, K.201 1 351 Kč, O.308 1 367 Kč per checkout.

### How it is computed

- **Rows, not SQL aggregates.** `data-access/analytics/rates.ts` reads the
  `nights` CTE, every `alloc` row (whole archive, live and cancelled), the
  `available` capacity and the turnover cells, and hands them to the pure engine
  `utils/ratesAnalysis.ts` (unit-tested). It still uses the one definition of a
  night in `shared.ts`.
- **Plan and promotion** come from the first line of Beds24's `rateDescription`
  (`utils/rateDescription.ts`). A line with only a rate id (`65571709 rewritten
  from Early Booker Deal`) gets its plan from other bookings that name that id.
  Airbnb cancellation policies map onto the same ladder (non_refundable →
  Non-refundable, moderate/flexible → Flexible, firm/strict → Standard).
  **Time-limited** = Booking.com Limited Time Deals + operator-named seasonal
  campaigns ("August Deal", "Sezonni nabidka"); each campaign is listed with the
  dates it was booked.
- **Same-night comparisons are the numbers to believe.** Nights of the same
  sellable unit on the same date sold two ways; the **median** gap over matched
  cells (one mispriced booking cannot move it). Floors: 10 matched cells from at
  least 5 distinct bookings, else "n/a". K.201 and O.308 are single rooms, so two
  bookings never share a night — there the cells widen to the same unit, ISO week
  and night type (Fri/Sat vs rest), marked "wk".
- **Resale** is judged per sellable unit and date (Beds24 reshuffles studios),
  capacity-aware: a cancelled night counts as resold only if the unit ran out of
  rooms that night, and it is matched to the earliest booking made after the
  cancellation. Future cancelled nights are "still ahead", not unsold.
- **A cancelled booking's value** is read back from the description (Beds24
  zeroes `price`): the MEAN of the per-night `CZK x` lines (Beds24 truncates long
  stays, so sum ÷ nights would understate), or Airbnb's whole-stay Base Price ÷
  nights — divided by the group size, because Airbnb repeats a two-room group's
  total on every room. Direct cancellations carry no price.
- **GP per booked night** = (GP of the nights that stayed + GP of the replacement
  bookings that resold its cancelled nights) ÷ (stayed + cancelled nights). The
  fair way to compare a cheap plan that sticks with a dearer one that cancels.
- **Rest of class full** (date strength) = how full the class's OTHER rooms ended
  on the nights a promotion sold. A deal that lands on nights the class filled
  anyway gave its discount away.
- **Direct break-even** = 1 − (1 − Booking.com take) ÷ (1 − direct take);
  verdict from the same-night NET gap: < −3 % too cheap, ±3 % break-even
  (the saving all goes to the guest), > +3 % keeping margin.

### What it said on 2026-10-27 (all time to 26 Oct)

| | 1KK | 2KK |
|---|---|---|
| ADR / GP per night | 2 273 / 1 607 Kč | 3 552 / 2 504 Kč |
| Non-refundable share | 51 % | 66 % |
| Guest cancellations | 14 % | 10 % |
| Cancelled nights resold | 79 % of 266, at 95 % of the rate | 78 % of 37, at 99 % |

1. **Plans (1KK, Booking.com).** On the same nights Standard sells **+14 %**
   above Non-refundable (+20 % GP) and Flexible **+20 %** (+29 % GP). Standard
   cancels 36 %, Flexible 43 %, but ~85 % of those nights are resold, so after
   cancellations they keep 87–88 % of their GP: **GP per booked night 1 609 Kč
   Standard, 1 796 Kč Flexible, 1 424 Kč Non-refundable**. The non-refundable
   discount (~14–20 %) is larger than the cancellation risk it removes (~12–13 %).
   Caveat stated on the card: this does not prove NR guests would book Standard at
   full price. 2KK has too few shared weeks to compare plans directly.
2. **Time-limited deals.** 1KK: 56 nights (5.9 %), GP 1 513 vs 1 607 Kč/night,
   and they land on nights the rest of the class ended **93 % full vs 91 %** on an
   average night — discounting nights that were filling anyway. 2KK: 24 nights on
   nights 83 % full vs 92 % — those do hit softer dates. Costliest standing
   promotion: 1KK Super Last Minute (−18 % GP same night), 2KK Last Minute Deal
   (−22 % price, −25 % GP same week).
3. **Cancellations.** Weekly (126 nights) and Standard (73) lose the most; resale
   keeps 95–99 % of the price but only ~72–76 % of the GP (a fifth of the nights
   never resell). Flexible resells at only 82 % of its rate.
4. **Direct (1KK).** Direct-Web sells **15 % below** Booking.com on the same
   nights against a 17.5 % break-even, so it nets **+5 %** — we keep about a
   quarter of the commission saving and hand three quarters to the guest. 2KK has
   too few shared nights to say. **BH-92586229** (Direct-Web, K.103, 27 Sep–3 Oct,
   6 nights at 8 123 Kč/night, no Stripe payment linked) inflates Direct-Web's
   average ADR; the median comparison is immune, but the booking is worth a look.


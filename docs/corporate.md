# Corporate section

Tab **Corporate** (between Transactions and Performance), admin only
(`TAB_ACCESS.corporate` in `utils/roles.ts` — widen to `super` there when the
operators should run it). Manages *corporate agreements*: a company's standing
request for repeated stays, paid on invoice, usually at a negotiated price.

> "1KK Urban or 1KK Deluxe, Monday and Tuesday nights, every week from Monday
> 12 Oct to 17 Dec, same guest each time (name may differ)."

The agreement is **ours** (Postgres). Every stay it produces is a **normal
Beds24 booking** created by this app — channel Direct-Phone, tagged with a
`[CORPORATE:<agreement id>]` comment marker — so Transactions, cleaning,
performance and the bookings archive all see it like any other direct booking,
plus a 🏢 Corporate badge.

---

## 1. The model

| Term | Meaning |
|---|---|
| **Agreement** | Company + billing details, company contact, default guest, suitable room **types** (+ preferred), the night pattern, pricing mode, invoicing rhythm, notes. Fixed once saved except contacts/billing/notes/status. |
| **Stay** | One occurrence of the pattern: `arrival → departure`, nights, chosen room type, optional own guest, agreed price, status, Beds24 booking id. |
| **Pattern** | *Nights of the week* the guest sleeps here + first/last night. **Consecutive chosen nights merge into one stay**: Mon + Tue nights = one Mon → Wed booking; Sat + Sun + Mon = one Sat → Tue booking across the week boundary; all seven nights = one continuous stay. `endDate` is the **last night**, inclusive. |
| **Pricing** | `flat` — nightly rate × nights (discount ignored). `dynamic` — the real Beds24 web offer for those dates − discount %. Either can be overridden per stay while planned (source `manual`). Whole CZK. |
| **Stay status** | `planned` → `created` (BH number) / `failed` (Beds24 reason, retryable) · `skipped` (operator excluded) · `cancelled` (cancelled in Beds24 via the app). |
| **Agreement status** | `draft` (nothing in Beds24) → `active` (≥1 created) → `completed` / `cancelled` (manual; cancelling the agreement does **not** cancel bookings). |

Pure logic lives in `utils/corporateSchedule.ts` (generator + pricing) and
`utils/corporateShared.ts` (types, marker, summary) — both tested, both safe to
import from the client. The server regenerates the schedule from the pattern
and matches the client's rows by `seq`, so the UI can choose and price a stay
but never invent one.

## 2. Creating an agreement (wizard, `components/corporate/NewAgreementModal.tsx`)

1. **Form** — live line "N stays · M nights · first … · last …".
2. **Preview** — one row per stay: dates, nights, room type (planner's pick,
   editable — the agreed types first, every other sellable type under "Other
   types"), **availability**, optional guest, price (flat computed; dynamic
   fetched from `POST /api/corporate/quote`, sequential Beds24 offers, ≤ 60
   stays), include/exclude. Totals: reservations, nights, price per
   reservation, **average rate per night** (over priced stays), total.
   **Download offer PDF** produces the company-facing quote from the rows as
   they stand, before anything is saved.

   Availability (`utils/corporateAvailability.ts`, tested) asks the Stay
   Request planner one type at a time, in preference order, and a plan only
   counts if it keeps the guest in ONE unit (the planner otherwise answers with
   a split itinerary even at `maxRoomChanges 0`). A type that is free without
   moving anyone always beats one that needs a shuffle. Verdicts:
   *Free · K.102* / *Needs shuffle · K.203 (1 move)* + "Free without moves: …" /
   *Blocked in agreed types* + **"Vacancy: K.201 2KK (K.201) · O.308 2BR (O.308)"**
   (or "Vacancy after a shuffle: …", or "No apartment is free for these dates") /
   *In the past*. Blocked stays are also listed in a notice above the table so
   the operator can switch the row to a type with vacancy or untick it.
3. **Save & create** → `POST /api/corporate/agreements` then
   `POST …/[id]/create-bookings` → per-stay result (BH number or refusal).
   "Save as draft only" skips Beds24.

Availability in the preview is advisory. The real guard is Beds24's own
`checkAvailability` action on each booking: a stay with no availability is
**refused** (→ `failed`, with the reason) instead of saved as an overbooking.
A stay Beds24 accepts but cannot fit into one unit lands unallocated and the
existing room-assignment panel resolves it.

## 3. The Beds24 booking (`utils/corporateBooking.ts`)

Posted on the **sellable** room id (VR for the studio types, physical for K.201
/ O.308) — exactly what the manual New Booking "Sellable" path does, so Beds24
allocates the unit. Per booking: `status confirmed`, guests, `company`,
`country`/`lang` from the agreement's nationality, `referer PhoneDirect`,
`comments` = phone marker + corporate marker + "Corporate stay 3/10 · Company"
+ agreement notes, `notes` (internal) = agreement id, IČO, invoicing rhythm,
billing email, company contact, `flagText Corporate` (indigo flag in the Beds24
calendar), `price` + one Accommodation invoice item, `actions.checkAvailability`.
Guest fallback: stay's own → agreement default → `"<Company> TBA"`.
Sent in array POSTs of 25; the reply is matched by position, and a count
mismatch marks the chunk **unverified** (never "failed") so a retry cannot
duplicate.

## 4. Managing stays (`components/corporate/AgreementDetail.tsx`)

| Action | Endpoint | Rule |
|---|---|---|
| Edit guest (name/phone/email) | `PATCH /api/corporate/stays/[id]` | Any time. On a created stay the effective guest is pushed to Beds24 first (master + sub-bookings via `includeBookingGroup`); saved only if Beds24 accepted. |
| Change price / room type | same | Only while planned/failed — once created, edit in Beds24 (same rule as shorten-stay). Any sellable type is allowed, not only the agreed ones. |
| Skip / unskip | same (`status`) | Only before anything exists in Beds24. |
| Create / Retry | `POST …/[id]/create-bookings { stayIds }` | Needs price > 0. |
| Cancel a created stay | `POST /api/corporate/stays/[id]/cancel` | Sets `cancelled` on the whole booking group; nights go back on sale. Telegram. |
| Edit contacts / billing / notes / status | `PATCH /api/corporate/agreements/[id]` | Default-guest changes do **not** touch existing bookings. |
| Delete | `DELETE /api/corporate/agreements/[id]` | Only while no stay was ever created. |
| Offer PDF | `POST /api/corporate/offer-pdf` | Stateless: renders `utils/corporateOfferHtml.ts` (bilingual CZ/EN, invoice branding) via `generatePDF`; listed in `CHROMIUM_ROUTES`. Number `OFF-<yyyymmdd>-<agreement suffix>`, valid 14 days by default. Shows period, nights pattern, apartment types, stays, total nights, **rate per night** (flat rate, or the average with the discount note), guests, invoicing rhythm, the stay table and the total. The detail header also shows the average rate per night. |

Every create run and every cancel posts one Telegram summary to the ops group.
After a create/cancel the UI fires `GET /api/bookings?fullSync=true` so
Transactions shows the change without waiting out the sync guard.

## 5. Storage

`corporate_agreements` + `corporate_stays` (`lib/db/schema/corporate.ts`,
migration `0016_complex_inertia`), Postgres-only — no Redis, no `STORE_*` flag.
Money is `numeric` (string in Drizzle; converted in `data-access/corporate.ts`).
`(agreement_id, seq)` is unique; stays are never renumbered.

## 6. Not built yet (phase 2)

- **Automatic invoicing** per the stored `billingCadence` (per stay before
  arrival / monthly / up front). The data is there; the sender is not.
- Extending or re-patterning an existing agreement (today: new agreement).
- A Corporate filter chip in Transactions (badge only for now).
- Availability hints in the agreement DETAIL for failed stays (the preview has
  them; the detail would need to load `/api/bookings`).
- Opening the tab to `super`.

## 7. Verifying live

Local dev has no `BEDS24_REFRESH_TOKEN`: the wizard, preview and the draft
path work; availability reads "unknown" (no reservations), dynamic pricing and
booking creation only work on Vercel. The offer PDF also fails locally with
"Attempted to use detached Frame" — the desktop Chrome in
`CHROME_EXECUTABLE_PATH` rejects the serverless Chromium flags; every PDF
route behaves the same locally and works on Vercel.
`POST …/create-bookings { dryRun: true }` returns the exact payload without
sending it. First live run: one short agreement (2–3 stays), check the Beds24
calendar shows the bookings with the indigo Corporate flag and the right price,
then check Transactions shows the 🏢 badge.

# Baker House Apartments — Property Knowledge Base

_Single source of truth for the AI guest-messaging assistant (it writes to guests as "Zuzana")._

**Last updated:** _TODO (date)_

---

## How to use this document (for the editor — not sent to guests)

- When a guest messages, the assistant drafts a reply grounded **only** on the facts in this file + that booking's own details. It never invents anything that isn't written here.
- **Write facts, not guest-speak.** Short bullets are perfect — the assistant turns them into warm, natural replies and **translates into the guest's language automatically**. You can write in English or Czech.
- **Convention:** plain bullets = facts the assistant can use. Lines that look like
  > **Fill in —** _a question_

  are gaps for you. Answer them inline (replace the line) or delete the ones that don't apply. The more you fill, the more the assistant handles on its own; anything left blank just makes it say _"let me check and get back to you."_
- **The system already supplies these per booking — don't put them here:** guest name, apartment, dates, the exact assigned **parking space number**, and the room's exact **WiFi name/password**.
- Keep it current — this file is the assistant's entire world.

---

## 1. Property overview

- **Baker House Apartments (BHA)** — high-standard serviced apartments for short stays in **Brno, Czech Republic**.
- BHA sits inside **Pekárenský dvůr**, a brand-new, **gated** residential complex of 4 buildings, designed by professional architects with lots of greenery and on-site facilities. (Complex site: https://www.pekarenskydvur.cz/cs/default)
- **On-site facilities** in the complex:
  - **Relaxation zone** — opposite Karlův dům; turn left after exiting the building, entry by universal key/chip:
    - **Gym (free):** small, basic equipment; free for guests with their key/chip; open **6:00–22:00**, no reservation; lockers, showers, WC.
    - **Sauna:** max 4 people; **400 CZK**; reservation required (min 2 hours), request **≥24 h in advance**.
    - **Massages:** by appointment — **+420 724 211 210**.
    - **Yoga lessons:** **+420 605 951 606**.
  - **Café & bakery:** right next to reception — coffee, soft drinks, cakes, sandwiches and similar. Commercial (open to anyone, paid).
  - **Children's playground:** small, in the courtyard; free for anyone.
  - **Meeting room:** free to reserve at reception — conference table, work desk with computer, kitchenette.
  - **Commercial gym:** a separate, better-equipped gym also exists. _TODO: confirm how guest access works._
- Almost all BHA apartments are in one building, **Karlův dům** — deliberately chosen as the best-suited building and kept on dedicated floors, so guests aren't mixed in among long-term residents. **One** apartment is in the neighbouring **Ottův dům**.
- BHA occupies **two floors of Karlův dům**:
  - **Floor 1 — Urban (1KK):** 3 apartments, each with a **private terrace**. Spacious, high-standard, fully equipped, and right next door to one another — ideal for corporate travel or larger groups travelling together.
  - **Floor 2 — Deluxe:** larger and a step up in standard from the Urban units — 2× 1KK and 1× 2KK. Like the Urban units, all three are **right next to each other**, so a group or family can take the whole floor together.
- Plus one **2KK apartment in Ottův dům**.
- The **2KK apartments are family-friendly (children welcome).**
- **Buildings:** Karlův dům and Ottův dům are ~**20–30 m apart (about a 10-second walk)**, both inside the same gated complex.
- **Reception:** open **24/7**, near the **main entrance** of the complex. Guests simply **ring the doorbell**; reception lets them in and hands over the keys.
- **Address (for GPS / taxi):** **Bratislavská 946/82, 602 00 Brno** (Brno-sever) — the complex and the garage are at this address. Map pin: https://maps.app.goo.gl/9JywehHDff4exfWq8

## 2. Apartments — quick reference

**7 apartments total.** The assistant uses this to answer "what's in my apartment" correctly per room.

**Deluxe vs Urban:** the **Urban** apartments (ground floor) are 1KK (one main room + kitchenette), each with a large **private terrace** — spacious, high-standard, side-by-side (great for groups/corporate). The **Deluxe** apartments (2nd floor) are larger and a step up in standard — 1KK or 2KK, each with a balcony.

| Apartment | Building | Type | Floor | Sleeps | Bed setup | Outdoor | Minibar | Children | Notes |
|-----------|----------|------|-------|--------|-----------|---------|---------|----------|-------|
| K.102 | Karlův dům | Urban · 1KK | Ground | 2 | 1 king bed | Terrace ~20 m² | No | No | 3 Urban units side-by-side; sold as one room type on Booking.com |
| K.103 | Karlův dům | Urban · 1KK | Ground | 2 | 1 king bed | Terrace ~20 m² | No | No | 3 Urban units side-by-side |
| K.106 | Karlův dům | Urban · 1KK | Ground | 2 | 1 king bed | Terrace ~20 m² | No | No | 3 Urban units side-by-side |
| K.202 | Karlův dům | Deluxe · 1KK | 2nd | 2 | 1 king bed | Balcony ~6 m² | Yes | No | Twin pair with K.203 |
| K.203 | Karlův dům | Deluxe · 1KK | 2nd | 2 | 1 king bed | Balcony ~6 m² | Yes | No | Twin pair with K.202 |
| K.201 | Karlův dům | Deluxe · 2KK | 2nd | Up to 4 | 2 king beds (one in the living room) + sofa bed | Balcony ~8 m² | Yes | Yes | 65 m², the flagship (to be promoted as "Executive"); could fit 6 but kept premium at 4 |
| O.308 | Ottův dům | 2KK · high-standard | 3rd | Up to 4 | 1 king bed + sofa bed | Balcony ~8 m² (very good view) | Yes | Yes | Smaller 2KK; only BHA unit outside Karlův dům; minibar items are in the **kitchen fridge** (no separate minibar fridge) |

**Property-wide:**
- **No air-conditioning** in any apartment — it isn't permitted in the complex. (An alternative is being explored, but the assistant must **not** promise it to guests.)
- **Children** are welcome only in the **2KK** apartments (K.201, O.308). The 1KK Urban and Deluxe units are for **2 adults** (no children).
- **Beds are king-size** throughout.
- Urban **terraces** sit ~**120 cm above** the courtyard with **greenery** between the terrace and the walkway — so they feel private, not at passer-by level.
- **Sizes:** Urban ~**40 m²**, Deluxe 1KK ~**45 m²**, Deluxe 2KK (K.201) **65 m²** _(O.308 size — confirm)_.
- Urban units are on the **ground floor**, so expect a little more **hallway foot traffic** past the door (the raised, greenery-screened terraces keep the outdoor space private).

## 3. Getting here & directions

- **Address for GPS / taxi:** Bratislavská 946/82, 602 00 Brno. Map pin: https://maps.app.goo.gl/9JywehHDff4exfWq8
- **By car:** navigate to Bratislavská 946/82; for the underground garage and how to get in, see §6 Parking.
- **Finding it:** it's inside the gated **Pekárenský dvůr** complex — go to reception near the main entrance and ring the doorbell (see §1).
- **From Brno main station (Brno hl. n.) by tram:** take **tram 2** (direction **Stará osada**) or **tram 7** (direction **Lesná**), ride **3 stops to Tkalcovská**, then ~**3 min walk** to Bratislavská 82.
- **From Brno–Tuřany airport:** ~**20 min drive** — easiest is a taxi / Bolt / Uber / Liftago, or the regulated-rate airport taxi.
- **From Vienna, Prague or Bratislava airports:** take a **train** (most efficient) or a bus to **Brno hl. n.**, then trams **2 / 7** as above.
> **Fill in (optional) —** rough journey times from Vienna / Prague / Bratislava if you'd like the assistant to quote them.

## 4. Arrival & check-in

- **Check-in: from 15:00.** Keys (including the garage/door chip) are collected at the **24/7 reception** — ring the doorbell.
- **Early check-in:** sometimes possible from **12:00** *if* the apartment is ready — **never guaranteed**, confirmed on the day depending on cleaning. The assistant never promises a specific earlier time.
- **Late / after-hours arrival:** no problem — reception is staffed **24/7**, guests can arrive at any hour.
- **ID / registration:** none needed.
- **Luggage:** guests can store luggage at reception **if space is available** (room is limited) — just ask reception. Works both before check-in and after check-out.
- **Getting to the apartment:** keys-and-go — guests make their own way from reception. The courtyard is small and all buildings are visible from reception and **clearly named**, so guests simply head to **Karlův dům** or **Ottův dům** per their apartment.

## 5. Departure & check-out

- **Check-out: by 10:30.**
- **Late check-out:** may be possible depending on the next arrival and cleaning — decided on the day, never a specific time promised.
- **Luggage after check-out:** as at arrival — guests can leave bags at reception **if space allows** (limited room); just ask reception.
- **Check-out process:** simply **leave the keys at reception**. The garage gate opens automatically on the way out (no chip needed to exit).
> **Fill in (optional) —** anything you'd like guests to do before leaving (close windows, start the dishwasher, take out trash if bins are full → §9)?

## 6. Parking

- Underground garage at **Bratislavská 82**; spaces are on the lower sub-level, close to the elevators up to the apartments.
- **Each apartment has exactly ONE assigned space.** No second/extra space — politely decline a second car.
- **Collect keys from reception first**, before entering the garage — the keys include the chip/fob that opens the garage door (1–2 min; you can stop briefly in front of reception while collecting them).
- **The correct entrance is NOT the first gate** next to the main entrance (that's a service/emergency door) — it's the next gate along, ~**20 m from the reception door**.
- **Leaving is automatic** — the door opens on its own, no chip needed; drop keys at reception and drive out.
- **Height limit: 200 cm.** Taller vehicles can't enter.
- **No EV charging** in the garage.
- **Only during the stay:** no parking before check-in; car must be out by check-out (10:30) on departure day; we can't hold the space later. No separate parking outside the stay dates.
> **Fill in —** if guests need a taller vehicle / extra car / EV charging, is there a **nearby alternative** (public garage, paid lot) you'd point them to?

## 7. WiFi & connectivity

- Every apartment has its own network. Pattern: network **`Apartment_<RoomCode>`**, password **`Bakerhouse@<RoomCode>`** (e.g. `Apartment_K102` / `Bakerhouse@K102`). The system gives the exact room's credentials per booking.
- Multi-room bookings (e.g. K.202 + K.203 Twin Apartments) have a separate network per room.
> **Fill in —** anything else: is there a guide in the apartment? What should a guest do if the WiFi isn't working?

## 8. Inside the apartment — amenities & how things work

Standard fit-out below is from the Deluxe home guide (K.202/K.203); the Urban and 2KK units are similarly equipped to a high standard — see the per-apartment guides in **Appendix A** for exact, room-specific detail. Cross-cutting exceptions (minibar, AC) are flagged.

- **Kitchen — fully equipped (Bosch, mostly Series 6):** dishwasher (tablets provided), oven & hob, fridge, **microwave** (hidden in an upper cabinet that opens upward), **coffee machine**, kettle, toaster, **tea & coffee capsules** provided, cookware & dishes. Bar counter with 2 stools. Built-in power outlet with **USB-A, USB-C and 240 V**.
- **Bathroom:** **towels** provided (under the sink), **hair dryer**, **shampoo, conditioner & shower gel** provided, spare toilet paper + basic hygiene supplies, **illuminated mirror** (touch control, warm/cool light), **heated towel rail** (manual thermostat).
- **Laundry:** in-apartment **washer–dryer combo**; **detergent**, cleaning supplies and an **iron** provided; pull-out drying rack in the wardrobe.
- **Beds:** **king-size 180×200 cm** with premium 7-zone mattresses.
- **Storage:** lockable wardrobe with hangers, luggage rack, shoe rack & wall hooks, **vacuum cleaner** in the wardrobe.
- **Climate — no air-conditioning** (not permitted in the complex; an alternative is being explored but must not be promised). **Heating:** radiator with a manual thermostat (by the balcony door).
- **TV & internet:** **Samsung 4K TV** on **high-speed wired internet**; streaming apps installed (**Netflix** — guest uses their own login); live TV via the **"Sledování TV"** app. WiFi per room (see §7).
- **Minibar:** Deluxe units (K.201/202/203) + O.308 only — complimentary; Urban units have none (see §2).
- **Blinds (how they work):** automatic — **hold** the up/down arrow for full movement, **short press** to tilt the angle.
- **Children's beds:** no cots at the moment; the family units (K.201, O.308) have **folding children's beds in the wardrobe**.
- **Bath vs shower:** **bathtub with hand shower** in K.102, K.106, K.201, K.202, K.203; **walk-in corner shower** in K.103 and O.308.
- **Elevator & access:** a lift runs from the **garage** (a few metres from the parking spots, behind a clearly-labelled door) up to the apartments; building entrances are clearly signed and intuitive to find.
- **Safe:** no in-room safe.

## 9. Services during the stay

- **Cleaning / linen (longer stays):** for reservations **longer than 7 days** we offer **mid-stay cleaning + resupply**. The **host reaches out proactively** to arrange it — the guest doesn't need to do anything.
- **Trash:** guests can simply **leave rubbish in the apartment** and the cleaner handles it. **If the bins are full**, take it to the **trash area — about a 1-minute walk** from the building, towards **Cejl street**.
- **Maintenance / something broken:** message us via the booking platform — we reply within ~1 h (see §14).
> **Fill in —** **Extra requests** (e.g. extra towels) — what can / can't you accommodate, and how should guests ask? (Baby cot / high chair is tracked in §8.)

## 10. House rules

- **Smoking:** apartments are **strictly non-smoking** — no smoking inside, and **no open flames at all** (candles etc. prohibited). Smoking is allowed **only on the balcony/terrace**, where an ashtray is provided.
- **Pets:** **not allowed** — no pets at all.
- **Quiet hours:** **22:00–06:00** (night quiet, per local regulation).
- **Parties / events:** not allowed — the apartments aren't suited for parties or events.
- **Visitors:** **day visitors are generally fine.** **Overnight guests who aren't on the booking must be pre-agreed with us** — especially for larger units like K.201 (can fit 5–6 but is sold for 4). Guests are expected to reach out to us first.
> **Fill in —** anything else you tell every guest (shoes, building etiquette).

## 11. Payments, invoices & taxes

- **Invoices:** handled by a dedicated flow — the assistant collects **company name, IČO, and email**, and the invoice is sent after check-out.
- **How guests pay (by booking channel):**
  - **Booking.com** — payment handled by Booking.com.
  - **Airbnb** — payment handled by Airbnb.
  - **Direct website** — paid in full at the time of booking.
  - **Google Hotels / Beds24 booking page** — paid in full at the time of booking.
  - **Phone / direct with the host** — the host sends a payment link and confirms once it's paid.
- **No extra charges** expected at the moment. **Refunds and any payment issues are handled by the host** — the assistant should not commit, just pass them to the host.
- **City / tourist tax:** not charged separately at the moment.
- **Vouchers / discounts:** the assistant must **not proactively offer discounts** (and never on the OTA platforms). For context: the host sends a thank-you voucher to guests who leave a good rating, and guests who'd like to **return and book directly** are welcome to reach out to the host about a discount.

## 12. Local area & recommendations

_From the in-room welcome sheet:_
- **Eat:** **U Badinů** — quick & casual; **Kohout na víně** — something more special.
- **Groceries:** **Brněnka / Albert Express** (closest, for a few things); **Albert** (big shop).
- **Pharmacy:** **Dr. Max Lékárna** — nearest, ~5 min walk.
- **Worth seeing:** **náměstí Svobody** (main square) ~10 min; **Vila Tugendhat** (UNESCO) ~15 min; tram **Tkalcovská** 3 min.
- A curated **"our picks" map** is shared via a QR code on the welcome sheet.
- **Tram tickets:** buy from the **ticket vending machine right by the tram stop** (on Cejl, by Tkalcovská). A **basic ticket is 20 CZK**.
> **Fill in (optional) —** nearest **ATM**, and any other go-to spots worth recommending.

## 13. Safety & emergencies

- **Emergency numbers (Czech Republic):** **112** (general EU emergency), **155** ambulance, **150** fire, **158** police. All free, from any phone.
- **Pharmacy:** **Dr. Max Lékárna** — nearest, ~5 min walk.
- **Hospital:** there's a hospital within **walking distance** — but for anything medical or urgent, guests should **call emergency services (112)** rather than make their own way.
- **Lockout / lost key:** the guest should **contact the host** (booking chat / WhatsApp) — the host will call reception or sort it out. Reception's English is limited, so the host is the better first contact.
> **Fill in (optional) —** anything on **fire exits / building safety** worth telling guests.

## 14. Contact & escalation

- **Primary channel:** guests message via the **booking platform** (Booking.com / Airbnb chat) — typical response **within ~1 hour**.
- **WhatsApp:** the in-room welcome sheet invites guests to **WhatsApp +420 735 230 711** ("need anything? WhatsApp us anytime").
- **Languages:** written messages (WhatsApp / channel chat) — **all languages** (translation available, so the assistant always replies in the guest's language). Phone calls — **Czech, Slovak, English**, and **basic German**.

## 15. What the assistant must NOT do

- **No commitments on policy** — refunds, special late check-out times, exceptions, anything involving money or a firm promise → it gives a holding reply ("I'll check and get back to you") and **you** decide.
- **Never invent.** If the answer isn't in this document, it says it will check rather than guess.
- **Stay in character as Zuzana** — first person, never mentions an "operator," "team," or that anyone else is involved.
- **Exact per-booking values** (parking space number, WiFi password, dates) come from the system, never guessed.
> **Fill in —** any topics you ALWAYS want routed to you personally instead of auto-answered (e.g. complaints, refund requests, group bookings).

---

## Appendix A — In-apartment home guides

The printed guide placed in each apartment. The assistant should use the one matching the guest's **apartment type** for room-specific detail (appliance locations, how things work). The live per-booking WiFi credentials still come from the system; the WiFi line below is just the room's own.

### Deluxe 1KK — K.202 / K.203

**If you need assistance during your stay, please contact us via the booking platform. We respond within one hour.**

**Entrance**
- Shoe rack, wall hooks and built-in wardrobe with hangers
- Vacuum cleaner available in the wardrobe

**Bathroom**
- Illuminated mirror – touch control in the lower right corner (warm/cool light)
- Towels under the sink
- Drawer under sink: hair dryer, spare toilet paper, basic hygiene supplies
- Shampoo, conditioner and shower gel provided
- Washer-dryer combination
- Cabinet above washing machine: detergent, cleaning supplies, iron
- Heated towel rail with manual thermostat control

**Main room**
- Lockable wardrobe and luggage rack
- Pull-out drying rack inside wardrobe
- King-size bed (180×200 cm) with premium 7-zone mattresses
- Under-bed storage kept empty for comfort
- Blinds: automatic operation enabled; hold arrow up/down for full movement; short press adjusts angle
- Heating: radiator with manual thermostat (left of balcony door)

**Kitchen**
- Fully equipped Bosch appliances (mainly Series 6)
- Dishwasher tablets – cabinet left of oven
- Coffee machine, kettle, toaster
- Tea and coffee capsules in wooden box
- Hidden microwave – upper cabinet opens upward
- Bar counter with 2 stools
- Built-in power outlet: USB-A, USB-C, 240V
- Built-in minibar with chilled drinks

**TV & internet**
- Samsung TV with high-speed wired internet (4K supported)
- Streaming apps installed (Netflix app available; personal login required)
- Live TV via "Sledování TV" app
- Wi-Fi — Network: Apartment_K202 · Password: Bakerhouse@K202

**Relaxation zone** (opposite Karlův dům; turn left after exiting, entry by universal key/chip)
- Gym: free access; open 6:00–22:00; no reservation; lockers, showers and WC
- Sauna: max 4 persons; reservation required (min 2 hours); 400 CZK; request at least 24 h in advance
- Massages: +420 724 211 210 · Yoga lessons: +420 605 951 606

**Meeting room** — free reservation at reception; conference table, work desk with computer and kitchenette. Café available via reception.

### Deluxe 2KK — K.201

**Wi-Fi** — Network: Apartment_K201 · Password: Bakerhouse@K201

**Entrance** — Shoe rack, hooks, wardrobe with hangers; vacuum cleaner in wardrobe.

**Bathroom**
- Mirror: touch control (bottom right corner)
- Towels under the sink
- Drawer under sink: hair dryer, spare toilet paper, hygiene supplies
- Shampoo, conditioner, shower gel provided
- Washer-dryer in bathroom
- Cabinet above washer: detergent, iron, cleaning supplies
- Heated towel rail with thermostat

**Living room**
- Sofa bed
- King-size bed 180×200 cm
- Power outlet next to bed: USB-A, USB-C, 240V
- Dining table with 4 chairs
- Minibar under TV — free of charge

**Bedroom**
- King-size bed 180×200 cm
- Wardrobe
- Blind controller on wall next to door — hold ▲/▼ for full movement; short press adjusts angle; select zones via LED buttons
- Radiator with manual thermostat

**Kitchen**
- Fully equipped Bosch appliances
- Dishwasher tablets in cabinet
- Coffee machine, kettle, toaster
- Tea & coffee capsules in wooden box
- Built-in microwave

**TV & internet**
- Samsung 4K TV — wired internet
- Netflix (personal login required)
- Live TV via Sledování TV app

_(Relaxation zone, sauna, massages, yoga, meeting room & café — same as the Deluxe 1KK guide above.)_

### O.308 (2KK, Ottův dům)
One **king-size bed** plus a **sleeping sofa**; bookable for **up to 4 guests**. Same standard as K.201, with two known differences: a **walk-in corner shower** (not a bathtub), and the **minibar items are kept in the kitchen fridge** (no separate minibar).

**Bedding:** for **1–2 guests** only the main bed is made up; for **3–4 guests** the **sofa is also prepared, with two bedding sets**.
> **Fill in —** paste the O.308 home guide here if it differs further.

### Urban 1KK — K.102 / K.103 / K.106
_No separate in-room guide yet._ The Urban units are equipped to a similar high standard as the Deluxe apartments — use the general sections for them (especially §2 and §8). Known Urban specifics: **1KK, ~40 m², sleeps 2, one king bed, private ~20 m² terrace, ground floor, no minibar**; bathtub-with-hand-shower in K.102 & K.106, walk-in shower in K.103; WiFi follows `Apartment_<code>` / `Bakerhouse@<code>`.
> **Fill in (when available) —** paste an Urban home guide here if you create one.

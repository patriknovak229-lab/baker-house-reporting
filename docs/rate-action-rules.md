# Rate → Action rules (reference)

Maps the **rate a reservation was booked under** to the operational actions / perks
we provide for that stay.

> **Status: reference only — NOT wired into the app.** Nothing here is read by code.
> It's a manual lookup the operator keeps current. Automating it would first require
> reliably detecting the booked rate from Beds24 (see note at the bottom).

_Last updated: 2026-06-20_

| Rate type      | Action(s)                                  | Applies to                              | Status / notes                                   |
| -------------- | ------------------------------------------ | --------------------------------------- | ------------------------------------------------ |
| **Weekly rate** | Special treatment — **a bottle of wine**   | **All apartments**                      | Active                                            |
| **Flexi rate**  | **Early check-in** + **late checkout**     | **Deluxe 1KK only — K.202, K.203**      | Active — limited to these two units "for now"     |

## How to maintain

- One row per rate type.
- Keep **Applies to** explicit — apartment codes (e.g. `K.202, K.203`) or `All apartments`.
- Use **Status / notes** for rollout scope, conditions, or "for now" limitations.
- Update the _Last updated_ date when you change anything.

## Note on automation (intentionally not built)

The app **already detects** a per-reservation rate plan — `rateType` on `Reservation`
(`types/reservation.ts`), parsed in `utils/rateType.ts` and calibrated against live
OTA stays, shown as a Rate column + drawer control. So auto-creating these perks off
the effective rate type would be feasible.

It's deliberately left as **operator-maintained reference** for now — the perk actions
(bottle of wine, early check-in / late checkout) are handled manually rather than
auto-generated as tasks. Revisit this file if/when you want them wired to fire
automatically from the detected rate.

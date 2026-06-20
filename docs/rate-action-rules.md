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

## Note on automation (not built)

The booked rate plan is **not a clean field** in the Beds24 v2 API. The rate name
(e.g. non-refundable / standard / weekly / flexi) and its policy arrive as
channel-specific free text inside `apiMessage`, `rateDescription`, and/or `infoItems`,
which would need per-channel parsing before any rule above could be auto-applied.
There is an early `RateType` scaffold in the codebase (`types/reservation.ts` +
`isRateTypeInScope` in the reservation drawer), but per the current decision this
table stays **operator-maintained reference only** — it does not drive app behaviour.

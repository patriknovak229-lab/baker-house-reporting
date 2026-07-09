/**
 * Revenue knowledge base — appended to the OTA settlement-extraction prompt.
 *
 * HOW IT WORKS
 *   The text below is injected into the Claude extraction prompt
 *   (app/api/revenue-invoices/extract-settlement/route.ts). It teaches the model
 *   how to read each OTA's monthly earnings/settlement report and pull the
 *   gross / commission / net figures + the period the report COVERS.
 *
 * HOW TO ADD / EDIT AN OTA
 *   Copy a block below, fill in the source id, and list short, specific,
 *   actionable rules. Commit & push — it takes effect on the next deploy.
 *
 *     ## <OTA name>   (source: airbnb | booking | other)
 *     - <rule the model should follow for this report>
 *
 *   Keep it tight: only note the quirks the generic prompt gets wrong.
 */
export const REVENUE_KNOWLEDGE = `
## Airbnb   (source: airbnb)
- The document is titled "Earnings report" with the host's Airbnb logo. It covers ONE calendar month.
- periodStart / periodEnd: the date range printed in the large header, e.g. "May 1, 2026 – May 31, 2026" → periodStart 2026-05-01, periodEnd 2026-05-31. This is the ACCRUAL period — always prefer it over "Report generated" (that is just the print date, ignore it).
- The "Summary" table has ONE row (usually labelled "Earnings") with these columns, all in CZK ("Kč"):
    • Gross earnings   → grossAmount   (e.g. 30,262.40)
    • Adjustments      → adjustmentsAmount (e.g. 0.00)
    • Service fees     → commissionAmount — take the MAGNITUDE (drop the minus sign), e.g. "-Kč 5,675.80" → 5675.80
    • Tax withheld     → taxWithheld   (e.g. 0.00)
    • Total (CZK)      → netAmount     (e.g. 24,586.60) — this is the payout that reaches the bank
- Sanity check: grossAmount − commissionAmount (± adjustments/tax) = netAmount. Read the printed numbers; do not recompute.
- Numbers use a comma thousands separator and a dot decimal ("30,262.40" = 30262.40). Strip the "Kč" symbol and commas.
- IGNORE the per-"Homes" breakdown table, "Performance stats" (nights booked), "Earnings types", and "Payout methods" — they are not needed. Take only the top Summary row + the header period.
- source: airbnb. currency: CZK.

## Booking.com — Settlement report "Výkaz plateb"   (source: booking)
- Use the SETTLEMENT REPORT ("Výkaz plateb"), NOT the commission "FAKTURA". The report's totals reconcile to the bank payout; the invoice does not.
- It is a per-reservation table (columns: Číslo rezervace, Příjezd, Odjezd, Jméno hosta, Částka, Provize, Poplatek za platební služby, Čistá tržba) ending in a "Celkem (CZK)" totals row.
- Read the "Celkem (CZK)" totals row:
    • Částka (total)                  → grossAmount   (e.g. 412 621,63)
    • Provize + Poplatek za platební služby (both totals, as positive magnitudes) → commissionAmount = their sum (e.g. 66 107,00 + 6 169,02 = 72 276,02)
    • Čistá tržba / "Celková částka k vyplacení" → netAmount (e.g. 340 345,61) — this equals the bank payout
- Sanity: grossAmount − commissionAmount = netAmount.
- periodStart / periodEnd: the accrual MONTH = the calendar month in which the MAJORITY of "Odjezd" (departure) dates fall. Set periodStart to the 1st and periodEnd to the last day of that month (e.g. most departures in June → periodStart 2026-06-01, periodEnd 2026-06-30). CRITICAL: use "Odjezd" (departure), NOT "Příjezd" (arrival) — never take the earliest arrival date. The user can correct the month in review.
- Numbers use a space thousands separator and comma decimal ("412 621,63" = 412621.63). source: booking. currency: CZK.

## Booking.com — Commission invoice "FAKTURA"   (source: booking; AVOID — prefer the settlement report)
- If only the commission "FAKTURA" is available: grossAmount = "Prodej pokojů" (Rezervace row); commissionAmount = "K zaplacení celkem"; netAmount = grossAmount − commissionAmount; periodStart/End = "Období". Note its net will NOT match the bank exactly (accrual vs payout timing).
`;

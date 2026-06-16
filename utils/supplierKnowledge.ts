/**
 * Supplier knowledge base — appended to the invoice-extraction prompt.
 *
 * HOW IT WORKS
 *   The text below is injected into the Claude extraction prompt
 *   (app/api/supplier-invoices/extract/route.ts). When an invoice is from one of
 *   these suppliers, the model applies the supplier's notes on top of the generic
 *   rules. Suppliers not listed here are extracted normally.
 *
 * HOW TO ADD / EDIT A SUPPLIER
 *   Copy a block below, fill in the name (and IČO if known), and list short,
 *   specific, actionable rules. Commit & push — it takes effect on the next
 *   deploy. No other code changes needed.
 *
 *     ## <Supplier name>   (IČO: <number, optional>)
 *     - <rule the model should follow for this supplier>
 *     - category: <one of: cleaning | laundry | consumables | utilities | software | maintenance | other>
 *
 *   Keep it tight: only note the quirks that the generic prompt gets wrong.
 */
export const SUPPLIER_KNOWLEDGE = `
## Airbnb   (Airbnb Ireland UC)
- Monthly service-fee statement, not a single-item invoice.
- Extract each reservation row as a lineItem {description, amount}; set totalAmount to the SUM of the row fees. Do NOT use any pre-printed grand total (it may include VAT or unrelated charges).
- category: other

## Booking.com B.V.   (Dutch entity, DIČ/VAT NL805734958B01 — not a Czech IČO)
- Monthly COMMISSION invoice (titled "FAKTURA"). The only cost is Booking's fee — NOT the room revenue.
- totalAmount: use "K zaplacení celkem" (total to pay), e.g. 36 583,44. It equals commission ("Provize", e.g. 32 831,17) + payment-services fee ("Poplatek za platební služby", e.g. 3 752,27).
- CRITICAL: ignore "Prodej pokojů" (gross room sales, e.g. 247 035,94) — that is guest revenue Booking collected, never a cost. Do NOT use it as totalAmount.
- Do NOT treat this as a per-reservation fee statement and do NOT emit lineItems (unlike Airbnb) — it is a single cost figure.
- invoiceNumber: "Číslo faktury". invoiceDate: "Datum" (format DD/MM/YYYY). dueDate: "Platba splatná".
- Reverse-charge in NL — no Czech DPH, so vatAmount is null/0. Put DIČ NL805734958B01 in supplierICO.
- description: the billing period ("Období"), e.g. 01/05/2026–31/05/2026.
- category: distribution-fees

## Alza.cz a.s.   (IČO 27082440)
- totalAmount: the final amount payable including VAT ("Celkem k úhradě" / "Celkem s DPH").
- invoiceNumber: the document number ("Faktura č." / "Daňový doklad č.").
- category: consumables

## ACTION   (IČO 03439747)
- Household / consumables discount store. supplierICO must be digits only, no spaces (e.g. 03439747).
- category: consumables

## JYSK s.r.o.   (IČO 26760746)
- Home-furnishings retailer. category: equipment

## IKEA Česká republika, s.r.o.   (IČ 27081052, DIČ CZ27081052)
- Document is a "Daňový doklad k přijaté platbě" (pre-payment tax invoice).
- totalAmount: use "Cena celkem" (Total amount, VAT incl.), e.g. 8 429,00.
- CRITICAL: do NOT use "Celkem k úhradě" (total to be paid) — it is usually 0,00 because the order was prepaid by card. A 0 there does NOT mean a zero invoice. Also ignore "Uhrazeno předem" (amount prepaid).
- invoiceNumber: "Číslo faktury" (e.g. CZINV26000001062081) — NOT "Číslo objednávky" (order number).
- invoiceDate: "Datum vystavení". vatAmount: "DPH" (21%).
- supplierICO: the Dodavatel (Seller) IČ 27081052 — NOT the Odběratel (Buyer) IČ 19876106 (that is us).
- category: other

## RYWA s.r.o.   (IČO 07092644)
- category: services

## Věra Volecová   (IČO 21214620)
- Individual (OSVČ); the person's name is the supplierName. category: cleaning

## PriceLabs   (US entity — invoiced as "PriceLabs Revenue Inc." or "PriceLabs Inc")
- SaaS billed in US DOLLARS. invoiceCurrency: USD (never default to CZK). The amount field holds the original-currency number exactly as shown.
- totalAmount: the "Total amount" / "Total Paid" (e.g. 64.97). The amount varies month to month with the listing count — do NOT emit lineItems, just take the total.
- invoiceNumber: "Invoice number" (e.g. 2026-INV308238-2518231). invoiceDate: "Invoice date" (e.g. 21 May 2026).
- supplierICO: PriceLabs' US EIN, printed in the FOOTER ("PriceLabs Revenue Inc. Tax ID/EIN : 41 - 4535625" → normalise to 41-4535625). CRITICAL: do NOT use the "Tax / VAT / GST / Sales Tax ID" in the "Bill To" block — that is OUR (customer) Czech IČO (e.g. 19876106), never the supplier's.
- vatAmount: "Sales Tax" (usually 0). category: software.
- description: the "Invoice duration", e.g. 22 Apr 2026 – 21 May 2026.

## Google Cloud EMEA Limited   (Irish entity, VAT prefixed IE — not a Czech IČO)
- Cloud SaaS. category: software
`;

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
 *
 *   Supplier identity + category for the main recurring suppliers is ALSO
 *   enforced in code (utils/supplierRegistry.ts) — that wins over the category
 *   lines here.
 */
export const SUPPLIER_KNOWLEDGE = `
## Airbnb   (Airbnb Ireland UC)
- Monthly service-fee statement, not a single-item invoice: documentType "fee_statement".
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
- Header dates (the PDF text layer lists them out of order, so match each label to its own value): "Datum vystavení" = invoiceDate, "Datum uskut. zdaň. plnění" = duzpDate, "Datum splatnosti" = dueDate. Issue date and DUZP are normally the same day; the due date is the same day or later (e.g. vystavení 10.07.2026, DUZP 10.07.2026, splatnost 24.07.2026).
- RETURNS: Alza issues a separate credit note ("Opravný doklad", numbers start with 3 — invoices start with 4) for each returned item. documentType: "credit_note"; totalAmount and vatAmount = the credited amounts as positive numbers; invoiceNumber = the credit note's own number; originalInvoiceNumber = the number of the original Alza invoice it corrects.
- category: consumables

## Temu   (online marketplace; no supplier IČO on the document)
- The PDF is an ORDER SUMMARY ("Shrnutí objednávky" — Temu states it attaches no paper receipt), NOT a formal tax invoice. supplierName: "Temu". supplierICO: null — Temu prints no supplier IČO/DIČ, do not invent one.
- Usually 2 pages: page 1 has the totals + VAT; page 2 just continues the item list. Amounts are in CZK ("Kč").
- totalAmount: "Objednávka celkem" (order total, VAT incl.), e.g. 2 930. Use THIS, not "Položky celkem" (items subtotal — it differs once there is shipping or a discount).
- vatAmount: the number on the "Včetně DPH … Kč" line shown directly under "Objednávka celkem", e.g. 508,52. This VAT is ALREADY inside the total — do NOT add it to or subtract it from totalAmount.
- invoiceNumber: "ID objednávky" (e.g. PO-053-17846428519032587).
- invoiceDate: "Čas objednávky", written with a Czech abbreviated month (e.g. "24. dub 2026" = 2026-04-24; dub=April).
- Do NOT emit lineItems — take the single order total only.
- IGNORE the per-item "Prodává obchodník" / "Obchodní název" lines (e.g. Guangzhouruiyukeji Co., Ltd.) — those are individual third-party sellers and vary per item; never use them as supplierName/ICO. IGNORE "Fakturační adresa" (Truthseeker s.r.o. — that is us, the buyer).
- category: consumables

## Action Retail Czech s.r.o.   (IČO 03439747, verified in ARES)
- Household / consumables discount store; receipts/branding may show just "Action". supplierName: "Action Retail Czech s.r.o.". documentType: "receipt".
- supplierICO: ALWAYS 03439747 (digits only, no spaces). Purchases up to 10 000 CZK are issued as a simplified tax document (zjednodušený daňový doklad) that legally need not print the IČO — set 03439747 even when it is not shown on the receipt.
- Digital e-receipt (PDF from the Action app): store address, then a date WITHOUT a year, e.g. "Středa 19. srpna v 12:12" → invoiceDateHasYear false, invoiceWeekday "Wednesday", invoiceDate with your best-guess year (code fixes the year from the weekday).
- invoiceNumber: the "Číslo transakce" value (e.g. B08010210241953). It is ALWAYS present on the e-receipt — never return null. Do NOT use the long return barcode number under "Čárový kód pro výměnu nebo vrácení" (e.g. B08010226231121132999932).
- Paper till receipt (photo): it prints TWO numbers near the top — use the 15-character one on its own line directly under the date/time (e.g. B08010170793255, same format as "Číslo transakce"), NOT the dashed one at the top right (e.g. B080101-10793256). Never use the long barcode number above "Děkujeme".
- totalAmount: "Celkem" (e.g. 2 916,20). vatAmount: the "Celkem" row of "Přehled DPH" (e.g. 495,52). vatBreakdown: the 12 % and 21 % rows of "Přehled DPH" (columns DPH, Bez = base, Včetně = gross).
- category: consumables

## PEPCO Czech Republic s.r.o.   (IČO 24294420, DIČ CZ24294420)
- Till receipt; date printed with a 2-digit year ("Datum: 20.4.26" = 2026-04-20). invoiceNumber: "Ticket" (e.g. 156434).
- VAT table: the "Zdanitelná částka" column is the GROSS amount INCLUDING VAT (e.g. 765,00 with "částka daně" 132,77). In vatBreakdown put base = Zdanitelná částka − částka daně (e.g. 632,23), vat = částka daně.

## MAKRO Cash & Carry CR s.r.o.   (IČ 26450691, DIČ CZ26450691)
- Multi-page wholesale invoice ("FAKTURA - DAŇOVÝ DOKLAD"). Always use the FINAL grand total, never a per-page or pre-VAT subtotal.
- totalAmount: "Celková částka" (= "Platba kartou" = the card amount), VAT-inclusive, e.g. 11 061,73.
- CRITICAL: ignore the "... celkem bez DPH" lines (e.g. "Poslední strana celkem bez DPH 10 020,20") — those are VAT-EXCLUSIVE page subtotals, NOT the total. Do not add VAT to them yourself.
- Goods prices already include spotřební daň (excise); do not add excise on top.
- vatAmount: total "částka daně" (e.g. 1 909,93). invoiceNumber: "Faktura č. / VS". invoiceDate: "Datum vystavení".
- supplierICO: MAKRO's IČ 26450691 — NOT the Odběratel (buyer) IČ 19876106 (that is us).
- category: consumables

## JYSK s.r.o.   (IČO 26760746)
- Home-furnishings retailer. category: equipment

## Textilomanie s.r.o. – Vyprodejpovleceni.cz   (IČ 04788494, DIČ CZ04788494)
- Home-textiles / furnishings e-shop (ABRA Flexi invoice, "Faktura - daňový doklad"). Always PREPAID by card and stamped "ZAPLACENO - NEPLAŤTE", so the amount-to-pay ("k úhradě") nets to 0. CRITICAL: do NOT extract 0 as the total.
- The layout is messy: a line "Odpočet zálohy Z…" carries a NEGATIVE amount (e.g. -3 770,00) that cancels the goods — that is the prepayment already made, not a discount. The real cost is its magnitude.
- totalAmount: the invoice value INCL. VAT = goods + shipping = the magnitude of the "Odpočet zálohy" line (e.g. 3 770,00). Cross-check: equals the "Rekapitulace DPH" 21% row Základ + DPH (3 115,70 + 654,30 = 3 770,00), and the sum of the positive item rows' "Celkem s DPH".
- vatAmount: the DPH from the "Rekapitulace DPH" 21% row (e.g. 654,30). IGNORE the 0% row — that is the negative deposit offset (base -3 770,00, DPH 0).
- invoiceNumber: the "Faktura - daňový doklad" number (e.g. FV21091630/26). invoiceDate: "Datum vystavení" (e.g. 07.05.2026).
- supplierICO: Textilomanie's IČ 04788494 — NOT our buyer IČ 19876106.
- category: consumables

## IKEA Česká republika, s.r.o.   (IČ 27081052, DIČ CZ27081052)
- Document is a "Daňový doklad k přijaté platbě" (pre-payment tax invoice).
- totalAmount: use "Cena celkem" (Total amount, VAT incl.), e.g. 8 429,00.
- CRITICAL: do NOT use "Celkem k úhradě" (total to be paid) — it is usually 0,00 because the order was prepaid by card. A 0 there does NOT mean a zero invoice. Also ignore "Uhrazeno předem" (amount prepaid).
- invoiceNumber: "Číslo faktury" (e.g. CZINV26000001062081) — NOT "Číslo objednávky" (order number).
- invoiceDate: "Datum vystavení". vatAmount: "DPH" (21%).
- supplierICO: the Dodavatel (Seller) IČ 27081052 — NOT the Odběratel (Buyer) IČ 19876106 (that is us).
- category: equipment

## RYWA s.r.o.   (IČ 07092644, DIČ CZ07092644)
- Monthly internet + TV invoice ("FAKTURA - daňový doklad", Money S4 system). Recurring, same shape every month.
- READ the printed totals; do NOT sum the line items — their 4-decimal unit prices (e.g. 109,0900) don't re-sum cleanly and yield e.g. 3134.17 instead of the real 3 135,00.
- totalAmount: "Celková částka" (e.g. 3 135,00) = the VAT-recap "CELKEM".
- vatAmount: the VAT-recap "Výše DPH" (e.g. 544,11).
- invoiceNumber: the "FAKTURA - daňový doklad č." (e.g. FV2610292).
- supplierICO: RYWA's IČ 07092644 (not the buyer's).
- category: services

## Věra Volecová   (IČO 21214620)
- Individual (OSVČ); the person's name is the supplierName. category: cleaning

## PriceLabs Revenue Inc.   (US SaaS; some invoices say "PriceLabs Inc")
- SaaS billed in US DOLLARS. invoiceCurrency: USD (never default to CZK). The amount field holds the original-currency number exactly as shown.
- totalAmount: the "Total amount" / "Total Paid" (e.g. 64.97). The amount varies month to month with the listing count — do NOT emit lineItems, just take the total.
- invoiceNumber: "Invoice number" (e.g. 2026-INV308238-2518231). invoiceDate: "Invoice date" (e.g. 21 May 2026).
- supplierICO: PriceLabs' US EIN, printed in the FOOTER ("PriceLabs Revenue Inc. Tax ID/EIN : 41 - 4535625" → normalise to 41-4535625). CRITICAL: do NOT use the "Tax / VAT / GST / Sales Tax ID" in the "Bill To" block — that is OUR (customer) Czech IČO (e.g. 19876106), never the supplier's.
- vatAmount: "Sales Tax" (usually 0). category: software.
- description: the "Invoice duration", e.g. 22 Apr 2026 – 21 May 2026.

## Google Cloud EMEA Limited   (Irish entity, VAT prefixed IE — not a Czech IČO)
- Cloud SaaS. category: software

## Beds24 GmbH   (German channel-manager SaaS; VAT DE328454604 — not a Czech IČO)
- Our channel manager. The invoice tops up prepaid "Beds24 credit" and is billed in EUR. invoiceCurrency: EUR — never default to CZK; the amount holds the EUR number exactly as shown.
- totalAmount: the "Charge" value in the top "Invoice" table (gross, VAT incl.), e.g. 71.81 (or 43.62 on a smaller month). This is the amount actually paid and what hits the bank — it is THE field that matters.
- CRITICAL: do NOT use the "NN.NN EUR Beds24 credit" figure in the Description (e.g. 59.35) — that is the NET credit topped up, not the charge. Likewise do NOT use "Net Payment" (e.g. 59.35). These are net-of-VAT and lower than the real charge.
- vatAmount: the "Payment includes 21% VAT" line in the "Payment Completed" section, e.g. 12.46.
- invoiceNumber: "Invoice Number" (e.g. B2810172). invoiceDate: "Invoice Date" (e.g. Jul 1, 2026 → 2026-07-01).
- supplierICO: Beds24's German VAT DE328454604 (footer). CRITICAL: never use our buyer IČO 19876106 / the "To:" Truthseeker s.r.o. block.
- category: software
`;

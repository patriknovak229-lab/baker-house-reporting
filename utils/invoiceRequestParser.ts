/**
 * Heuristic parser for Booking.com "I need an invoice" auto-messages,
 * which always come in the guest's locale. We support Czech + Slovak —
 * by far the most common languages of guests requesting invoices.
 *
 * Example Czech message:
 *   "Dobrý den, žádám o zaslání faktury na mou e-mailovou adresu po odjezdu
 *    z ubytování. Děkuji. Název společnosti hosta je AZE Technologies.
 *    DIČ společnosti hosta je 26372321."
 *
 * Example Slovak message (same shape, different words):
 *   "Dobrý deň, žiadam o zaslanie faktúry... Názov spoločnosti hosťa je X.
 *    DIČ spoločnosti hosťa je SK12345678."
 *
 * Output is best-effort — when the parser can't pull out a field it returns
 * null and the operator can fill it manually during the Accept flow.
 */

export interface ParsedInvoiceRequest {
  companyName: string | null;
  ico: string | null;
  dic: string | null;
  email: string | null;
}

/**
 * Returns true when a message looks like an invoice request.
 * Liberal — better to surface a false positive (operator clicks Reject)
 * than to miss a real request.
 */
export function isInvoiceRequest(text: string): boolean {
  if (!text) return false;
  // "faktur" stems both Czech ("faktura") and Slovak ("faktúra")
  // Filter further by either action verb to reduce noise (e.g. "I'll send the
  // invoice tomorrow" from a host message wouldn't match — but host messages
  // never get parsed anyway).
  const lower = text.toLowerCase();
  if (!lower.includes("faktur") && !lower.includes("faktúr")) return false;
  // Common verbs paired with the noun on Booking.com auto-templates
  return (
    lower.includes("zaslání") ||
    lower.includes("zaslanie") ||
    lower.includes("zaslat") ||
    lower.includes("vystavení") ||
    lower.includes("vystavenie") ||
    lower.includes("žádám") ||
    lower.includes("žiadam") ||
    lower.includes("prosím o") ||
    lower.includes("prosím o ")
  );
}

/** Extract a Czech/Slovak company ID (IČO) — always 8 digits. */
function extractIco(text: string): string | null {
  // "IČO: 12345678", "IČO 12345678", "IČ 12345678" (Slovak), "IČO12345678"
  const m = text.match(/I[ČC]O?\s*[:\s]?\s*(\d{8})\b/i);
  return m ? m[1] : null;
}

/** Extract a Czech/Slovak tax ID (DIČ) — typically "CZ12345678" / "SK12345678" or just 8-12 digits. */
function extractDic(text: string): string | null {
  // Optional CZ/SK prefix, then 8–12 digits.
  const m = text.match(/DI[ČC]\s*(?:spole[čc]nosti(?:\s+hosta|\s+host[ae])?\s+je\s+)?(?:[:\s])?\s*((?:CZ|SK)?\s*\d{8,12})\b/i);
  if (!m) return null;
  return m[1].replace(/\s+/g, "").toUpperCase();
}

/**
 * Extract a company name. Booking.com's auto-message uses fairly
 * predictable phrasing:
 *   CZ: "Název společnosti hosta je <NAME>."
 *   SK: "Názov spoločnosti hosťa je <NAME>."
 * Falls back to a looser pattern if those exact phrases don't match.
 */
function extractCompanyName(text: string): string | null {
  const patterns = [
    // Czech
    /N[áa]zev\s+spole[čc]nosti(?:\s+hosta)?\s+je\s+([^\n.]+?)(?=\s*(?:\.|DI[ČC]|I[ČC]|$))/i,
    // Slovak
    /N[áa]zov\s+spolo[čc]nosti(?:\s+host[ae])?\s+je\s+([^\n.]+?)(?=\s*(?:\.|DI[ČC]|I[ČC]|$))/i,
    // Looser fallback — "společnost X" / "spoločnosť X"
    /spole[čc]nost(?:i)?\s+([A-Z][^\n.]{1,80}?)(?=\s*(?:\.|DI[ČC]|I[ČC]|$))/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) {
      return m[1]
        .replace(/\s+/g, " ")
        .replace(/[\s,.;:]+$/, "")
        .trim() || null;
    }
  }
  return null;
}

/**
 * Extract an email address — guests sometimes include a real address
 * for the invoice to be sent to (since Booking.com's email is a proxy).
 */
function extractEmail(text: string): string | null {
  const m = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return m ? m[0].toLowerCase() : null;
}

export function parseInvoiceRequest(text: string): ParsedInvoiceRequest {
  return {
    companyName: extractCompanyName(text),
    ico: extractIco(text),
    dic: extractDic(text),
    email: extractEmail(text),
  };
}

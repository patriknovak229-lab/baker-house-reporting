/**
 * Extract invoice fields from a free-form guest message via Claude Haiku.
 *
 * The existing `utils/invoiceRequestParser.ts` uses regex/keyword heuristics
 * tuned to Booking.com's auto-template in Czech/Slovak — reliable for that
 * specific shape but brittle for everything else. This LLM extractor handles
 * the messy real-world cases:
 *   - "Hi, please send the invoice to ABC s.r.o., our IČO is 12345678,
 *      email fakturace@abc.cz, thanks!"
 *   - "Naše firma se jmenuje XY Trade, sídlíme na Václavské náměstí 25,
 *      IČO máme 87654321"
 *   - Replies to the missing-fields ask: "IČO is 12345678" or just "12345678"
 *
 * Returns whatever fields can be extracted; nulls for the rest. Caller
 * merges with what's already known, preserving non-null prior values.
 */

import Anthropic from '@anthropic-ai/sdk';
import { missingInvoiceFields, type InvoiceMandatoryField } from '@/utils/invoiceUtils';

export interface ExtractedInvoiceFields {
  companyName: string | null;
  companyAddress: string | null;
  /** 8-digit Czech/Slovak company ID. */
  ico: string | null;
  /** Tax / VAT ID of any country, e.g. "CZ12345678", "PL5251985295", "DE366335248". */
  dic: string | null;
  email: string | null;
}

const EMPTY: ExtractedInvoiceFields = {
  companyName: null,
  companyAddress: null,
  ico: null,
  dic: null,
  email: null,
};

const SYSTEM_PROMPT = `You extract invoice-related billing details from a guest message at a hotel in Brno, Czech Republic.

Identify ONLY these fields if present:
- companyName       — the legal entity name (often ends with "s.r.o.", "a.s.", "Ltd", "GmbH", etc.). Strip any "[link removed]" artifacts.
- companyAddress    — physical billing address; null when only a single town name is given without a street.
- ico               — Czech/Slovak company ID, ALWAYS exactly 8 digits. Strip any prefix/suffix. Foreign companies do NOT have one — leave null rather than putting a VAT number here.
- dic               — Tax/VAT ID of ANY country, not just Czech. Czech "CZ…", Slovak "SK…", but equally "PL5251985295", "DE366335248", "ATU12345678", "GB123456789". Keep the country prefix and drop the spaces.
- email             — a real email address ending in @domain.tld. Ignore @stayforlong.com, @guest.booking.com, @guest.airbnb.com (those are channel-conduit aliases, not real).

Output ONLY a single JSON object on one line, no preamble:
{"companyName": "...", "companyAddress": "...", "ico": "...", "dic": "...", "email": "..."}

Use null (not empty string) for any field not clearly present in the message. Never guess — if uncertain, return null. Don't infer a company name from a personal name.`;

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return cachedClient;
}

/**
 * Extract invoice fields from the message. Returns all-nulls when the API key
 * is missing or the call fails — caller treats that as "nothing extracted"
 * rather than failing the whole flow.
 */
export async function extractInvoiceFields(
  guestMessage: string,
): Promise<ExtractedInvoiceFields> {
  if (!guestMessage.trim()) return { ...EMPTY };
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[invoiceFieldExtractor] ANTHROPIC_API_KEY not set — returning empty');
    return { ...EMPTY };
  }

  try {
    const client = getClient();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: guestMessage.slice(0, 3000) }],
    });

    const block = response.content[0];
    if (!block || block.type !== 'text') return { ...EMPTY };
    return parseJson(block.text);
  } catch (err) {
    console.error('[invoiceFieldExtractor] failed:', err instanceof Error ? err.message : err);
    return { ...EMPTY };
  }
}

/**
 * Merge newly extracted fields into an existing record, preserving any
 * non-null prior values. Used when a follow-up message adds details on
 * top of what was extracted from the original invoice request.
 */
export function mergeInvoiceFields(
  prior: ExtractedInvoiceFields,
  next: ExtractedInvoiceFields,
): ExtractedInvoiceFields {
  return {
    companyName: prior.companyName ?? next.companyName,
    companyAddress: prior.companyAddress ?? next.companyAddress,
    ico: prior.ico ?? next.ico,
    dic: prior.dic ?? next.dic,
    email: prior.email ?? next.email,
  };
}

/**
 * Mandatory fields per operator policy. Thin re-export of the shared rule in
 * `utils/invoiceUtils` — the drawer and the send cron apply the same one, so
 * the definition of "complete" can't drift between the pipeline and the UI.
 */
export function missingMandatoryFields(
  fields: ExtractedInvoiceFields,
): InvoiceMandatoryField[] {
  return missingInvoiceFields(fields);
}

function parseJson(raw: string): ExtractedInvoiceFields {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return { ...EMPTY };
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { ...EMPTY };
  }
  if (!parsed || typeof parsed !== 'object') return { ...EMPTY };
  const obj = parsed as Record<string, unknown>;
  return {
    companyName: cleanString(obj.companyName),
    companyAddress: cleanString(obj.companyAddress),
    ico: cleanIco(obj.ico),
    dic: cleanVat(obj.dic),
    email: cleanEmail(obj.email),
  };
}

function cleanString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\[link removed\]/gi, '').replace(/\s{2,}/g, ' ').trim();
  return s.length > 0 ? s : null;
}

function cleanIco(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  // ICO is exactly 8 digits — strip everything else, then verify length
  const digits = String(v).replace(/\D/g, '');
  return digits.length === 8 ? digits : null;
}

/**
 * Normalise a VAT / tax ID from any country: uppercase, drop the spaces and
 * dots guests type ("DE 366 335 248" → "DE366335248"). Kept permissive on the
 * country prefix — we bill companies from all over the EU and can't enumerate
 * every national format. Requires at least one letter-or-digit run of 6+ chars
 * so a stray word doesn't land in the field.
 */
function cleanVat(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).toUpperCase().replace(/[\s.\-/]/g, '').trim();
  if (!/^[A-Z]{0,3}[0-9A-Z]{6,15}$/.test(s)) return null;
  return s;
}

function cleanEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  // Reject channel-conduit aliases — LLM is told but we double-check
  if (/@(?:guest\.booking\.com|guest\.airbnb\.com|stayforlong\.com)$/i.test(s)) {
    return null;
  }
  return s;
}

/**
 * Exported guard so other modules (e.g. autoCompleteInvoiceRequest) can
 * apply the same OTA-conduit rejection when falling back to alternative
 * email sources like reservation.additionalEmail.
 */
export function sanitizeInvoiceEmail(v: unknown): string | null {
  return cleanEmail(v);
}

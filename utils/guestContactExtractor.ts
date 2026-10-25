/**
 * Pull the answers to our post-booking question (phone number, coming by car,
 * licence plate) out of a free-form guest chat reply. See utils/guestContact.
 *
 * Replies come in any language and shape: "+49 151 2345678, no car",
 * "Ja, Kennzeichen M-AB 123", "we'll come by train", "my husband drives,
 * BA-123XY; phone 0905 123 456". The model only fills what the guest clearly
 * stated; everything else stays null and the caller keeps asking (once).
 */

import Anthropic from '@anthropic-ai/sdk';

export interface ExtractedContact {
  /** The guest's own phone number, international format when it can be inferred. */
  phone: string | null;
  car: 'yes' | 'no' | null;
  plate: string | null;
  /** true when the message is nothing beyond these answers (+ greetings/thanks). */
  onlyContactInfo: boolean;
}

const EMPTY: ExtractedContact = { phone: null, car: null, plate: null, onlyContactInfo: false };

const MODEL = 'claude-opus-5-5';

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['phone', 'car', 'plate', 'onlyContactInfo'],
  properties: {
    phone: nullable({ type: 'string' }),
    car: nullable({ type: 'string', enum: ['yes', 'no'] }),
    plate: nullable({ type: 'string' }),
    onlyContactInfo: { type: 'boolean' },
  },
};

function buildPrompt(args: { message: string; askedPhone: boolean; guestCountry?: string }): string {
  const asked = args.askedPhone
    ? '(1) their phone number with country code, and (2) "Are you coming by car? (yes / no) If yes, your license plate…"'
    : '"Are you coming by car? (yes / no) If yes, your license plate…"';
  return `A guest of Baker House Apartments (Brno, Czech Republic) is replying in the booking chat. Right after booking we asked them: ${asked}

Extract their answers from the message below.

- phone: the guest's OWN contact number, only if they give one. Return it in international format with a leading "+" (e.g. "+49 151 2345678"). If they wrote a national number with a leading 0 and their country is known${args.guestCountry ? ` (booking country: ${args.guestCountry})` : ''}, replace the 0 with that country's calling code. Never return a booking number, PIN, price, date or a number they quote from us. null when absent.
- car: "yes" if they are coming by car. That includes asking for, requesting or asking about a parking space, the garage or where to park — a guest only asks about parking when they bring a car — as well as "my partner drives", a rental car, or giving a plate. "no" if they say they are not (train, plane, no car, walking, "we don't need parking"…). null when nothing in the message touches on a car or parking.
- plate: the licence plate(s) exactly as written; several cars → comma-separated. null when absent.
- onlyContactInfo: true when the message contains nothing beyond these answers, greetings and thanks. false when it also asks a question, makes a request or says anything else that needs a reply (check-in time, parking location, early arrival, a problem…).

Only fill what is clearly stated — never guess.

Guest message:
"""
${args.message.slice(0, 3000)}
"""`;
}

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!cachedClient) cachedClient = new Anthropic();
  return cachedClient;
}

/** All-null on a missing key, a refusal or any API/parse failure — the caller treats that as "nothing found". */
export async function extractGuestContact(args: {
  message: string;
  askedPhone: boolean;
  guestCountry?: string;
  client?: Anthropic;
}): Promise<ExtractedContact> {
  if (!args.message.trim()) return { ...EMPTY };
  if (!args.client && !process.env.ANTHROPIC_API_KEY) {
    console.warn('[guestContactExtractor] ANTHROPIC_API_KEY not set — skipping');
    return { ...EMPTY };
  }
  try {
    const client = args.client ?? getClient();
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      messages: [{ role: 'user', content: buildPrompt(args) }],
    };
    // Server-side refusal fallback (same as utils/invoiceExtraction); `fallbacks`
    // is newer than the installed SDK's types.
    const message = await client.beta.messages.create({ ...params, ...({ fallbacks: 'default' } as object) });
    if (message.stop_reason === 'refusal' || message.stop_reason === 'max_tokens') return { ...EMPTY };
    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return parseContact(text);
  } catch (err) {
    console.error('[guestContactExtractor] failed:', err instanceof Error ? err.message : err);
    return { ...EMPTY };
  }
}

/** Exported for tests. */
export function parseContact(raw: string): ExtractedContact {
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ...EMPTY };
  }
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const car = p.car === 'yes' || p.car === 'no' ? p.car : null;
  return {
    phone: str(p.phone),
    car,
    plate: str(p.plate),
    onlyContactInfo: p.onlyContactInfo === true,
  };
}

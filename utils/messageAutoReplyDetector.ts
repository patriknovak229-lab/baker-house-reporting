/**
 * Categorise a guest message into one of the recognised auto-reply
 * buckets via Claude Haiku. Returns the category, a confidence score,
 * and the detected language code so the downstream template path can
 * translate the reply.
 *
 * Why Haiku not regex: guest messages arrive in EN/CS/DE/FR/IT/PL/ES/RU
 * with infinitely-varied phrasing. A keyword approach either misses
 * legitimate intents ("Got parking?", "Můžu si vzít autíčko nahoru?")
 * or fires on coincidences ("the parking lot was full, we walked over").
 * Haiku handles multi-language without bloating regex tables and costs
 * ~$0.0001 per message — negligible.
 *
 * Conservative threshold: callers should only act when
 * `confidence >= 0.8`. Anything lower → fall through to "other" → no
 * auto-reply, operator handles as today.
 */

import Anthropic from '@anthropic-ai/sdk';

export type AutoReplyCategory =
  | 'parking'
  | 'wifi'
  | 'minibar'
  | 'early-checkin'
  | 'late-checkout'
  | 'invoice-request'
  | 'other';

export interface DetectionResult {
  category: AutoReplyCategory;
  /** 0-1 — Haiku's self-reported confidence. Caller compares against 0.8. */
  confidence: number;
  /** ISO 639-1 (en, cs, de, fr, it, pl, es, ru, ...). Empty when undetectable. */
  language: string;
}

const SYSTEM_PROMPT = `You categorise hotel guest messages for Baker House Apartments in Brno.

Pick ONE category that best matches the guest's INTENT:

- parking — asking about general parking (availability, location, garage access/entry, where to leave the car, basic parking instructions). Do NOT classify under parking if the guest asks about any of: EV charging, vehicle height/size limits, a second parking spot or two cars, or keeping the car parked outside of their stay — those compound/edge-case questions go to "other" so the operator handles them.
- wifi — asking for wifi password, network name, or how to connect.
- minibar — asking about the minibar (what's inside, prices, can they take items, restock).
- early-checkin — asking to check in EARLIER than the standard 15:00. Includes "we'll arrive at noon, can we go up?".
- late-checkout — asking to check out LATER than the standard 11:00. Includes "can we keep the room until X".
- invoice-request — asking for an invoice / fakturu / fakturovat / VAT receipt. Includes Booking.com's "I need an invoice" auto-template AND ad-hoc requests like "could you send me an invoice for company X, IČO Y". Also: messages that ONLY contain billing details ("our IČO is 12345678" or "Company name: ABC s.r.o.") — those are follow-ups to a prior invoice request and should be routed here too.
- other — anything else (greetings, complaints, restaurant tips, lost items, etc.). When the message asks about TWO categories at once (e.g. parking AND wifi), return "other" — the operator handles compound queries.

Output ONLY a single JSON object on one line, no preamble:
{"category": "<one of the above>", "confidence": <0.0-1.0>, "language": "<ISO 639-1>"}

Confidence guidance:
- 0.95+ when the message clearly and only asks about that category
- 0.80-0.94 when the intent is likely but not stated explicitly
- below 0.80 when uncertain — use this WITH "other" rather than guessing
- 1.0 for "other" when no category applies

Language: detect from the message text. Use empty string if undetectable.`;

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return cachedClient;
}

/**
 * Run categorisation on a single guest message. Returns category=other
 * with confidence=0 on any error (network, parse) so the caller defaults
 * to "no auto-reply" rather than mis-firing on a transient failure.
 */
export async function detectAutoReplyCategory(
  guestMessage: string,
): Promise<DetectionResult> {
  if (!guestMessage.trim()) {
    return { category: 'other', confidence: 1, language: '' };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[autoReplyDetector] ANTHROPIC_API_KEY not set — defaulting to other');
    return { category: 'other', confidence: 0, language: '' };
  }

  try {
    const client = getClient();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 100,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: guestMessage.slice(0, 2000) },
      ],
    });

    const block = response.content[0];
    if (!block || block.type !== 'text') {
      return { category: 'other', confidence: 0, language: '' };
    }

    const parsed = parseJsonBlock(block.text);
    if (!parsed) return { category: 'other', confidence: 0, language: '' };
    return parsed;
  } catch (err) {
    console.error('[autoReplyDetector] failed:', err instanceof Error ? err.message : err);
    return { category: 'other', confidence: 0, language: '' };
  }
}

/** Strict JSON parse — Haiku sometimes wraps the output in ```json fences. */
function parseJsonBlock(raw: string): DetectionResult | null {
  // Strip code fences if present
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  // Find the first { ... } block to be defensive against leading prose
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const category = normaliseCategory(obj.category);
  if (!category) return null;
  const confidence = Math.max(0, Math.min(1, Number(obj.confidence) || 0));
  const language = typeof obj.language === 'string' ? obj.language.trim().toLowerCase() : '';
  return { category, confidence, language };
}

function normaliseCategory(v: unknown): AutoReplyCategory | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  switch (s) {
    case 'parking':
    case 'wifi':
    case 'minibar':
    case 'early-checkin':
    case 'late-checkout':
    case 'invoice-request':
    case 'other':
      return s;
    default:
      return null;
  }
}

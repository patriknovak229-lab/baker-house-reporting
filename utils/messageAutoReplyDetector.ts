/**
 * Categorise a guest message into one of the recognised auto-reply
 * buckets via Claude Sonnet. Returns the category, a confidence score,
 * and the detected language code so the downstream template path can
 * translate the reply.
 *
 * Why an LLM not regex: guest messages arrive in EN/CS/DE/FR/IT/PL/ES/RU
 * with infinitely-varied phrasing. A keyword approach either misses
 * legitimate intents ("Got parking?", "Můžu si vzít autíčko nahoru?")
 * or fires on coincidences ("the parking lot was full, we walked over").
 *
 * Why Sonnet not Haiku: classification is the linchpin of the whole
 * pipeline, and some intents need multi-step reasoning over times — e.g.
 * "drop the car off at 9am, collect Sunday 4pm" is early+late parking,
 * which Haiku mis-classified. Sonnet handles it; at our volume the cost
 * is a few dollars a month — negligible.
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

/**
 * Sub-classification of a `parking` message so the template path can pick
 * the right reply. Only meaningful when category === 'parking'.
 *   general       — where/how to park, where their assigned space is
 *   ev            — EV charging question
 *   outside-hours — wants the car parked outside the stay window: before
 *                   check-in, after checkout, or both (all declined)
 *   taken         — someone else is in their assigned space
 *   multiple      — wants more than one space / a second car
 */
export type ParkingIntent =
  | 'general'
  | 'ev'
  | 'outside-hours'
  | 'taken'
  | 'multiple';

export interface DetectionResult {
  category: AutoReplyCategory;
  /** 0-1 — Haiku's self-reported confidence. Caller compares against 0.8. */
  confidence: number;
  /** ISO 639-1 (en, cs, de, fr, it, pl, es, ru, ...). Empty when undetectable. */
  language: string;
  /** Only set when category === 'parking' (defaults to 'general'); undefined
   *  for every other category. Lets the template path pick the right reply. */
  parkingIntent?: ParkingIntent;
}

const SYSTEM_PROMPT = `You categorise hotel guest messages for Baker House Apartments in Brno.

Pick ONE category that best matches the guest's INTENT:

- parking — the guest is asking about the car or the garage. When you choose this category you MUST also set "parkingIntent" to the closest match:
    - "general": where/how to park, getting into the garage, where their assigned space is, basic parking instructions.
    - "ev": charging an electric vehicle.
    - "outside-hours": wants the car in the garage OUTSIDE their stay window — dropping off or leaving the car BEFORE check-in, AND/OR keeping or collecting it AFTER checkout (e.g. "can we drop the car off before check-in around 9am and collect it after checkout on Sunday afternoon?"). This is about the TIMING of a single car, not the number of cars. A request mentioning BOTH an early drop-off and a late pick-up is still "outside-hours".
    - "taken": reports that someone else is parked in their assigned space.
    - "multiple": ONLY when the guest wants to park MORE THAN ONE car or needs a SECOND space. A single car dropped off early and/or collected late is "outside-hours", NOT "multiple".
  Vehicle HEIGHT or size-limit questions do NOT go here — classify those as "other" for the operator.
- wifi — asking for wifi password, network name, or how to connect.
- minibar — asking about the minibar (what's inside, prices, can they take items, restock).
- early-checkin — asking to access the APARTMENT earlier than the standard 15:00 ("we'll arrive at noon, can we go up?"). If the guest only asks about parking the CAR before check-in, that is parking with parkingIntent "outside-hours", not early-checkin.
- late-checkout — asking to stay in the APARTMENT later than the standard 10:30 ("can we keep the room until X"). If the guest only asks about keeping the CAR in the garage after checkout, that is parking with parkingIntent "outside-hours", not late-checkout.
- invoice-request — asking for an invoice / fakturu / fakturovat / VAT receipt. Includes Booking.com's "I need an invoice" auto-template AND ad-hoc requests like "could you send me an invoice for company X, IČO Y". Also: messages that ONLY contain billing details ("our IČO is 12345678" or "Company name: ABC s.r.o.") — those are follow-ups to a prior invoice request and should be routed here too.
- other — anything else (greetings, complaints, restaurant tips, lost items, etc.). When the message asks about TWO categories at once (e.g. parking AND wifi), return "other" — the operator handles compound queries.

Output ONLY a single JSON object on one line, no preamble:
{"category": "<one of the above>", "parkingIntent": "<general|ev|outside-hours|taken|multiple>", "confidence": <0.0-1.0>, "language": "<ISO 639-1>"}

Only include "parkingIntent" when category is "parking"; omit it for every other category.

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
      model: 'claude-sonnet-4-6',
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
  if (category === 'parking') {
    return { category, confidence, language, parkingIntent: normaliseParkingIntent(obj.parkingIntent) };
  }
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

/**
 * Map the model's parkingIntent to our enum. Defaults to 'general' so a
 * parking message without a usable sub-intent still gets the standard
 * space-assignment reply rather than silently failing.
 */
function normaliseParkingIntent(v: unknown): ParkingIntent {
  if (typeof v !== 'string') return 'general';
  switch (v.trim().toLowerCase()) {
    case 'ev':
      return 'ev';
    // Off-hours parking always declines the same way, so fold the model's
    // natural single-direction words and any compound phrasing into one
    // intent. Guards against the model emitting 'early'/'late'/'both' and
    // against a compound early+late request being mis-bucketed.
    case 'outside-hours':
    case 'outside_hours':
    case 'off-hours':
    case 'offhours':
    case 'early':
    case 'late':
    case 'early-late':
    case 'both':
      return 'outside-hours';
    case 'taken':
      return 'taken';
    case 'multiple':
      return 'multiple';
    case 'general':
    default:
      return 'general';
  }
}

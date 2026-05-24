/**
 * Generate an AI-drafted reply for a guest message that the auto-reply
 * pipeline did NOT auto-send. This runs for:
 *
 *   1. Follow-up messages on a category that's already been auto-replied
 *      to once for this booking (the per-booking per-category one-shot
 *      lock has fired) — the operator approves/edits before sending.
 *   2. Messages classified as `other` where the operator wants a starting
 *      draft instead of typing from scratch.
 *
 * The drafter is intentionally NOT used for first-touch auto-sends —
 * those use the deterministic fixed templates so the headline reply is
 * predictable.
 *
 * Why a separate module: keeps the LLM prompt + facts wiring in one
 * place, isolated from the categoriser and from the deterministic
 * template builder.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Reservation } from '@/types/reservation';
import type { AutoReplyCategory } from './messageAutoReplyDetector';
import { getFactsForCategory } from './autoReplyFacts';

export interface DraftInput {
  guestMessage: string;
  /** Category returned by the detector. `other` is allowed — facts will be empty. */
  category: AutoReplyCategory;
  /** ISO 639-1 language code from the detector, empty when undetectable. */
  language: string;
  /** Reservation context — used for guest name + room info in the draft. */
  reservation: Reservation;
}

export interface DraftResult {
  /** The drafted reply in the guest's language. Empty string on failure. */
  draftText: string;
  /** What model generated it — captured for the audit log. */
  model: string;
}

const MODEL = 'claude-haiku-4-5';

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return cachedClient;
}

/**
 * Compose a draft reply. Returns `{ draftText: '' }` on any failure so
 * the caller can fall back gracefully (queue the message with no draft
 * rather than break the polling loop).
 */
export async function draftAutoReply(input: DraftInput): Promise<DraftResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[autoReplyDrafter] ANTHROPIC_API_KEY not set — returning empty draft');
    return { draftText: '', model: MODEL };
  }
  if (!input.guestMessage.trim()) {
    return { draftText: '', model: MODEL };
  }

  const system = buildSystemPrompt(input);
  try {
    const client = getClient();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      system,
      messages: [
        { role: 'user', content: input.guestMessage.slice(0, 2000) },
      ],
    });
    const block = response.content[0];
    if (!block || block.type !== 'text') {
      return { draftText: '', model: MODEL };
    }
    return { draftText: block.text.trim(), model: MODEL };
  } catch (err) {
    console.error('[autoReplyDrafter] failed:', err instanceof Error ? err.message : err);
    return { draftText: '', model: MODEL };
  }
}

function buildSystemPrompt(input: DraftInput): string {
  const { reservation, category, language } = input;
  const facts = getFactsForCategory(category);
  // Always include parking facts even when category is `other` — many
  // operator-handled questions turn out to be parking-adjacent (EV,
  // height, second car), and grounding the drafter in the parking
  // facts list prevents it from making things up.
  const parkingFacts = category === 'other' ? getFactsForCategory('parking') : null;

  const factsBlock = [
    facts ? `# Facts about ${category}\n${facts}` : null,
    parkingFacts && parkingFacts !== facts
      ? `# Parking facts (in case the question is parking-adjacent)\n${parkingFacts}`
      : null,
  ]
    .filter(Boolean)
    .join('\n\n');

  const langLine = language
    ? `Reply in the SAME language as the guest's message (detected: ${language}).`
    : "Reply in the guest's language. If unsure, reply in English.";

  const guestName = (reservation.firstName || 'there').trim();
  const room = reservation.room || 'their apartment';

  return `You are Zuzana, an operator at Baker House Apartments in Brno. You draft short, warm replies to a single guest message. Your draft will be REVIEWED by a human operator before sending — keep it grounded, don't invent amenities or policies.

Guest: ${guestName} (apartment ${room})

# How to write the reply
- Start with "Hi ${guestName}!"
- Be concise — 1–4 short paragraphs. No filler.
- Answer ONLY what the guest asked. Don't volunteer extra information.
- If the question requires a policy decision (late checkout, exception requests, refunds, anything not covered in the facts below), DRAFT a holding reply that says the operator will confirm — do NOT commit on Zuzana's behalf.
- Do NOT sign off — the system appends "— Zuzana" automatically.
- ${langLine}
- If you genuinely don't have enough information to draft a useful reply, return the single word: SKIP

${factsBlock || '# No category-specific facts available — keep the draft minimal and acknowledge the operator will follow up with details.'}`;
}

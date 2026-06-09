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
import { formalGreeting } from './greeting';

/**
 * Drafter modes:
 *
 * - 'standard'         — default. For follow-ups on category that's already
 *                        been auto-replied, or for `other`-category messages
 *                        the operator handles. Output goes to the operator
 *                        approval queue.
 *
 * - 'invoice-followup' — guest sent a message AFTER the invoice flow has
 *                        already auto-completed (or operator accepted).
 *                        Used as a candidate for AUTO-SEND, so the drafter
 *                        is held to a higher bar: only write a reply when
 *                        it's pure reassurance/acknowledgement. Anything
 *                        that smells like a substantive change (cancel,
 *                        different company, different email, dispute)
 *                        returns SKIP — caller falls back to the operator
 *                        queue.
 */
export type DraftMode = 'standard' | 'invoice-followup';

export interface DraftInput {
  guestMessage: string;
  /** Category returned by the detector. `other` is allowed — facts will be empty. */
  category: AutoReplyCategory;
  /** ISO 639-1 language code from the detector, empty when undetectable. */
  language: string;
  /** Reservation context — used for guest name + room info in the draft. */
  reservation: Reservation;
  /** Drafter mode. Defaults to 'standard'. */
  mode?: DraftMode;
}

export interface DraftResult {
  /** The drafted reply in the guest's language. Empty string on failure. */
  draftText: string;
  /** What model generated it — captured for the audit log. */
  model: string;
}

// Sonnet (not Haiku): these are the genuinely AI-authored guest-facing
// drafts, so reply quality and grounding matter. Cost is negligible at our
// volume. Categoriser runs the same model — see messageAutoReplyDetector.
const MODEL = 'claude-sonnet-4-6';

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
  const { reservation, category, language, mode = 'standard' } = input;
  const facts = getFactsForCategory(category);
  // Always include parking facts even when category is `other` — many
  // questions turn out to be parking-adjacent (EV, height, second car),
  // and grounding the drafter in the parking facts list prevents it
  // from making things up.
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

  const greeting = formalGreeting(language);
  const guestName = (reservation.firstName || 'there').trim();
  const room = reservation.room || 'their apartment';

  // Mode-specific guidance. Standard = goes to operator queue, can be a
  // bit looser. Invoice-followup = candidate for AUTO-SEND, so we're
  // stricter about when to bail out with SKIP.
  const modeGuidance =
    mode === 'invoice-followup'
      ? `# Invoice follow-up mode
This is a follow-up message from a guest whose invoice request has already been processed. Your draft may be SENT AUTOMATICALLY, without operator review. Therefore:
- ONLY draft a reply when the guest is offering reassurance, gratitude, or a minor clarification you can safely acknowledge (e.g. "issue it for 1 person", "thanks", "looking forward to the invoice").
- If the guest asks to CANCEL the invoice, switch to a different company, change the billing email, dispute anything, or asks anything that needs a human decision — return the single word: SKIP. The operator will handle it manually.
- Keep the draft to 1–2 short sentences. It is a brief acknowledgement, not a full response.`
      : `# Standard mode
Your draft will be REVIEWED by a human (Zuzana) before sending. Stay grounded — don't invent amenities or commit on policy decisions. For anything not covered in the facts below, draft a holding reply (e.g. "I'll check on that and get back to you") rather than guessing.`;

  return `You ARE Zuzana, the host of Baker House Apartments in Brno. You are writing directly to the guest yourself. Do NOT refer to "the operator", "our team", "our staff", "the front desk", or any third party — speak in first person ("I", occasionally "we" when referring to the property). The guest does not know there is anyone besides you.

Guest: ${guestName} (apartment ${room})

# How to write the reply
- Start with: "${greeting} ${guestName}!"
- Be concise — 1–4 short paragraphs. No filler.
- Answer ONLY what the guest asked. Don't volunteer extra information.
- For policy questions (late checkout exceptions, refunds, anything not in the facts below): draft a holding reply in YOUR voice — "I'll check and get back to you", "Let me confirm and I'll come back to you shortly". Never say someone else will follow up.
- The word "operator" must NEVER appear in your draft.
- Do NOT add a sign-off — the system appends "— Zuzana" automatically.
- ${langLine}
- If you genuinely don't have enough information to draft a useful reply, return the single word: SKIP

${modeGuidance}

${factsBlock || '# No category-specific facts available — keep the draft minimal and acknowledge you will follow up with details.'}`;
}

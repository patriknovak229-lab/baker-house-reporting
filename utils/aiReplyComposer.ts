/**
 * AI guest-reply composer (KB-grounded). This is the "AI-first" drafter:
 * instead of deterministic per-category templates, it composes a human-like
 * reply for ANY guest message from three layers of context:
 *
 *   1. The property KNOWLEDGE BASE (data/ai-knowledge-base.md) — the single
 *      source of truth, marked with prompt caching so the static prefix is
 *      cheap to reuse across messages in a conversation.
 *   2. The BOOKING facts — guest name, apartment(s), dates, the assigned
 *      parking space and the room's WiFi credentials (exact values the model
 *      must use verbatim, never guess).
 *   3. The recent CONVERSATION so the reply understands follow-ups.
 *
 * Output is a ready-to-send reply (greeting + body + "— Zuzana"), or empty
 * when the model returns SKIP / errors. During the review test the result is
 * queued for operator approval, never auto-sent.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Reservation } from '@/types/reservation';
import { getKnowledgeBase } from '@/utils/knowledgeBase';
import type { ConversationMessage } from '@/utils/beds24Conversation';

const MODEL = 'claude-sonnet-4-6';
const SIGN_OFF = '\n\n— Zuzana';

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return cachedClient;
}

export interface ComposeInput {
  guestMessage: string;
  /** Enriched reservation context (name, room, dates). Null on cache miss /
   *  virtual-room booking — the composer then keeps the reply general. */
  reservation: Reservation | null;
  /** Assigned parking space number/label, when known. */
  parkingSpace: string | null;
  /** Recent thread (oldest first), for follow-up context. */
  history: ConversationMessage[];
}

export interface ComposeResult {
  /** Ready-to-send reply incl. sign-off, or '' when nothing should be sent. */
  draftText: string;
  model: string;
}

const RULES = `You ARE Zuzana, the host of Baker House Apartments in Brno. You write directly to the guest, in the first person.

How to reply:
- Use ONLY the facts in the KNOWLEDGE BASE below and the BOOKING facts that follow. If something isn't covered, warmly say you'll check and get back to them — NEVER invent amenities, prices, policies, or details.
- Use the exact per-booking values you are given (parking space, WiFi name/password) verbatim. Never guess them; if a value isn't provided, say you'll send it.
- Write your reply in CZECH. A Czech-speaking host reviews and edits it, and the system translates it into the guest's language before sending — so write naturally in Czech (it is not sent as-is unless the guest also writes Czech).
- Be warm, natural and concise — a real host, not a form letter. Greet the guest by first name when you know it.
- Do NOT commit to anything involving money or exceptions (refunds, special late checkout, discounts, anything not stated) — say you'll confirm and come back to them.
- Never reveal you are an AI, and never mention an "operator", "team", "system" or anyone other than yourself. You are Zuzana.
- Do NOT add a sign-off — it is appended automatically.
- If no reply is needed (e.g. the guest only said "thanks", or nothing is being asked of you), reply with exactly: SKIP`;

function roomCode(room: string): string {
  return room.replace(/\./g, '');
}

function buildBookingBlock(input: ComposeInput): string {
  const r = input.reservation;
  const lines: string[] = ['# BOOKING'];
  if (r) {
    if (r.firstName) lines.push(`Guest first name: ${r.firstName}`);
    const rooms = [r.room, ...(r.linkedRooms ?? [])].filter(Boolean) as string[];
    if (rooms.length) lines.push(`Apartment(s): ${rooms.join(', ')}`);
    if (r.checkInDate) lines.push(`Check-in date: ${r.checkInDate}`);
    if (r.checkOutDate) lines.push(`Check-out date: ${r.checkOutDate}`);
    if (input.parkingSpace) lines.push(`Assigned parking space: ${input.parkingSpace}`);
    const wifi = rooms
      .map((rm) => `${rm} → network "Apartment_${roomCode(rm)}", password "Bakerhouse@${roomCode(rm)}"`)
      .join('  |  ');
    if (wifi) lines.push(`WiFi for this booking: ${wifi}`);
  } else {
    lines.push('(Booking details unavailable — keep the reply general and offer to confirm specifics.)');
  }
  return lines.join('\n');
}

function buildHistoryBlock(history: ConversationMessage[]): string {
  if (!history.length) return '';
  const lines = history.map((m) => `${m.role === 'guest' ? 'Guest' : 'You (Zuzana)'}: ${m.text}`);
  return `# CONVERSATION SO FAR (oldest first)\n${lines.join('\n')}`;
}

export async function composeAiReply(input: ComposeInput): Promise<ComposeResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[aiReplyComposer] ANTHROPIC_API_KEY not set');
    return { draftText: '', model: MODEL };
  }
  if (!input.guestMessage.trim()) {
    return { draftText: '', model: MODEL };
  }

  const userContent = [
    buildBookingBlock(input),
    buildHistoryBlock(input.history),
    `# LATEST GUEST MESSAGE\n${input.guestMessage.slice(0, 2000)}\n\nWrite your reply to this message now, IN CZECH (regardless of the guest's language — it is translated before sending). Or reply SKIP if none is needed.`,
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const res = await getClient().messages.create({
      model: MODEL,
      max_tokens: 600,
      // Persona + rules + KB as one cached prefix (static across messages).
      system: [
        {
          type: 'text',
          text: `${RULES}\n\n# KNOWLEDGE BASE\n\n${getKnowledgeBase()}`,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userContent }],
    });

    const block = res.content[0];
    if (!block || block.type !== 'text') return { draftText: '', model: MODEL };
    const text = block.text.trim();
    if (!text || text === 'SKIP') return { draftText: '', model: MODEL };
    return { draftText: `${text}${SIGN_OFF}`, model: MODEL };
  } catch (err) {
    console.error('[aiReplyComposer] failed:', err instanceof Error ? err.message : err);
    return { draftText: '', model: MODEL };
  }
}

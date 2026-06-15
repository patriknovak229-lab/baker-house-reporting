/**
 * Translate the host's approved Czech reply into the guest's language at SEND
 * time (Czech-first workflow: the operator reads/edits in Czech, the guest
 * receives their own language). Uses Sonnet rather than Google Translate so
 * the hospitality tone survives. Throws on failure so the caller can surface
 * the error and keep the draft queued rather than send the wrong language.
 */

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-4-6';

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return cachedClient;
}

export async function translateReplyToGuest(text: string, targetLang: string): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  if (!text.trim()) throw new Error('nothing to translate');

  const system = `You translate a short message from a holiday-apartment host (Zuzana) to her guest. Translate the message into the guest's language (ISO 639-1 code: "${targetLang}"). Preserve the warm, natural, first-person host tone — it must read like the host wrote it herself, not like a machine translation. Keep the sign-off name "Zuzana" exactly as written. Output ONLY the translated message — no preamble, notes, or quotes.`;

  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 800,
    system,
    messages: [{ role: 'user', content: text }],
  });

  const block = res.content[0];
  if (!block || block.type !== 'text' || !block.text.trim()) {
    throw new Error('translation returned empty');
  }
  return block.text.trim();
}

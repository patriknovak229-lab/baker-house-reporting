/**
 * Google Cloud Translation API v2 — server-side helper.
 *
 * Extracted from app/api/translate/route.ts so server-side callers (the
 * Beds24 message webhook in particular) can translate text without going
 * through the HTTP route — which requires a NextAuth session that webhook
 * payloads obviously don't carry.
 *
 * Usage:
 *   const { translatedText, detectedLanguage } = await translateText(
 *     'Hello!', 'cs',
 *   );
 *
 * Returns `null` when GOOGLE_TRANSLATE_API_KEY is missing — callers should
 * fall back to the original text rather than fail the whole flow.
 */

const GOOGLE_TRANSLATE_URL = 'https://translation.googleapis.com/language/translate/v2';

export interface TranslationResult {
  translatedText: string;
  detectedLanguage: string;
}

/**
 * Translate `text` into `targetLang`. Returns the translated text and the
 * source language Google detected. Throws on API errors so the caller can
 * decide whether to bubble or fall back to the original.
 */
export async function translateText(
  text: string,
  targetLang: string,
): Promise<TranslationResult | null> {
  if (!text.trim()) return null;
  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!apiKey) {
    console.warn('[googleTranslate] GOOGLE_TRANSLATE_API_KEY not set — returning null');
    return null;
  }

  const res = await fetch(`${GOOGLE_TRANSLATE_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text, target: targetLang, format: 'text' }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.message ?? `Google Translate returned ${res.status}`;
    throw new Error(msg);
  }
  const translation = data?.data?.translations?.[0];
  if (!translation) {
    throw new Error('No translation returned');
  }
  return {
    translatedText: String(translation.translatedText ?? ''),
    detectedLanguage: String(translation.detectedSourceLanguage ?? ''),
  };
}

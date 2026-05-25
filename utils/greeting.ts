/**
 * Language-appropriate FORMAL greetings used as the opening line of any
 * guest-facing message. Substituted into templates AFTER Google Translate
 * runs, because Translate left to its own devices renders "Hi" as the
 * informal local equivalent ("Ahoj" in Czech, "Hej" in Polish, etc.) —
 * which feels unprofessional coming from a hotel host. Operators wanted
 * something equivalent to "Dobrý den" in Czech: polite, neutral, slightly
 * formal.
 *
 * Languages outside this map fall back to "Hello" rather than guessing.
 * Add more as guest origins broaden.
 */

/**
 * Placeholder token that lives inside English-authored templates. Replaced
 * with `formalGreeting(lang)` AFTER translation so the chosen greeting
 * isn't mangled by Google Translate.
 *
 * Choose an unusual token that machine translation won't accidentally
 * touch. `{{GREETING}}` survives Google Translate cleanly in all our
 * supported languages.
 */
export const GREETING_TOKEN = '{{GREETING}}';

const GREETINGS: Record<string, string> = {
  en: 'Hello',
  cs: 'Dobrý den',
  sk: 'Dobrý deň',
  de: 'Guten Tag',
  fr: 'Bonjour',
  it: 'Buongiorno',
  es: 'Hola',
  pl: 'Dzień dobry',
  ru: 'Здравствуйте',
  uk: 'Доброго дня',
  hu: 'Jó napot',
  nl: 'Goedendag',
  pt: 'Bom dia',
};

/**
 * Returns the formal greeting for the given ISO-639-1 code, or "Hello"
 * when the language is unknown / empty.
 */
export function formalGreeting(language: string | null | undefined): string {
  const code = (language ?? '').toLowerCase().slice(0, 2);
  return GREETINGS[code] ?? GREETINGS.en;
}

/**
 * Substitute the GREETING_TOKEN placeholder in a translated string with
 * the language-appropriate formal greeting. Idempotent — running twice
 * just leaves the second call as a no-op.
 */
export function applyGreeting(text: string, language: string | null | undefined): string {
  return text.replace(/\{\{GREETING\}\}/g, formalGreeting(language));
}

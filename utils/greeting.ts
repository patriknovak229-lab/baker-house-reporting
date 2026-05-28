/**
 * Language-appropriate FORMAL greetings used as the opening line of any
 * guest-facing message. Prepended to the FINAL translated string —
 * NEVER embedded inside the template that goes through Google Translate.
 *
 * Why: we tried `{{GREETING}}` as an in-string placeholder substituted
 * post-translation, but Google Translate `format: 'text'` mangled it
 * (in Czech it shipped as literal `{{ZDRAV}}` to a guest). Even unusual
 * delimiters aren't reliable against Translate's heuristics. The only
 * safe place for the greeting is OUTSIDE the translated body.
 *
 * Languages outside this map fall back to "Hello" rather than guessing.
 * Add more as guest origins broaden.
 */

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

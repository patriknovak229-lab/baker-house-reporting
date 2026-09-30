/**
 * Target languages for the Transactions "Translate" tool (Google Translate v2
 * codes). Names are baked in rather than generated from `Intl.DisplayNames`
 * for the same reason as utils/countries.ts: server and browser ICU disagree
 * on a handful of names.
 *
 * COMMON is the property's real guest mix plus the operator's own two
 * languages, so the dropdown opens on the ones actually used. OTHER is sorted
 * by name. A language never appears in both.
 */

export type TranslateLanguage = { code: string; name: string };

export const COMMON_LANGUAGES: readonly TranslateLanguage[] = [
  { code: 'en', name: 'English' },
  { code: 'cs', name: 'Czech' },
  { code: 'de', name: 'German' },
  { code: 'sk', name: 'Slovak' },
  { code: 'pl', name: 'Polish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'ru', name: 'Russian' },
  { code: 'it', name: 'Italian' },
  { code: 'fr', name: 'French' },
  { code: 'es', name: 'Spanish' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'nl', name: 'Dutch' },
];

export const OTHER_LANGUAGES: readonly TranslateLanguage[] = [
  { code: 'sq', name: 'Albanian' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hy', name: 'Armenian' },
  { code: 'az', name: 'Azerbaijani' },
  { code: 'be', name: 'Belarusian' },
  { code: 'bs', name: 'Bosnian' },
  { code: 'bg', name: 'Bulgarian' },
  { code: 'zh-CN', name: 'Chinese (Simplified)' },
  { code: 'zh-TW', name: 'Chinese (Traditional)' },
  { code: 'hr', name: 'Croatian' },
  { code: 'da', name: 'Danish' },
  { code: 'et', name: 'Estonian' },
  { code: 'tl', name: 'Filipino' },
  { code: 'fi', name: 'Finnish' },
  { code: 'ka', name: 'Georgian' },
  { code: 'el', name: 'Greek' },
  { code: 'he', name: 'Hebrew' },
  { code: 'hi', name: 'Hindi' },
  { code: 'is', name: 'Icelandic' },
  { code: 'id', name: 'Indonesian' },
  { code: 'ga', name: 'Irish' },
  { code: 'ja', name: 'Japanese' },
  { code: 'kk', name: 'Kazakh' },
  { code: 'ko', name: 'Korean' },
  { code: 'lv', name: 'Latvian' },
  { code: 'lt', name: 'Lithuanian' },
  { code: 'mk', name: 'Macedonian' },
  { code: 'ms', name: 'Malay' },
  { code: 'mn', name: 'Mongolian' },
  { code: 'no', name: 'Norwegian' },
  { code: 'fa', name: 'Persian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ro', name: 'Romanian' },
  { code: 'sr', name: 'Serbian' },
  { code: 'sl', name: 'Slovenian' },
  { code: 'sv', name: 'Swedish' },
  { code: 'th', name: 'Thai' },
  { code: 'tr', name: 'Turkish' },
  { code: 'vi', name: 'Vietnamese' },
];

const ALL_LANGUAGES = [...COMMON_LANGUAGES, ...OTHER_LANGUAGES];

/** Legacy / regional codes Google can report as `detectedSourceLanguage`,
 *  mapped onto the code used in the lists above. */
const CODE_ALIASES: Record<string, string> = {
  iw: 'he',
  zh: 'zh-CN',
  fil: 'tl',
  nb: 'no',
  'pt-br': 'pt',
  'pt-pt': 'pt',
};

/** The list's own code for `code`, matched case-insensitively and through
 *  Google's aliases ("iw" → "he", "zh" → "zh-CN"). Unknown codes come back
 *  lower-cased, so two unknowns still compare equal. */
export function canonicalLanguageCode(code: string): string {
  const lower = code.trim().toLowerCase();
  const target = CODE_ALIASES[lower] ?? lower;
  return ALL_LANGUAGES.find((l) => l.code.toLowerCase() === target.toLowerCase())?.code ?? target;
}

/** English name for a language code; falls back to the upper-cased code for
 *  anything not in the lists, so a surprise detection still reads sensibly. */
export function translateLanguageName(code: string): string {
  const canonical = canonicalLanguageCode(code);
  return ALL_LANGUAGES.find((l) => l.code === canonical)?.name ?? code.trim().toUpperCase();
}

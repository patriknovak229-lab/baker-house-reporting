// Ordered longest prefix first to avoid shorter prefix shadowing (e.g. +7 vs +380)
const PHONE_PREFIX_MAP: [string, string][] = [
  ["+358", "FI"],
  ["+351", "PT"],
  ["+380", "UA"],
  ["+420", "CZ"],
  ["+421", "SK"],
  ["+49", "DE"],
  ["+43", "AT"],
  ["+44", "GB"],
  ["+33", "FR"],
  ["+39", "IT"],
  ["+48", "PL"],
  ["+46", "SE"],
  ["+45", "DK"],
  ["+47", "NO"],
  ["+34", "ES"],
  ["+31", "NL"],
  ["+32", "BE"],
  ["+41", "CH"],
  ["+36", "HU"],
  ["+40", "RO"],
  ["+90", "TR"],
  ["+61", "AU"],
  ["+81", "JP"],
  ["+82", "KR"],
  ["+86", "CN"],
  ["+91", "IN"],
  ["+55", "BR"],
  ["+52", "MX"],
  ["+7", "RU"],
  ["+1", "US"],
];

const LANG_TO_COUNTRY: Record<string, string> = {
  cs: "CZ",
  sk: "SK",
  de: "DE",
  fr: "FR",
  it: "IT",
  pl: "PL",
  sv: "SE",
  da: "DK",
  fi: "FI",
  no: "NO",
  ru: "RU",
  es: "ES",
  pt: "PT",
  nl: "NL",
  hu: "HU",
  ro: "RO",
  uk: "UA",
  tr: "TR",
  en: "GB",
};

const COUNTRY_NAMES: Record<string, string> = {
  CZ: "Czech",
  SK: "Slovak",
  DE: "German",
  AT: "Austrian",
  GB: "British",
  FR: "French",
  IT: "Italian",
  PL: "Polish",
  SE: "Swedish",
  DK: "Danish",
  FI: "Finnish",
  NO: "Norwegian",
  RU: "Russian",
  ES: "Spanish",
  PT: "Portuguese",
  NL: "Dutch",
  BE: "Belgian",
  CH: "Swiss",
  HU: "Hungarian",
  RO: "Romanian",
  UA: "Ukrainian",
  TR: "Turkish",
  US: "American",
  AU: "Australian",
  JP: "Japanese",
  KR: "Korean",
  CN: "Chinese",
  IN: "Indian",
  BR: "Brazilian",
  MX: "Mexican",
};

export function deriveNationality(phone: string, lang?: string): string {
  const normalized = phone.replace(/\s/g, "");
  for (const [prefix, country] of PHONE_PREFIX_MAP) {
    if (normalized.startsWith(prefix)) return country;
  }
  if (lang && LANG_TO_COUNTRY[lang]) return LANG_TO_COUNTRY[lang];
  return "";
}

export function countryCodeToFlag(code: string): string {
  if (!code || code.length !== 2) return "";
  return [...code.toUpperCase()]
    .map((c) => String.fromCodePoint(c.charCodeAt(0) + 127397))
    .join("");
}

export function countryCodeToName(code: string): string {
  return COUNTRY_NAMES[code] ?? code;
}

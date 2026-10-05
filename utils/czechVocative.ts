/**
 * Czech vocative (5th case) for a guest's FIRST name, so a Czech greeting reads
 * "Dobrý den Ivane" / "Dobrý den Zuzano" rather than the nominative
 * "Dobrý den Ivan". Deterministic rules — no LLM, no translator — because the
 * greeting is the one line every guest reads and must never come out wrong.
 *
 * Only use this when the text going out is CZECH. Slovak (and every other
 * language) addresses people in the nominative, so leave the name alone there.
 *
 * Coverage is the common Czech/Slovak/international first names, with or
 * without diacritics ("Tomas" → "Tomasi", "Zdenek" → "Zdenku"). When a name
 * doesn't fit any rule it is returned unchanged — the nominative is a little
 * stiff but never wrong-looking, unlike a bad inflection.
 */

/** Female names ending in a consonant — the vocative is identical to the
 *  nominative ("Dobrý den Dagmar"). Lowercase, diacritics stripped. */
const FEMALE_CONSONANT_NAMES = new Set([
  'dagmar', 'ingrid', 'miriam', 'carmen', 'ester', 'rut', 'nicol', 'nikol', 'ivet',
  'karin', 'kristin', 'kirsten', 'elizabet', 'margit', 'edit', 'judit', 'lilian',
  'jasmin', 'vivien', 'yvonne', 'ellen', 'helen', 'karen', 'sharon', 'megan',
  'kathleen', 'gwen', 'jennifer', 'allison', 'alison', 'madison', 'ingeborg',
  'astrid', 'sigrid', 'gudrun', 'brigit', 'gertrud', 'irmgard', 'hildegard',
  'elisabeth', 'ruth', 'beth', 'agnes', 'doris', 'iris', 'gladys', 'frances',
  'janet', 'margaret', 'harriet', 'charlotte', 'marion', 'naomi',
  'dolores', 'mercedes', 'ines', 'beatrix', 'eileen', 'kathryn', 'lynn',
  'ann', 'jill', 'kim', 'pam', 'nell', 'mabel', 'isabel', 'rachel', 'carol',
  'abigail', 'hazel', 'ethel', 'muriel', 'rahel',
]);

/** -el names whose "e" drops out: Pavel → Pavle. Every other -el name takes
 *  -i (Daniel → Danieli, Michael → Michaeli, Marcel → Marceli). */
const FLEETING_E_EL = new Set(['pavel', 'karel', 'havel']);

/** Soft / sibilant endings that take -i (Tomáš → Tomáši, Ondřej → Ondřeji). */
const SOFT_ENDINGS = /[šžčřcjťďňsxz]$/i;
/** Velar endings that take -u (Patrik → Patriku, Oldřich → Oldřichu). */
const VELAR_ENDINGS = /(k|h|g|ch)$/i;

function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Match the case of `suffix` to the word it's appended to (handles "IVAN"). */
function withSuffix(stem: string, suffix: string): string {
  const isUpper = stem.length > 1 && stem === stem.toUpperCase() && stem !== stem.toLowerCase();
  return stem + (isUpper ? suffix.toUpperCase() : suffix);
}

/**
 * Heuristic gender from a Czech/Slovak surname: feminine surnames end in -á
 * ("Nováková", "Teplá") — also written without diacritics ("Novakova").
 * Returns null when the surname says nothing.
 */
function femaleFromSurname(lastName?: string | null): boolean | null {
  const s = stripDiacritics((lastName ?? '').trim().toLowerCase());
  if (!s) return null;
  if (/ova$/.test(s)) return true;
  if ((lastName ?? '').trim().toLowerCase().endsWith('á')) return true;
  return null;
}

/** Vocative of ONE given name (no spaces). */
function vocativeOfWord(name: string, female: boolean | null): string {
  const lower = name.toLowerCase();
  const plain = stripDiacritics(lower);

  // Vowel endings other than -a stay as they are: Marie, Lucie, Jiří, Ivo,
  // Hugo, René, Tony, Uwe.
  if (/[eěéiíoóuúůyý]$/.test(lower)) return name;

  // -a → -o for both genders (Zuzana → Zuzano, Jana → Jano, Andrea → Andreo,
  // Honza → Honzo). -á (rare as a first name) left alone.
  if (lower.endsWith('a')) return name.slice(0, -1) + (name.slice(-1) === 'A' ? 'O' : 'o');
  if (lower.endsWith('á')) return name;

  // Consonant ending from here on. A woman's name ending in a consonant does
  // not inflect (Dagmar, Ingrid, Karin).
  if (female === true || FEMALE_CONSONANT_NAMES.has(plain)) return name;

  // -ek / -ěk: Marek → Marku, Radek → Radku, Zdeněk → Zdeňku, Zdenek → Zdenku.
  if (lower.endsWith('ěk')) {
    const before = name.slice(0, -2);
    const last = before.slice(-1);
    const soft: Record<string, string> = { d: 'ď', t: 'ť', n: 'ň', D: 'Ď', T: 'Ť', N: 'Ň' };
    return withSuffix(before.slice(0, -1) + (soft[last] ?? last), 'ku');
  }
  if (lower.length > 3 && lower.endsWith('ek')) return withSuffix(name.slice(0, -2), 'ku');

  // -el: Pavel → Pavle, Karel → Karle; Daniel → Danieli, Michael → Michaeli.
  if (lower.endsWith('el')) {
    if (FLEETING_E_EL.has(plain)) return withSuffix(name.slice(0, -2), 'le');
    return withSuffix(name, 'i');
  }

  // Velars: Patrik → Patriku, Dominik → Dominiku, Vojtěch → Vojtěchu, Oleg → Olegu.
  if (VELAR_ENDINGS.test(lower)) return withSuffix(name, 'u');

  // Consonant + r → -ře: Petr → Petře, Alexandr → Alexandře.
  // Vowel + r takes the regular -e: Igor → Igore, Libor → Libore.
  if (/[^aeiouyáéíóúůýě]r$/.test(lower)) return withSuffix(name.slice(0, -1), 'ře');

  // Soft / sibilant: Tomáš → Tomáši, Lukas → Lukasi, Ondřej → Ondřeji, Max → Maxi.
  if (SOFT_ENDINGS.test(lower)) return withSuffix(name, 'i');

  // Every other hard consonant takes -e: Ivan → Ivane, Jan → Jane,
  // Martin → Martine, Adam → Adame, Josef → Josefe, Michal → Michale.
  if (/[bdfhlmnprtvw]$/.test(plain)) return withSuffix(name, 'e');

  return name;
}

/**
 * Czech vocative of a first name. Multi-part first names inflect each part
 * ("Jan Pavel" → "Jane Pavle"); hyphenated ones too ("Anna-Marie" → "Anno-Marie").
 * `lastName` is optional and only used as a gender hint.
 */
export function czechVocative(firstName: string, lastName?: string | null): string {
  const name = (firstName ?? '').trim();
  if (!name) return name;
  const female = femaleFromSurname(lastName);
  return name
    .split(/(\s+|-)/)
    .map((part) => (/^(\s+|-)$/.test(part) || !part ? part : vocativeOfWord(part, female)))
    .join('');
}

/**
 * Should the guest be addressed in Czech? True when the message going out is
 * Czech — the guest wrote in Czech, or (no language signal) they're a Czech
 * national. A Czech national writing in English gets an English reply, where
 * the vocative would be nonsense ("Hello Ivane").
 */
export function repliesInCzech(
  language: string | null | undefined,
  nationality?: string | null,
): boolean {
  const lang = (language ?? '').trim().toLowerCase().slice(0, 2);
  if (lang) return lang === 'cs';
  return (nationality ?? '').trim().toUpperCase() === 'CZ';
}

/**
 * The formal Czech opening line: "Dobrý den Ivane," / "Dobrý den," when no
 * name is known. Never "Ahoj" — guests are addressed formally (vykání), by
 * first name.
 */
export function czechGreetingLine(firstName?: string | null, lastName?: string | null): string {
  const name = (firstName ?? '').trim();
  return name ? `Dobrý den ${czechVocative(name, lastName)},` : 'Dobrý den,';
}

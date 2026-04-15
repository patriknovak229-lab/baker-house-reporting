/**
 * Remove diacritics (accents) from a string.
 * e.g. "Václavíková" → "Vaclavikova"
 */
export function removeDiacritics(str: string): string {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Normalize a string for search: lowercase + strip diacritics.
 * "Václavíková" → "vaclavikova"
 */
export function normalizeForSearch(str: string): string {
  return removeDiacritics(str).toLowerCase();
}

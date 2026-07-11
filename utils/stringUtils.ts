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

/** Digits only — used to match phone numbers regardless of spacing / "+". */
export function phoneDigits(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\D/g, "");
}

/**
 * Split a run of digits into readable groups of 3 or 4.
 * Prefers 4-digit groups only where needed so no group is left as a lone 1–2
 * digits: e.g. 11 → "1577 8939 731", 9 → "309 931 560", 7 → "1234 567".
 * Falls back to 3+remainder for lengths that can't be tiled by 3s and 4s (n=5).
 */
function groupNational(s: string): string[] {
  const n = s.length;
  if (n <= 4) return [s];
  const r = n % 3;
  const fours = r === 0 ? 0 : r === 1 ? 1 : 2; // #4-groups so the rest tiles by 3
  if (fours * 4 > n) return [s.slice(0, 3), s.slice(3)]; // n===5 → "3 + 2"
  const groups: string[] = [];
  let i = 0;
  for (let k = 0; k < fours; k++, i += 4) groups.push(s.slice(i, i + 4));
  for (; i < n; i += 3) groups.push(s.slice(i, i + 3));
  return groups;
}

// Country calling codes that are 3 digits long — needed only to split a "+CC"
// prefix when the stored number has no separator after it. Covers the codes
// seen in Baker House data plus common Central/Eastern-European ones; anything
// not listed falls back to a 2-digit code (or 1 for +1 / +7).
const CC3 = new Set([
  "420", "421", "423", "350", "351", "352", "353", "354", "355", "356", "357",
  "358", "359", "370", "371", "372", "373", "374", "375", "376", "377", "378",
  "379", "380", "381", "382", "383", "385", "386", "387", "389", "590", "591",
  "592", "593", "594", "595", "596", "597", "598", "599",
]);

/**
 * Format a phone number for readable display: keeps the country code as its own
 * group and splits the national part into groups of 3–4 digits.
 *   "+4915778939731"    → "+49 1577 8939 731"
 *   "+420 602 655 625"  → "+420 602 655 625"
 *   "420792508714"      → "420 792 508 714"
 * Non-phone junk (e.g. "Test") is returned unchanged.
 */
export function formatPhoneDisplay(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return "";
  if (phoneDigits(value).length < 5) return value; // too short / not a number

  const hasPlus = value.startsWith("+");
  let cc = "";
  let national: string;

  if (hasPlus) {
    const sepIdx = value.search(/[\s-]/);
    if (sepIdx > 0) {
      // Country code is the part before the first separator, as authored.
      cc = "+" + phoneDigits(value.slice(0, sepIdx));
      national = phoneDigits(value.slice(sepIdx));
    } else {
      const d = phoneDigits(value);
      const ccLen = d.startsWith("1") || d.startsWith("7") ? 1 : CC3.has(d.slice(0, 3)) ? 3 : 2;
      cc = "+" + d.slice(0, ccLen);
      national = d.slice(ccLen);
    }
  } else {
    national = phoneDigits(value);
  }

  const grouped = groupNational(national).join(" ");
  return cc ? `${cc} ${grouped}`.trim() : grouped;
}

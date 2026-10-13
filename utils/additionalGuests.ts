/**
 * Additional guests on a booking — the people sharing the stay besides the lead
 * guest Beds24 holds in firstName / lastName.
 *
 * WHERE THEY LIVE: in the Beds24 booking itself, as one line of `comments`:
 *
 *   [ADDITIONAL GUESTS: Jana Nováková; Petr Novák]
 *
 * Beds24's own per-booking guest list is not writable through the v2 API yet
 * (its `guests` array is documented as "coming soon", behind a scope we are not
 * granted), so the comment is the one place the names can go today. Keeping
 * them in Beds24 rather than in the app's overrides gives one source of truth:
 * the operator sees the names on the Beds24 booking, every reader that maps a
 * booking (the dashboard, the invoice cron) gets them from the same parse, and
 * fixing a typo is a plain edit of that comment line in Beds24.
 *
 * Bracket marker = the same convention as `[GROUP:…]` and `[CORPORATE:…]`.
 * Names are separated by `;` because a name can carry a comma ("Novák, Jr.")
 * but never a semicolon. Brackets and semicolons are stripped from names on the
 * way in, so no name can break the marker.
 */

const MARKER_RE = /\[ADDITIONAL GUESTS:\s*([^\]]*)\]/i;

/** A party is at most 18 people (7 apartments) — anything past this is junk input. */
export const MAX_ADDITIONAL_GUESTS = 20;

/** Longest single name we write — keeps one bad paste from flooding the comment. */
const MAX_NAME_LENGTH = 120;

/** One name, made safe to sit inside the marker. */
export function cleanGuestName(raw: string): string {
  return raw
    .replace(/[[\];\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
}

/** Untrusted input (a request body) → the clean, non-empty names, capped. */
export function normalizeAdditionalGuests(names: unknown): string[] {
  if (!Array.isArray(names)) return [];
  const out: string[] = [];
  for (const n of names) {
    if (typeof n !== 'string') continue;
    const clean = cleanGuestName(n);
    if (clean) out.push(clean);
    if (out.length >= MAX_ADDITIONAL_GUESTS) break;
  }
  return out;
}

/** The comment line to write, or null when there is nobody to add. */
export function formatAdditionalGuestsMarker(names: unknown): string | null {
  const clean = normalizeAdditionalGuests(names);
  return clean.length > 0 ? `[ADDITIONAL GUESTS: ${clean.join('; ')}]` : null;
}

/** Names from a Beds24 comment — empty when the booking carries no marker. */
export function parseAdditionalGuests(comments: string | null | undefined): string[] {
  if (!comments) return [];
  const m = comments.match(MARKER_RE);
  if (!m) return [];
  return m[1]
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

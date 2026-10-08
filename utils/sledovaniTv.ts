/**
 * Sledování TV (live-TV app) logins per apartment, for the AI guest-reply
 * composer. Kept OUT of git — the repo is public — in the Vercel env var
 * SLEDOVANI_TV_LOGINS, a JSON object keyed by apartment. Apartments sharing an
 * account can share one comma-separated key:
 *
 *   {"K.102,K.103,K.106": {"user": "…", "pass": "…"}, "O.308": {…}}
 *
 * Each apartment watches under the profile named after it (e.g. "K.106").
 * Missing / malformed env → no logins, and the composer says it'll send them.
 */

export interface TvLogin {
  user: string;
  pass: string;
}

function normalize(room: string): string {
  return room.replace(/\./g, '').trim().toUpperCase();
}

export function parseTvLogins(raw: string | undefined): Map<string, TvLogin> {
  const out = new Map<string, TvLogin>();
  if (!raw?.trim()) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[sledovaniTv] SLEDOVANI_TV_LOGINS is not valid JSON');
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const { user, pass } = (value ?? {}) as Record<string, unknown>;
    if (typeof user !== 'string' || typeof pass !== 'string' || !user || !pass) continue;
    for (const room of key.split(',')) {
      if (room.trim()) out.set(normalize(room), { user, pass });
    }
  }
  return out;
}

/** Login for one apartment ("K.106" or "K106"), or null when not configured. */
export function tvLoginFor(room: string, logins: Map<string, TvLogin>): TvLogin | null {
  return logins.get(normalize(room)) ?? null;
}

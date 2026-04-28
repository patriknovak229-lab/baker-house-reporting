/**
 * Room visual styling — assigns each room a small tinted chip so the operator
 * can scan the ROOM column at a glance.
 *
 * Three goals:
 *  - Subtle (light pastel bg + slightly darker text), not loud like a status badge.
 *  - Stable across pages (same room → same color, persistent visual identity).
 *  - Scales to new rooms — falls back to a deterministic palette index based on
 *    a hash of the room name, so adding "K.204" or "M.101" later just works
 *    without touching this file.
 *
 * The KNOWN_ROOMS map below pins curated combos for the rooms that exist today;
 * the fallback palette covers any future additions.
 */

const KNOWN_ROOMS: Record<string, { bg: string; text: string; ring: string }> = {
  'K.201': { bg: 'bg-blue-50',    text: 'text-blue-700',    ring: 'ring-blue-100' },
  'K.202': { bg: 'bg-emerald-50', text: 'text-emerald-700', ring: 'ring-emerald-100' },
  'K.203': { bg: 'bg-amber-50',   text: 'text-amber-700',   ring: 'ring-amber-100' },
  'O.308': { bg: 'bg-violet-50',  text: 'text-violet-700',  ring: 'ring-violet-100' },
};

// Cycled deterministically by hash of room name when a room isn't in KNOWN_ROOMS.
// Chosen to look harmonious with the curated colors above without overlapping.
const FALLBACK_PALETTE: ReadonlyArray<{ bg: string; text: string; ring: string }> = [
  { bg: 'bg-rose-50',    text: 'text-rose-700',    ring: 'ring-rose-100' },
  { bg: 'bg-orange-50',  text: 'text-orange-700',  ring: 'ring-orange-100' },
  { bg: 'bg-cyan-50',    text: 'text-cyan-700',    ring: 'ring-cyan-100' },
  { bg: 'bg-indigo-50',  text: 'text-indigo-700',  ring: 'ring-indigo-100' },
  { bg: 'bg-pink-50',    text: 'text-pink-700',    ring: 'ring-pink-100' },
  { bg: 'bg-teal-50',    text: 'text-teal-700',    ring: 'ring-teal-100' },
  { bg: 'bg-lime-50',    text: 'text-lime-700',    ring: 'ring-lime-100' },
  { bg: 'bg-fuchsia-50', text: 'text-fuchsia-700', ring: 'ring-fuchsia-100' },
];

// Combined-room display ("K.202 + K.203" etc.) — neutral so it doesn't pretend
// to belong to a single room's color group.
const COMBINED_STYLE = { bg: 'bg-slate-50', text: 'text-slate-700', ring: 'ring-slate-200' };

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function paletteFor(room: string) {
  const known = KNOWN_ROOMS[room];
  if (known) return known;
  return FALLBACK_PALETTE[hashString(room) % FALLBACK_PALETTE.length];
}

/**
 * Returns a className string for an inline chip rendering of a room name.
 * Use as: `<span className={roomChipClasses(res.room)}>{res.room}</span>`
 */
export function roomChipClasses(room: string): string {
  const isCombined = /\+/.test(room);
  const p = isCombined ? COMBINED_STYLE : paletteFor(room);
  return `inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ring-1 ring-inset ${p.bg} ${p.text} ${p.ring}`;
}

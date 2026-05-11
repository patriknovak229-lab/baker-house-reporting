/**
 * Room visual styling — assigns each room a small tinted chip so the operator
 * can scan the ROOM column at a glance.
 *
 * Colours are now category-coordinated:
 *   Deluxe (premium, gold-adjacent) → warm tones: amber, yellow, orange, rose
 *   Urban  (modern, urban feel)     → cool tones: teal, cyan, sky
 *
 * A glance at any room chip immediately signals its category by hue family,
 * and individual rooms within a category stay distinguishable by shade.
 *
 * The fallback palette covers any future additions outside these two groups.
 */

const KNOWN_ROOMS: Record<string, { bg: string; text: string; ring: string }> = {
  // ── Deluxe — warm (gold-adjacent) ──────────────────────────────────────
  'K.201': { bg: 'bg-amber-50',   text: 'text-amber-800',   ring: 'ring-amber-200' },
  'K.202': { bg: 'bg-yellow-50',  text: 'text-yellow-800',  ring: 'ring-yellow-200' },
  'K.203': { bg: 'bg-orange-50',  text: 'text-orange-800',  ring: 'ring-orange-200' },
  'O.308': { bg: 'bg-rose-50',    text: 'text-rose-800',    ring: 'ring-rose-200' },
  // ── Urban — cool (modern) ──────────────────────────────────────────────
  'K.102': { bg: 'bg-teal-50',    text: 'text-teal-800',    ring: 'ring-teal-200' },
  'K.103': { bg: 'bg-cyan-50',    text: 'text-cyan-800',    ring: 'ring-cyan-200' },
  'K.106': { bg: 'bg-sky-50',     text: 'text-sky-800',     ring: 'ring-sky-200' },
};

// Cycled deterministically by hash of room name when a room isn't in
// KNOWN_ROOMS. Steers away from the warm-Deluxe and cool-Urban hues used
// above so new rooms outside either category don't visually pretend to
// belong to one.
const FALLBACK_PALETTE: ReadonlyArray<{ bg: string; text: string; ring: string }> = [
  { bg: 'bg-violet-50',  text: 'text-violet-700',  ring: 'ring-violet-100' },
  { bg: 'bg-fuchsia-50', text: 'text-fuchsia-700', ring: 'ring-fuchsia-100' },
  { bg: 'bg-pink-50',    text: 'text-pink-700',    ring: 'ring-pink-100' },
  { bg: 'bg-emerald-50', text: 'text-emerald-700', ring: 'ring-emerald-100' },
  { bg: 'bg-lime-50',    text: 'text-lime-700',    ring: 'ring-lime-100' },
  { bg: 'bg-indigo-50',  text: 'text-indigo-700',  ring: 'ring-indigo-100' },
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

/** Curated palette — bg/text pairs that look good as small rounded badges */
export const CATEGORY_PALETTE: { bg: string; text: string }[] = [
  { bg: '#DBEAFE', text: '#1D4ED8' }, // blue
  { bg: '#EDE9FE', text: '#6D28D9' }, // violet
  { bg: '#DCFCE7', text: '#15803D' }, // green
  { bg: '#FEF9C3', text: '#A16207' }, // yellow
  { bg: '#FFEDD5', text: '#C2410C' }, // orange
  { bg: '#FCE7F3', text: '#BE185D' }, // pink
  { bg: '#CFFAFE', text: '#0E7490' }, // cyan
  { bg: '#CCFBF1', text: '#0F766E' }, // teal
  { bg: '#FFE4E6', text: '#BE123C' }, // rose
  { bg: '#F3F4F6', text: '#4B5563' }, // gray
];

/** Default color assigned to the n-th new category (cycles through palette) */
export function paletteColorAt(index: number): { bg: string; text: string } {
  return CATEGORY_PALETTE[index % CATEGORY_PALETTE.length];
}

/**
 * Return the text colour for a given badge background.
 * Falls back to a generic dark grey when the bg isn't in the palette.
 */
export function textColorFor(bg: string): string {
  return CATEGORY_PALETTE.find((p) => p.bg === bg)?.text ?? '#374151';
}

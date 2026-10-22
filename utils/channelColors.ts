// Channel colour palette — kept in one place so chart fills, legend swatches,
// and (where applicable) badge variants all agree.
//
// Branded values:
//   Booking.com — official brand blue (#003B95)
//   Airbnb      — Rausch red (#FF5A5F)
//   Google      — Google brand blue (#4285F4); the table tag spells the
//                 wordmark in all four brand colours
//   Direct-*    — emerald greens (Direct-Phone darker, Direct-Web lighter mint)
//
// Used by Recharts (hex strings, no Tailwind tokens).
export const CHANNEL_COLORS: Record<string, string> = {
  "Booking.com":  "#003B95",
  "Airbnb":       "#FF5A5F",
  "Google":       "#4285F4",
  "Direct-Phone": "#10B981", // emerald-500 — solid green
  "Direct-Web":   "#6EE7B7", // emerald-300 — lighter mint green
  "Direct":       "#94A3B8", // slate-400 — neutral fallback for legacy direct
};

export const CHANNEL_COLOR_FALLBACK = "#94A3B8";

export function getChannelColor(channel: string): string {
  return CHANNEL_COLORS[channel] ?? CHANNEL_COLOR_FALLBACK;
}

/**
 * Guest chat (Booking.com, Airbnb via Beds24) is plain text: markdown that the
 * model writes — **153**, # headings — reaches the guest as literal
 * asterisks/hashes (verified on BH-96695009, 24 Nov 2026: "spot number **153**").
 * The composer prompt forbids markdown; this is the safety net applied to every
 * AI draft before the operator sees it, so what they approve is what is sent.
 *
 * Single asterisks are left alone on purpose ("4*" ratings, quoted plates) —
 * only paired bold markers and headings, which are what we actually saw.
 */
export function toPlainChat(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1') // **bold** → bold
    .replace(/__(.+?)__/g, '$1') // __bold__ → bold
    .replace(/^#{1,6}\s+/gm, ''); // "## Heading" → "Heading"
}

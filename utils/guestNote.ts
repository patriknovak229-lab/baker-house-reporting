/**
 * The free-text note a guest typed on the web booking form
 * (bakerhouseapartments.cz → Beds24 `notes`, shown as "Notes" in Beds24).
 *
 * Beds24's `notes` is not only the guest's text. Beds24 appends its own log
 * lines to it, and the rental site prefixes a multi-apartment order with its
 * `WEB-GROUP-…` id (rental-site mergeNotesWithWebOrderRef):
 *
 *   WEB-GROUP-1700000000000-abcd1234 | Prosím o parkovací místo.
 *   Booked 1KK Urban Studios - 679714
 *   Transferred from 1KK Urban Studios to K.103 at 09:03 - 28 May 2026
 *
 * Only the guest's words are wanted, so the marker and the Beds24 lines are
 * stripped. The patterns come from a survey of every cached booking's notes
 * (2026-11-12).
 *
 * Server-derived on each sync, never stored in the overrides map.
 */

import type { Reservation } from '@/types/reservation';

const WEB_GROUP_PREFIX_RE = /^WEB-GROUP-[A-Za-z0-9-]+\s*(?:\|\s*)?/;

/** Lines Beds24 writes into `notes` itself. */
const BEDS24_SYSTEM_LINE_RES: RegExp[] = [
  /^Booked .+ - \d+$/, // virtual-room allocation: "Booked 1KK Urban Studios - 679714"
  /^Transferred from .+ at \d{1,2}:\d{2} - /, // room move log (can repeat on one line)
  /^Total Cancel Fee\b/,
  /^Note: price less than room min price\b/,
  /^Copy of Booking Id \d+$/,
];

export function parseGuestNote(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const kept: string[] = [];
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw.replace(WEB_GROUP_PREFIX_RE, '').trimEnd();
    if (BEDS24_SYSTEM_LINE_RES.some((re) => re.test(line.trim()))) continue;
    kept.push(line);
  }
  const text = kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n') // a dropped line can leave a run of blanks
    .trim();
  return text || null;
}

/**
 * Whether the guest-note badge in Transactions should blink (it always shows).
 * Blinking is the "someone still has to act on this" signal, so it should
 * stop once acting on the note no longer makes sense.
 *
 * `today` is the Prague date, YYYY-MM-DD (pragueToday()). Dates on the
 * reservation are YYYY-MM-DD too, so plain string comparison orders them.
 */
export function shouldBlinkGuestNote(
  res: Pick<Reservation, 'checkOutDate' | 'isCancelled'>,
  today: string,
): boolean {
  if (res.isCancelled) return false;
  // Past stay. Check-out day still counts as in-house (utils/stayStatus.ts).
  return res.checkOutDate >= today;
}

/**
 * The operator marked this note handled in the drawer. Only counts for the
 * exact text that was dismissed: a note the guest changes later comes back.
 */
export function isGuestNoteDismissed(
  res: Pick<Reservation, 'guestNote' | 'guestNoteDismissed'>,
): boolean {
  const d = res.guestNoteDismissed;
  return !!d && !!res.guestNote && d.text === res.guestNote;
}

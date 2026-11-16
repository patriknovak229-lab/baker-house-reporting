import type { ThreadMessage } from '@/app/api/messages/route';

/**
 * A message as the chat renders it. For a multi-apartment reservation the same
 * text can exist once per apartment booking — Beds24 runs its auto actions
 * (arrival guide, check-in info) on every booking of the group, so O.308 and
 * K.106 of BH-95377263 each got their own copy. `bookingIds` lists every
 * apartment booking this bubble stands for; the chat shows them as room chips.
 */
export type DisplayMessage = ThreadMessage & { bookingIds: number[] };

/**
 * Turn the merged, oldest-first group thread into the bubbles the chat shows.
 *
 * Input: messages from all apartment bookings, sorted by time, each tagged with
 * its own `bookingId`. Single-apartment reservations pass straight through.
 */
export function collapseGroupDuplicates(messages: ThreadMessage[]): DisplayMessage[] {
  // Deliberately NOT collapsed: every Beds24 auto action is its own message,
  // and the operator should see exactly what the guest received — two
  // near-identical arrival guides included. One bubble per message, one room.
  return messages.map((m) => ({ ...m, bookingIds: [m.bookingId] }));
}

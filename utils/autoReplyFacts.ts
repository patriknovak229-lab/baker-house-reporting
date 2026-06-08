/**
 * Plain-language facts the AI follow-up drafter is allowed to reference
 * when composing a reply to a guest's follow-up message. The drafter
 * injects only the facts for the matched category (or the parking facts
 * when the question is plausibly parking-adjacent) into its system
 * prompt — keeps the LLM grounded and prevents it from hallucinating
 * amenities or policies we don't actually offer.
 *
 * Edit these freely as the operational reality changes. The strings are
 * the source of truth; the drafter does not have any independent
 * knowledge of the building.
 */

import type { AutoReplyCategory } from './messageAutoReplyDetector';

export const PARKING_FACTS = `
- Each apartment has exactly ONE parking spot assigned to it. We do not
  offer a second spot — if the guest asks about parking a second car or
  needing an extra space, politely decline; we have none at our disposal.
- The underground garage has a HEIGHT LIMIT of 200 cm (2 metres). Vehicles
  taller than that cannot enter the garage at all.
- EV CHARGING is NOT currently available in the garage.
- All parking spaces are close to the elevators up to the apartments.
- Before entering the garage, the guest must pick up their keys from
  reception first — the keys include the chip/fob that opens the garage
  door. Pickup takes 1–2 minutes; they can park briefly in front of the
  reception entrance while collecting them.
- LEAVING the garage is automatic — the door opens on its own without
  needing the chip. Guests can drop the keys at reception and walk out
  without coming back inside.
- The entrance to the underground parking is NOT the first gate next to
  the main entrance — that is a service/emergency door. The correct gate
  is the next one along, approximately 20 metres from the reception door.
- Parking is available only DURING the stay: the car cannot be parked
  before the guest's check-in time, and on departure day it must be out
  of the garage by checkout (10:30). We cannot hold the space later, even
  when no one is arriving that day.
- We do NOT offer separate parking outside the dates of the guest's stay.
`.trim();

export const WIFI_FACTS = `
- Each apartment has its own WiFi network. Network name pattern:
  "Apartment_<RoomCode>" (e.g. Apartment_K102). Password pattern:
  "Bakerhouse@<RoomCode>" (e.g. Bakerhouse@K102).
- For multi-room bookings (e.g. K.202 + K.203 Twin Apartments), each
  room has its own separate network — list credentials per room.
`.trim();

export const MINIBAR_FACTS = `
- The minibar exists only in Deluxe apartments. Urban Studios do not
  have a minibar.
- The minibar is COMPLIMENTARY — guests can help themselves at no charge.
- We restock after checkout; no need for the guest to track usage.
`.trim();

export const EARLY_CHECKIN_FACTS = `
- Standard check-in time is 15:00.
- We can usually offer keys from 12:00 if the apartment is ready, but
  this is NOT guaranteed — the operator confirms on the day depending
  on the cleaning schedule.
- Never promise a specific earlier time without operator confirmation.
`.trim();

export const LATE_CHECKOUT_FACTS = `
- Standard checkout time is 10:30.
- Late checkout MAY be possible but depends on the next reservation and
  cleaning timing. The operator decides on the day.
- Never promise a specific later time without operator confirmation.
`.trim();

const FACTS_BY_CATEGORY: Record<Exclude<AutoReplyCategory, 'invoice-request' | 'other'>, string> = {
  parking: PARKING_FACTS,
  wifi: WIFI_FACTS,
  minibar: MINIBAR_FACTS,
  'early-checkin': EARLY_CHECKIN_FACTS,
  'late-checkout': LATE_CHECKOUT_FACTS,
};

export function getFactsForCategory(category: AutoReplyCategory): string | null {
  if (category === 'invoice-request' || category === 'other') return null;
  return FACTS_BY_CATEGORY[category] ?? null;
}

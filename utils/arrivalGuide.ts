/**
 * The arrival guide — the few things a guest actually needs on the way in:
 * which apartment, where it is, where the keys are, which parking space, WiFi.
 *
 * Deliberately short. A guest reading this on a phone half an hour before
 * arrival will not scroll, so every line has to earn its place; the long-form
 * version belongs in the welcome sheet, not in a chat message.
 *
 * Beds24 sends a version of this as an auto action, but auto actions are
 * batch-processed ('Immediate' only makes the booking *eligible*; a later
 * cycle sends it) and the v2 API exposes no way to fire one. A guest who
 * books at 14:00 for the same night gets it too late to use. This module is
 * how the operator sends it by hand, straight away.
 *
 * Every fact here comes from data/ai-knowledge-base.md and
 * utils/autoReplyFacts.ts — the same source the auto-reply drafter is
 * grounded on. Change the facts there and here together.
 *
 * Channel-agnostic: the Beds24 chat composer flattens it to text
 * (arrivalGuideToText), the Email Guest modal feeds the lines through the
 * branded HTML shell (arrivalGuideToBlocks + renderArrivalGuideEmail).
 */

import { PARKING_SPACES } from '@/utils/parkingUtils';

export type GuideLang = 'cs' | 'en';

export interface ArrivalGuide {
  greeting: string;
  /** One fact per line, each already carrying its own emoji marker. */
  lines: string[];
  signOff: string;
}

/** room -> its permanently assigned space, derived so there's no second copy
 *  of the mapping to keep in sync. */
const SPACE_BY_ROOM: Record<string, string> = Object.fromEntries(
  PARKING_SPACES.filter((p) => p.permanentRoom).map((p) => [p.permanentRoom as string, p.space]),
);

/** Which building a room sits in — guests walk themselves over from reception. */
function buildingOf(room: string): string {
  return room.startsWith('O.') ? 'Ottův dům' : 'Karlův dům';
}

/**
 * The physical rooms inside a (possibly combined) room label —
 * "K.202 + K.203" -> ["K.202", "K.203"]. A label we hold no space for (a
 * virtual room type, a booking still unallocated) yields an empty list, and
 * the guide then promises the specifics instead of inventing a space number.
 */
function physicalRooms(room?: string): string[] {
  if (!room) return [];
  return room
    .split('+')
    .map((r) => r.trim())
    .filter((r) => r in SPACE_BY_ROOM);
}

/** WiFi follows the room code: K.201 -> Apartment_K201 / Bakerhouse@K201. */
function wifiFor(room: string): string {
  const code = room.replace('.', '');
  return `Apartment_${code} / Bakerhouse@${code}`;
}

/** Subject line. No guest name — the greeting inside already carries it, and
 *  Czech would need the vocative case to put it here without reading wrong. */
export const ARRIVAL_GUIDE_SUBJECT = (lang: GuideLang = 'en') =>
  lang === 'cs'
    ? 'Vše k Vašemu příjezdu — Baker House Apartments'
    : 'Everything for your arrival — Baker House Apartments';

export function buildArrivalGuide(args: {
  room?: string;
  guestFirstName?: string;
  lang: GuideLang;
}): ArrivalGuide {
  const cs = args.lang === 'cs';

  // A combined booking has its own space and its own network PER apartment.
  const rooms = physicalRooms(args.room);
  const buildings = Array.from(new Set(rooms.map(buildingOf)));
  const building = buildings.length === 1 ? buildings[0] : null;

  // The apartment ID leads — it's the first thing a guest needs to know and
  // the one fact none of the other lines imply.
  const apartmentLine = rooms.length
    ? `🏠 ${cs ? (rooms.length > 1 ? 'Apartmány' : 'Apartmán') : rooms.length > 1 ? 'Apartments' : 'Apartment'} ${rooms.join(' + ')}${building ? ` · ${building}` : ''}`
    : null;

  const parkingLine = (() => {
    const tail = cs
      ? 'vjezd do garáže je asi 20 m za hlavním vchodem (ne vrata hned vedle něj), max. výška 200 cm. Klíče si vyzvedněte dřív — je v nich čip, který vrata otevře.'
      : 'the garage gate is about 20 m past the main entrance (not the door right beside it), max height 200 cm. Collect the keys first — they include the chip that opens it.';
    if (rooms.length === 0) {
      return cs
        ? `🚗 Číslo parkovacího místa Vám pošleme před příjezdem — ${tail}`
        : `🚗 We'll send your parking space number before arrival — ${tail}`;
    }
    const spaces = rooms
      .map((r) => (rooms.length === 1 ? `${cs ? 'č. ' : '#'}${SPACE_BY_ROOM[r]}` : `${cs ? 'č. ' : '#'}${SPACE_BY_ROOM[r]} (${r})`))
      .join(cs ? ' a ' : ' and ');
    return cs
      ? `🚗 Parkování ${spaces}, podzemní garáž — ${tail}`
      : `🚗 Parking ${spaces}, underground garage — ${tail}`;
  })();

  const wifiLine = rooms.length
    ? `📶 WiFi: ${rooms.map((r) => (rooms.length === 1 ? wifiFor(r) : `${r} — ${wifiFor(r)}`)).join(' · ')}`
    : cs
      ? '📶 WiFi: název a heslo Vám pošleme před příjezdem.'
      : "📶 WiFi: we'll send the name and password before arrival.";

  return {
    greeting: args.guestFirstName
      ? cs
        ? `Dobrý den ${args.guestFirstName},`
        : `Hi ${args.guestFirstName},`
      : cs
        ? 'Dobrý den,'
        : 'Hello,',
    lines: [
      ...(apartmentLine ? [apartmentLine] : []),
      '📍 Bratislavská 946/82, 602 00 Brno · https://maps.app.goo.gl/9JywehHDff4exfWq8',
      // Early check-in is rate-dependent and the composer can't see the rate,
      // so the entitlement is stated conditionally rather than promised.
      cs
        ? '🔑 Klíče na recepci (24/7, stačí zazvonit). Check-in od 15:00 — od 13:00, pokud Vaše sazba zahrnuje early check-in.'
        : '🔑 Keys at reception (24/7, just ring the bell). Check-in from 15:00 — from 13:00 if your rate includes early check-in.',
      parkingLine,
      wifiLine,
    ],
    signOff: 'Patrik & Zuzana',
  };
}

/** The guide as one plain-text message — what the Beds24 chat composer sends. */
export function arrivalGuideToText(guide: ArrivalGuide): string {
  return [guide.greeting, '', ...guide.lines, '', guide.signOff].join('\n');
}

/**
 * The guide as blank-line-separated blocks for the email editor. Greeting and
 * sign-off are left out — the branded email shell renders its own.
 */
export function arrivalGuideToBlocks(guide: ArrivalGuide): string[] {
  return guide.lines;
}

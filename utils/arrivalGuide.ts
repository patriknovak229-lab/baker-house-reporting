/**
 * The arrival guide — everything a guest needs between "I've booked" and
 * "I'm inside the apartment": address, where the keys are, which gate is
 * actually the garage, WiFi, luggage.
 *
 * Beds24 sends this as an auto action, but auto actions are batch-processed
 * ('Immediate' only makes the booking *eligible*; a later cycle sends it) and
 * the v2 API exposes no way to fire one. A guest who books at 14:00 for the
 * same night therefore gets the details too late to use them. This module is
 * how the operator sends the same guide by hand, straight away.
 *
 * Every fact here is lifted from data/ai-knowledge-base.md and
 * utils/autoReplyFacts.ts — the same source the auto-reply drafter is
 * grounded on. Change the facts there and here together.
 *
 * Channel-agnostic on purpose: the Beds24 chat composer flattens it to text
 * (arrivalGuideToText), the Email Guest modal feeds the blocks through the
 * branded HTML shell (arrivalGuideToBlocks + renderArrivalGuideEmail).
 */

import { PARKING_SPACES } from '@/utils/parkingUtils';

export type GuideLang = 'cs' | 'en';

/** Only affects the closing line — "message us here" doesn't work in an email. */
export type GuideChannel = 'chat' | 'email';

export interface GuideSection {
  /** Emoji marker. Doubles as the heading detector in the email renderer. */
  icon: string;
  title: string;
  lines: string[];
}

export interface ArrivalGuide {
  greeting: string;
  intro: string;
  sections: GuideSection[];
  closing: string;
  signOff: string;
}

/** room -> its permanently assigned space, derived so there's no second copy
 *  of the mapping to keep in sync. */
const SPACE_BY_ROOM: Record<string, string> = Object.fromEntries(
  PARKING_SPACES.filter((p) => p.permanentRoom).map((p) => [p.permanentRoom as string, p.space]),
);

/** Which building a room sits in. Guests collect keys at reception and walk
 *  themselves over, so the guide has to name the right door. Czech needs the
 *  locative ("v Karlově domě"), English the plain name. */
function buildingOf(room: string): { cs: string; en: string } {
  return room.startsWith('O.')
    ? { cs: 'Ottově domě', en: 'Ottův dům' }
    : { cs: 'Karlově domě', en: 'Karlův dům' };
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
  channel: GuideChannel;
}): ArrivalGuide {
  const { lang, channel } = args;
  const cs = lang === 'cs';

  // A combined booking has its own space and its own network PER apartment,
  // so both read as lists.
  const rooms = physicalRooms(args.room);
  const buildings = Array.from(new Set(rooms.map((r) => buildingOf(r).en)));
  const building = buildings.length === 1 ? buildingOf(rooms[0]) : null;
  const wifiLines = rooms.map((r) =>
    rooms.length === 1 ? wifiFor(r) : `${r}: ${wifiFor(r)}`,
  );

  const spaces = cs
    ? rooms.map((r) => (rooms.length === 1 ? `č. ${SPACE_BY_ROOM[r]}` : `č. ${SPACE_BY_ROOM[r]} (${r})`))
    : rooms.map((r) => (rooms.length === 1 ? `#${SPACE_BY_ROOM[r]}` : `#${SPACE_BY_ROOM[r]} (${r})`));

  const parkingLead = (() => {
    if (rooms.length === 0) {
      return cs
        ? 'Parkujete v podzemní garáži, ve spodním podlaží blízko výtahů. Konkrétní číslo místa Vám pošleme před příjezdem.'
        : "You'll park in the underground garage, on the lower level close to the lifts. We'll send you your space number before arrival.";
    }
    if (rooms.length === 1) {
      return cs
        ? `Vaše rezervované místo je ${spaces[0]}, ve spodním podlaží garáže, blízko výtahů.`
        : `Your reserved space is ${spaces[0]}, on the lower level of the garage, close to the lifts.`;
    }
    return cs
      ? `Vaše rezervovaná místa jsou ${spaces.join(', ')} — ve spodním podlaží garáže, blízko výtahů.`
      : `Your reserved spaces are ${spaces.join(', ')} — on the lower level of the garage, close to the lifts.`;
  })();

  const greeting = args.guestFirstName
    ? cs
      ? `Dobrý den ${args.guestFirstName},`
      : `Hi ${args.guestFirstName},`
    : cs
      ? 'Dobrý den,'
      : 'Hello,';

  const sections: GuideSection[] = [
    {
      icon: '📍',
      title: cs ? 'ADRESA (pro GPS / taxi)' : 'ADDRESS (for GPS / taxi)',
      lines: [
        'Bratislavská 946/82, 602 00 Brno',
        'https://maps.app.goo.gl/9JywehHDff4exfWq8',
      ],
    },
    {
      icon: '🔑',
      title: cs ? 'KLÍČE A CHECK-IN' : 'KEYS & CHECK-IN',
      lines: [
        // The composer has no view of the booked rate, so the early-check-in
        // entitlement is stated conditionally rather than promised or denied.
        cs
          ? 'Check-in je od 15:00 (pokud Vaše sazba zahrnuje early check-in, apartmán je připravený už od 13:00).'
          : 'Check-in is from 15:00 (if your rate includes early check-in, the apartment is ready from 13:00).',
        cs
          ? 'Klíče si vyzvednete na recepci u hlavního vchodu do areálu — stačí zazvonit. Recepce je otevřená 24/7, takže pozdní ani noční příjezd není žádný problém a nepotřebujete žádné doklady ani registraci.'
          : 'Collect your keys at the reception by the main entrance of the complex — just ring the doorbell. Reception is staffed 24/7, so arriving late or at night is no problem, and no ID or registration is needed.',
        ...(building
          ? [
              cs
                ? `Váš apartmán je v ${building.cs}. Budovy jsou jasně označené a od recepce na ně uvidíte — je to jen pár kroků přes dvůr.`
                : `Your apartment is in ${building.en}. The buildings are clearly named and visible from reception — a short walk across the courtyard.`,
            ]
          : []),
      ],
    },
    {
      icon: '🚗',
      title: cs ? 'PARKOVÁNÍ (podzemní garáž)' : 'PARKING (underground garage)',
      lines: [
        parkingLead,
        cs
          ? 'Nejdřív si prosím vyzvedněte klíče na recepci — jejich součástí je čip, který otevírá vjezd do garáže. Na chvíli můžete zastavit přímo před recepcí.'
          : 'Please collect your keys at reception first — they include the chip that opens the garage gate. You can stop in front of reception for a minute or two while you do.',
        cs
          ? 'Vrata hned vedle hlavního vchodu jsou jen servisní vchod, ne garáž. Vjezd do garáže je na stejné straně, asi o 20 m dál po ulici — u vchodu se teď staví, takže od něj nemusí být vidět.'
          : 'The gate right beside the main entrance is only a service door, not the garage. The garage gate is on the same side, about 20 m further along the street — there is construction by the entrance, so it may not be visible from there.',
        cs
          ? 'Maximální výška vozidla je 200 cm. Při odjezdu se vrata otevřou automaticky, čip není potřeba.'
          : 'Maximum vehicle height is 200 cm. On the way out the gate opens automatically, no chip needed.',
        cs
          ? 'Zaparkovat můžete už od 13:00 v den příjezdu.'
          : 'You can park from 13:00 on arrival day.',
      ],
    },
    {
      icon: '📶',
      title: 'WIFI',
      lines:
        wifiLines.length > 0
          ? wifiLines
          : [
              cs
                ? 'Každý apartmán má vlastní síť — název a heslo Vám pošleme před příjezdem.'
                : "Each apartment has its own network — we'll send you the name and password before arrival.",
            ],
    },
    {
      icon: '🧳',
      title: cs ? 'ZAVAZADLA' : 'LUGGAGE',
      lines: [
        cs
          ? 'Přijedete dřív? Recepce Vám zavazadla obvykle uschová — stačí se zeptat (kapacita je omezená).'
          : 'Arriving before check-in? Reception can usually keep your bags — just ask (space is limited).',
      ],
    },
  ];

  return {
    greeting,
    intro: cs
      ? 'Posíláme vše, co budete k příjezdu potřebovat — už se na Vás těšíme!'
      : "Here's everything you need for your arrival — we're looking forward to having you!",
    sections,
    closing:
      channel === 'email'
        ? cs
          ? 'Kdyby cokoli, stačí odpovědět na tento e-mail.'
          : 'If anything comes up, just reply to this email.'
        : cs
          ? 'Kdyby cokoli, napište nám sem.'
          : 'If anything comes up, just message us here.',
    signOff: 'Patrik & Zuzana',
  };
}

/** The guide as one plain-text message — what the Beds24 chat composer sends. */
export function arrivalGuideToText(guide: ArrivalGuide): string {
  return [
    guide.greeting,
    '',
    guide.intro,
    '',
    ...guide.sections.flatMap((s) => [`${s.icon} ${s.title}`, ...s.lines, '']),
    guide.closing,
    guide.signOff,
  ].join('\n');
}

/**
 * The guide as blank-line-separated blocks for the email editor. Greeting and
 * sign-off are left out — the branded email shell renders its own.
 */
export function arrivalGuideToBlocks(guide: ArrivalGuide): string[] {
  return [
    guide.intro,
    ...guide.sections.map((s) => [`${s.icon} ${s.title}`, ...s.lines].join('\n')),
    guide.closing,
  ];
}

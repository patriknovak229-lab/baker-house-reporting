/**
 * Auto-reply templates per category. Each template is authored in English
 * with `{PLACEHOLDERS}` and translated to the guest's detected language
 * via utils/googleTranslate.ts. Placeholders are substituted AFTER
 * translation so literal values (space numbers, room names, wifi creds)
 * never get mangled by the translator.
 *
 * All replies are signed "— Zuzana" at the end. The signature is appended
 * after substitution so it stays untranslated (proper noun).
 */

import type { Reservation } from '@/types/reservation';
import type { AutoReplyCategory } from '@/utils/messageAutoReplyDetector';
import type { ParkingResult } from '@/utils/parkingUtils';
import { PARKING_SPACES } from '@/utils/parkingUtils';
import { roomToCategory } from '@/utils/roomCategory';
import { translateText } from '@/utils/googleTranslate';

const SIGN_OFF = '\n\n— Zuzana';

/**
 * Build the EN template text for a category with substitutions ready to
 * apply. Returns `null` when this reservation+category combination
 * shouldn't be auto-replied (e.g. minibar question from an Urban guest).
 *
 * Output structure: { template, substitutions } so the caller can
 * translate `template` then substitute literal values.
 */
export interface BuiltTemplate {
  /** EN template text containing `{TOKEN}` placeholders. */
  template: string;
  /** Map of `TOKEN → literal value` to substitute AFTER translation. */
  substitutions: Record<string, string>;
}

export function buildTemplate(
  category: Exclude<AutoReplyCategory, 'other' | 'invoice-request'>,
  reservation: Reservation,
  parking: ParkingResult,
): BuiltTemplate | null {
  switch (category) {
    case 'parking':
      return buildParkingTemplate(reservation, parking);
    case 'wifi':
      return buildWifiTemplate(reservation);
    case 'minibar':
      return buildMinibarTemplate(reservation);
    case 'early-checkin':
      return buildEarlyCheckinTemplate();
    case 'late-checkout':
      return buildLateCheckoutTemplate();
  }
}

// ─── Parking ─────────────────────────────────────────────────────────────────

function buildParkingTemplate(
  reservation: Reservation,
  parking: ParkingResult,
): BuiltTemplate | null {
  const assignment = parking.byReservation.get(reservation.reservationNumber);

  // Manual "no parking" → tell the guest honestly.
  if (reservation.parkingOverride === 'none') {
    return {
      template:
        'Hi {NAME}! Unfortunately parking is not included with your reservation. ' +
        'There is paid public parking available nearby at Park Parkoviště (Bratislavská).',
      substitutions: {
        NAME: reservation.firstName || 'there',
      },
    };
  }

  // No assignment computed yet AND no manual override = no permanent space
  // (e.g. a temporary holding state). Fall back to "we'll confirm" rather
  // than guessing.
  if (!assignment) {
    return {
      template:
        'Hi {NAME}! Let me confirm your parking arrangement and get back to you shortly.',
      substitutions: { NAME: reservation.firstName || 'there' },
    };
  }

  const ps = PARKING_SPACES.find((p) => p.space === assignment.space);
  const subLevel = ps?.subLevel ?? -1;

  return {
    template:
      'Hi {NAME}! Your parking space is number {SPACE} on sub-level {SUBLEVEL} of the underground garage at Bratislavská 82. ' +
      'You can drive in directly — the entrance opens automatically when you approach.',
    substitutions: {
      NAME: reservation.firstName || 'there',
      SPACE: assignment.space,
      SUBLEVEL: String(subLevel),
    },
  };
}

// ─── WiFi ────────────────────────────────────────────────────────────────────

function buildWifiTemplate(reservation: Reservation): BuiltTemplate {
  // Collect every physical room covered by this reservation (multi-unit
  // package bookings: e.g. Twin Apartments K.202 + K.203). The template
  // includes credentials for all of them.
  const rooms = new Set<string>();
  if (reservation.room) rooms.add(reservation.room);
  for (const lr of reservation.linkedRooms ?? []) rooms.add(lr);

  const list = [...rooms].sort();
  const creds = list
    .map((room) => {
      const slug = room.replace(/\./g, ''); // K.102 → K102
      return `${room} — network "Apartment_${slug}", password "Bakerhouse@${slug}"`;
    })
    .join('\n');

  // Multi-room vs single-room phrasing
  if (list.length > 1) {
    return {
      template:
        'Hi {NAME}! Your apartments have their own WiFi networks:\n\n{CREDS}\n\nLet me know if you have any trouble connecting.',
      substitutions: {
        NAME: reservation.firstName || 'there',
        CREDS: creds,
      },
    };
  }
  return {
    template:
      'Hi {NAME}! Here are your WiFi details:\n\n{CREDS}\n\nLet me know if you have any trouble connecting.',
    substitutions: {
      NAME: reservation.firstName || 'there',
      CREDS: creds,
    },
  };
}

// ─── Minibar ─────────────────────────────────────────────────────────────────

function buildMinibarTemplate(reservation: Reservation): BuiltTemplate | null {
  // Minibar only exists in Deluxe apartments. For Urban units we return
  // null so the caller treats it as "other" → no auto-reply → operator
  // handles. The detector should rarely fire on Urban guests anyway,
  // but this is a defence in depth.
  const cat = roomToCategory(reservation.room);
  if (cat !== 'Deluxe') return null;

  return {
    template:
      'Hi {NAME}! Your apartment has a minibar stocked with drinks and snacks — and the good news is it is complimentary, our gift to you. Help yourself and enjoy. ' +
      'No need to keep track of what you used; we will restock after you check out.',
    substitutions: {
      NAME: reservation.firstName || 'there',
    },
  };
}

// ─── Early check-in ──────────────────────────────────────────────────────────

function buildEarlyCheckinTemplate(): BuiltTemplate {
  return {
    template:
      'Hi {NAME}! Thank you for letting me know. I will check whether early check-in is possible for your arrival day and confirm as soon as I can.',
    substitutions: {
      NAME: '{NAME}', // placeholder kept for caller to fill via firstName
    },
  };
}

// ─── Late checkout ───────────────────────────────────────────────────────────

function buildLateCheckoutTemplate(): BuiltTemplate {
  return {
    template:
      'Hi {NAME}! Thank you for asking. I will check whether late checkout is possible on your departure day and confirm as soon as I can.',
    substitutions: {
      NAME: '{NAME}',
    },
  };
}

// ─── Translation + substitution pipeline ─────────────────────────────────────

/**
 * Render a built template into a final outgoing message in the guest's
 * detected language. Translation happens BEFORE substitution so literal
 * values stay untouched. The "— Zuzana" sign-off is appended last,
 * outside translation, so the proper noun stays as written.
 *
 * Falls back to the English template (with substitutions) if translation
 * fails or the guest's language is unknown / English.
 */
export async function renderAutoReply(
  built: BuiltTemplate,
  firstName: string,
  language: string,
): Promise<string> {
  // Always fill the NAME slot from `firstName` BEFORE translation so the
  // name flows naturally in the translated sentence ("Ahoj Jano!" not
  // "Ahoj {NAME}!"). All other slots stay as `{TOKEN}` and are filled
  // AFTER translation.
  const subsWithName = {
    ...built.substitutions,
    NAME: firstName || built.substitutions.NAME || 'there',
  };

  let templateForTranslate = built.template.replace(
    /\{NAME\}/g,
    subsWithName.NAME,
  );

  // Translate only when the guest's language is set and not already English
  const lang = (language || '').toLowerCase();
  if (lang && lang !== 'en') {
    try {
      const result = await translateText(templateForTranslate, lang);
      if (result?.translatedText) {
        templateForTranslate = result.translatedText;
      }
    } catch (err) {
      console.warn(
        '[autoReplyTemplates] translation failed, falling back to EN:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Substitute remaining literal tokens (SPACE, SUBLEVEL, CREDS, ...).
  // We do this AFTER translation so they're never mangled by the translator.
  let final = templateForTranslate;
  for (const [token, value] of Object.entries(subsWithName)) {
    if (token === 'NAME') continue; // already inlined
    final = final.replace(new RegExp(`\\{${token}\\}`, 'g'), value);
  }

  return final + SIGN_OFF;
}

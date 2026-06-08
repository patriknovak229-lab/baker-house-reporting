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
import type { AutoReplyCategory, ParkingIntent } from '@/utils/messageAutoReplyDetector';
import type { ParkingResult } from '@/utils/parkingUtils';
import { PARKING_SPACES } from '@/utils/parkingUtils';
import { roomToCategory } from '@/utils/roomCategory';
import { translateText } from '@/utils/googleTranslate';
import { formalGreeting } from '@/utils/greeting';

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
  parkingIntent: ParkingIntent = 'general',
): BuiltTemplate | null {
  switch (category) {
    case 'parking':
      return buildParkingTemplate(reservation, parking, parkingIntent);
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
  intent: ParkingIntent = 'general',
): BuiltTemplate | null {
  // Specific parking sub-cases (EV, early/late parking, taken spot, extra
  // space) get their own fixed denial/holding replies and don't depend on
  // the assigned space. Only 'general' falls through to the space-assignment
  // logic below.
  if (intent !== 'general') {
    return buildParkingSubIntentTemplate(reservation, intent);
  }

  const assignment = parking.byReservation.get(reservation.reservationNumber);

  // Manual "no parking" → tell the guest honestly.
  if (reservation.parkingOverride === 'none') {
    return {
      template:
        '{NAME}! Unfortunately parking is not included with your reservation. ' +
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
        '{NAME}! Let me confirm your parking arrangement and get back to you shortly.',
      substitutions: { NAME: reservation.firstName || 'there' },
    };
  }

  const ps = PARKING_SPACES.find((p) => p.space === assignment.space);
  const subLevel = ps?.subLevel ?? -1;

  return {
    template:
      '{NAME}! Your parking space is number {SPACE} on sub-level {SUBLEVEL} of the underground garage at Bratislavská 82, close to the elevators up to the apartments.\n\n' +
      'Before entering the garage, please stop at reception first to pick up your keys — they include the chip that opens the garage door. You can park briefly in front of the entrance while you collect them (1–2 minutes).\n\n' +
      'Note that the entrance to the underground parking is NOT the first gate next to the main entrance — that is a service/emergency door. Use the gate next to it, approximately 20 metres from the reception door.',
    substitutions: {
      NAME: reservation.firstName || 'there',
      SPACE: assignment.space,
      SUBLEVEL: String(subLevel),
    },
  };
}

/**
 * Fixed replies for the specific parking sub-cases. These are short policy
 * answers that don't depend on the assigned space, so they short-circuit
 * the space-assignment logic. Authored EN with a {NAME} slot; greeting +
 * "— Zuzana" are added by renderAutoReply, and the body is translated.
 */
function buildParkingSubIntentTemplate(
  reservation: Reservation,
  intent: Exclude<ParkingIntent, 'general'>,
): BuiltTemplate {
  const NAME = reservation.firstName || 'there';
  switch (intent) {
    case 'ev':
      return {
        template: "{NAME}! Unfortunately EV charging isn't available in our garage.",
        substitutions: { NAME },
      };
    case 'early':
      return {
        template:
          "{NAME}! I'm sorry, but earlier parking isn't possible. You're welcome to park your car once your check-in begins.",
        substitutions: { NAME },
      };
    case 'late':
      return {
        template:
          "{NAME}! I'm sorry, but we're not able to keep cars in the garage after checkout. We'd kindly ask you to manage around the checkout time - 10:30.",
        substitutions: { NAME },
      };
    case 'taken':
      return {
        template:
          '{NAME}! I\'m sorry about that. For now please park in any free space marked "Baker House Apartments", and keep your phone reachable — I\'ll be in touch to sort it out.',
        substitutions: { NAME },
      };
    case 'multiple':
      return {
        template:
          "{NAME}! I'm sorry, but each apartment has exactly one parking space assigned to it, so we're unable to offer a second one.",
        substitutions: { NAME },
      };
  }
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
        '{NAME}! Your apartments have their own WiFi networks:\n\n{CREDS}\n\nLet me know if you have any trouble connecting.',
      substitutions: {
        NAME: reservation.firstName || 'there',
        CREDS: creds,
      },
    };
  }
  return {
    template:
      '{NAME}! Here are your WiFi details:\n\n{CREDS}\n\nLet me know if you have any trouble connecting.',
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
      '{NAME}! Your apartment has a minibar stocked with drinks and snacks — and the good news is it is complimentary, our gift to you. Help yourself and enjoy. ' +
      'No need to keep track of what you used; we will restock after you check out.',
    substitutions: {
      NAME: reservation.firstName || 'there',
    },
  };
}

// ─── Early check-in ──────────────────────────────────────────────────────────

/**
 * Operator policy (2026-05-24): early check-ins are never guaranteed —
 * coordinating them in real time around cleanings creates more problems
 * than they solve. The standard offer is:
 *   - Keys available from reception after 12:00
 *   - Car can be parked in the garage at the same time
 *   - We notify the guest when the apartment itself is ready
 *
 * The auto-reply is self-contained — guest gets a useful answer
 * immediately. The "notify when ready" follow-up is captured as a red
 * task on the reservation so the operator doesn't forget the ping.
 */
function buildEarlyCheckinTemplate(): BuiltTemplate {
  return {
    template:
      '{NAME}! We can’t guarantee the apartment will be ready before 15:00, but we’ll let you know as soon as it is. In the meantime, you’re welcome to collect your keys at reception from 12:00 and park in the garage if needed.',
    substitutions: {
      NAME: '{NAME}', // placeholder kept for caller to fill via firstName
    },
  };
}

// ─── Late checkout ───────────────────────────────────────────────────────────

/**
 * Operator policy (2026-05-24): checkout up to 10:30 is always fine —
 * confirm immediately. Anything later depends on the next arrival and
 * the cleaning schedule, so we promise to confirm on the day rather
 * than commit. Both cases get the same message — it's accurate either
 * way and keeps the reply tight. The lateCheckout task is created so
 * the operator handles the "anything past 11" decision on departure day.
 */
function buildLateCheckoutTemplate(): BuiltTemplate {
  return {
    template:
      '{NAME}! Checkout by 10:30 is always fine. For anything later we’ll confirm on the day based on the next arrival.',
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

  // Prepend the formal greeting OUTSIDE the translated body. We tried a
  // {{GREETING}} placeholder inside the template (substituted post-
  // translation) but Google Translate `format: 'text'` decided to
  // translate the word inside the braces — Czech runs ended up shipping
  // literal "{{ZDRAV}}" to guests. Keeping the greeting out of the
  // translation entirely is the only reliable fix. The trailing
  // exclamation on `{NAME}!` stays in-body so vocative inflection
  // (Andrea → Andreo in Czech etc.) still works naturally.
  return `${formalGreeting(language)} ${final}${SIGN_OFF}`;
}

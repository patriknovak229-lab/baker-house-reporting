/**
 * POST /api/auto-reply-log/test
 *
 * "Test a guest message" for the auto-reply log page. Runs a made-up guest
 * message through the same steps as the live webhook — category + language
 * detection, urgency, the post-booking contact capture, the AI composer
 * (knowledge base + booking facts) and the Google translation — against a
 * fictional booking the operator describes in the form.
 *
 * Nothing is sent to Beds24 and nothing is written (no log, no overrides, no
 * Redis): it only calls Claude and Google Translate. Admin/super only because
 * every call costs API credits.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAccess } from '@/utils/authGuard';
import { detectAutoReplyCategory } from '@/utils/messageAutoReplyDetector';
import { composeAiReply } from '@/utils/aiReplyComposer';
import { translateReplyToGuest } from '@/utils/translateReply';
import { assessUrgency } from '@/utils/urgentMessage';
import { extractGuestContact } from '@/utils/guestContactExtractor';
import { contactLang, renderThanks } from '@/utils/guestContact';
import { readAutoSendCategories } from '@/data-access/autoSendCategories';
import type { Reservation } from '@/types/reservation';
import type { ParkingAssignment } from '@/utils/parkingUtils';

// Same threshold as the webhook's auto-send gate.
const CONFIDENCE_THRESHOLD = 0.8;

interface TestBody {
  message?: string;
  firstName?: string;
  nationality?: string;
  room?: string;
  parkingSpace?: string;
  checkIn?: string;
  checkOut?: string;
  earlyCheckIn?: boolean;
  lateCheckout?: boolean;
  /** Our phone/car question was already sent → try the contact capture first. */
  contactAsked?: boolean;
}

const str = (v: unknown, d: string, max = 60) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : d;

export async function POST(req: NextRequest) {
  const guard = await requireAccess('autoReply', 'change');
  if ('error' in guard) return guard.error;

  const body = (await req.json().catch(() => ({}))) as TestBody;
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 3000) : '';
  if (!message) return NextResponse.json({ error: 'Write a guest message first.' }, { status: 400 });

  const nationality = str(body.nationality, 'CZ', 2).toUpperCase();
  const detection = await detectAutoReplyCategory(message);
  const urgency = assessUrgency(message, detection);
  const lang = detection.language || 'cs';
  const translate = async (text: string) =>
    lang.toLowerCase() === 'cs' ? text : translateReplyToGuest(text, lang);

  // ── Contact capture (only when our question was already asked) ───────────
  let contact: Record<string, unknown> | null = null;
  if (body.contactAsked) {
    const ex = await extractGuestContact({ message, askedPhone: true, guestCountry: nationality });
    const captured = Boolean(ex.phone || ex.car);
    const thankYou =
      captured && ex.onlyContactInfo && !urgency.urgent
        ? renderThanks({
            lang: contactLang(lang),
            phone: ex.phone ?? undefined,
            parking: ex.car ? { status: ex.car === 'no' ? 'no-car' : 'car', plate: ex.plate ?? undefined } : undefined,
            confirmParking: ex.parkingRequest,
          })
        : null;
    contact = { extracted: ex, thankYou };
    if (thankYou) {
      // Production stops here: the thank-you goes out automatically, no AI draft.
      return NextResponse.json({
        detection,
        urgency,
        contact,
        outcome: 'contact-thanks',
        outcomeText: 'Contact details captured — this automatic thank-you is sent, no AI draft and no review.',
      });
    }
  }

  // ── AI draft against the fictional booking ───────────────────────────────
  const room = str(body.room, 'K.106', 10);
  const reservation = {
    firstName: str(body.firstName, 'Jan'),
    lastName: '',
    nationality,
    room,
    linkedRooms: [],
    checkInDate: str(body.checkIn, '', 10) || undefined,
    checkOutDate: str(body.checkOut, '', 10) || undefined,
  } as unknown as Reservation;
  const space = str(body.parkingSpace, '', 10);
  const parkingSpaces = (space ? [{ space, room }] : []) as unknown as ParkingAssignment[];

  const composed = await composeAiReply({
    guestMessage: message,
    reservation,
    parkingSpaces,
    perks: { earlyCheckIn: !!body.earlyCheckIn, lateCheckout: !!body.lateCheckout },
    history: [],
    language: lang,
  });
  const draftCs = composed.draftText;

  let translated: string | null = null;
  let translateError: string | null = null;
  if (draftCs && lang.toLowerCase() !== 'cs') {
    try {
      translated = await translate(draftCs);
    } catch (err) {
      translateError = err instanceof Error ? err.message : String(err);
    }
  }

  // What the live webhook would do with this draft.
  let autoSendEnabled = false;
  try {
    autoSendEnabled = (await readAutoSendCategories()).includes(detection.category);
  } catch {
    /* treat as review */
  }
  let outcome: string;
  let outcomeText: string;
  if (!draftCs) {
    outcome = 'skip';
    outcomeText = 'No reply — the AI decided there is nothing to answer (or the call failed).';
  } else if (urgency.urgent) {
    outcome = 'review';
    outcomeText = `Urgent (${urgency.labels.join(', ') || 'classifier'}) — Telegram alert + review queue, never auto-sent.`;
  } else if (detection.category === 'other') {
    outcome = 'review';
    outcomeText = "Category 'other' — always goes to the review queue.";
  } else if (detection.confidence < CONFIDENCE_THRESHOLD) {
    outcome = 'review';
    outcomeText = `Low confidence (${detection.confidence}) — review queue.`;
  } else if (autoSendEnabled) {
    outcome = 'auto-send';
    outcomeText = `Category '${detection.category}' has Auto-send ON — this would be sent without review (unless you wrote to the guest in the last 24 h).`;
  } else {
    outcome = 'review';
    outcomeText = `Category '${detection.category}' is on Review — this draft waits for your approval.`;
  }

  return NextResponse.json({
    detection,
    urgency,
    contact,
    draftCs,
    translated,
    translateError,
    model: composed.model,
    outcome,
    outcomeText,
  });
}

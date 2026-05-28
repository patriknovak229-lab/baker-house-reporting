/**
 * GET /api/auto-reply-preview
 *
 * Admin-only preview endpoint that renders an auto-reply template the
 * exact same way the production webhook would — including the Google
 * Translate round-trip and post-translation greeting prepend — without
 * actually sending anything to a guest. Use it to sanity-check template
 * changes (e.g. confirm the {{GREETING}} → "Dobrý den" fix actually
 * lands correctly in Czech / German / Polish / etc.).
 *
 * Query params:
 *   category    parking | wifi | minibar | early-checkin | late-checkout |
 *               invoice-confirmation | invoice-missing
 *   name        guest's first name (default "Andrea")
 *   lang        ISO-639-1 code (default "cs")
 *   room        physical room name for wifi (default "K.202")
 *
 * Returns plain text — the exact string that would be POSTed to Beds24.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import {
  buildTemplate,
  renderAutoReply,
} from '@/utils/messageAutoReplyTemplates';
import {
  renderInvoiceConfirmation,
  renderMissingFieldsReply,
  type InvoiceMandatory,
} from '@/utils/invoiceReplyTemplates';
import type { Reservation, Room } from '@/types/reservation';
import type { AutoReplyCategory } from '@/utils/messageAutoReplyDetector';

const PREVIEW_CATEGORIES = [
  'parking',
  'wifi',
  'minibar',
  'early-checkin',
  'late-checkout',
  'invoice-confirmation',
  'invoice-missing',
] as const;
type PreviewCategory = (typeof PREVIEW_CATEGORIES)[number];

export async function GET(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const sp = req.nextUrl.searchParams;
  const category = (sp.get('category') ?? 'parking') as PreviewCategory;
  const firstName = sp.get('name') ?? 'Andrea';
  const language = sp.get('lang') ?? 'cs';
  const room = (sp.get('room') ?? 'K.202') as Room;

  if (!PREVIEW_CATEGORIES.includes(category)) {
    return NextResponse.json(
      {
        error: `Unknown category. Expected one of: ${PREVIEW_CATEGORIES.join(', ')}`,
      },
      { status: 400 },
    );
  }

  try {
    let rendered = '';
    if (category === 'invoice-confirmation') {
      rendered = await renderInvoiceConfirmation(
        firstName,
        'example@company.cz',
        '2026-06-15',
        language,
      );
    } else if (category === 'invoice-missing') {
      const missing: InvoiceMandatory[] = ['companyName', 'ico'];
      rendered = await renderMissingFieldsReply(firstName, missing, language);
    } else {
      // Parking / wifi / minibar / early-checkin / late-checkout
      const reservation = mockReservation(firstName, room);
      const parking = mockParkingResult(reservation);
      const built = buildTemplate(
        category as Exclude<AutoReplyCategory, 'other' | 'invoice-request'>,
        reservation,
        parking,
      );
      if (!built) {
        return NextResponse.json(
          { error: `No template applies for category ${category} on room ${room}` },
          { status: 400 },
        );
      }
      rendered = await renderAutoReply(built, firstName, language);
    }

    return new NextResponse(rendered, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function mockReservation(firstName: string, room: Room): Reservation {
  return {
    reservationNumber: 'BH-PREVIEW',
    isBlackout: false,
    firstName,
    lastName: '',
    channel: 'Direct',
    room,
    checkInDate: '2026-06-10',
    checkOutDate: '2026-06-15',
    reservationDate: '',
    bookingTimestamp: '',
    numberOfNights: 5,
    numberOfGuests: 2,
    email: '',
    phone: '',
    price: 0,
    nationality: '',
    cleaningStatus: 'Pending',
    paymentStatus: 'Unpaid',
    amountPaid: 0,
    commissionAmount: 0,
    paymentChargeAmount: 0,
    additionalEmail: '',
    paymentStatusOverride: null,
    notes: '',
    manualFlagOverrides: {},
    ratingStatus: 'none',
    invoiceData: null,
    invoiceStatus: 'Not Issued',
  };
}

function mockParkingResult(reservation: Reservation) {
  return {
    byReservation: new Map([
      [reservation.reservationNumber, { space: '167', type: 'auto' as const }],
    ]),
    grid: new Map(),
  };
}

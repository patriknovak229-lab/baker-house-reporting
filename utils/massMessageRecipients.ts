/**
 * Mass guest messaging — recipient resolution.
 *
 * Pure, dependency-free (type-only Reservation import) so the exact same logic
 * runs client-side for the live preview in MassMessageModal AND server-side in
 * app/api/messages/broadcast/route.ts for the authoritative send. Keeping them
 * on one function guarantees the operator's preview matches what actually ships.
 *
 * Channel model:
 *   - Booking.com / Airbnb  → Beds24 chat (the only channel with a real inbox).
 *   - Direct / Direct-Web / Direct-Phone → email (no chat channel exists), when
 *     `emailDirect` is on and a real guest email is on file; otherwise unreachable.
 */
import type { Reservation } from '@/types/reservation';

export type Segment = 'staying' | 'arriving' | 'leaving';
export type Delivery = 'chat' | 'email' | 'unreachable';
export type UnreachableReason = 'no-email' | 'email-disabled' | 'bad-booking-id';

export interface ResolveOptions {
  segment: Segment;
  /** Window size for 'arriving' / 'leaving'. 'arriving' = (today, today+days]
   *  — today's arrivals belong to 'staying'. 'leaving' = [today, today+days]. */
  days: number;
  /** When true, direct-booking guests with an email on file are emailed. */
  emailDirect: boolean;
  /** 'YYYY-MM-DD' — compute once with pragueToday() so client + server agree. */
  today: string;
}

export interface ResolvedRecipient {
  reservationNumber: string;
  /** Beds24 booking id for chat sends; null for email/unreachable. */
  bookingId: number | null;
  name: string;
  room: string;
  channel: Reservation['channel'];
  checkInDate: string;
  checkOutDate: string;
  delivery: Delivery;
  /** Present only when delivery === 'email'. */
  email?: string;
  /** Present only when delivery === 'unreachable'. */
  reason?: UnreachableReason;
}

export interface RecipientCounts {
  chat: number;
  email: number;
  unreachable: number;
  /** All matched recipients (chat + email + unreachable). */
  total: number;
}

/** Today's date in Europe/Prague as 'YYYY-MM-DD'. Re-exported from periodUtils
 *  (the shared date-utils home) so callers importing it from here keep working. */
export { pragueToday } from '@/utils/periodUtils';

/** Add `n` days to a 'YYYY-MM-DD' date. UTC math keeps it DST-safe (the input
 *  carries no time-of-day, so there is no wall-clock ambiguity). */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Best guest email: operator-captured real email → invoice billing email →
 *  raw Beds24 email. Returns '' when none is usable. */
function pickEmail(r: Reservation): string {
  const candidates = [r.additionalEmail, r.invoiceData?.billingEmail, r.email];
  for (const c of candidates) {
    const v = (c ?? '').trim();
    if (v) return v;
  }
  return '';
}

/** Whether a reservation falls inside the chosen segment window. Dates are
 *  compared as 'YYYY-MM-DD' strings (lexical order == chronological order). */
function inSegment(r: Reservation, opts: ResolveOptions): boolean {
  const { segment, today } = opts;
  if (segment === 'staying') {
    // Checkout-EXCLUSIVE ("here tonight"): mid-stay guests + today's check-INs
    // (on-property all afternoon/night). Today's check-OUTs are dropped — they
    // leave in the morning, so a notice is redundant; reach them via 'leaving'
    // (days: 0). This intentionally undercounts vs the room grid by same-day departures.
    return r.checkInDate <= today && r.checkOutDate > today;
  }
  const span = Math.max(0, Math.floor(opts.days));
  const end = addDays(today, span);
  if (segment === 'arriving') {
    // Strictly FUTURE arrivals (from tomorrow). Today's arrivals already belong
    // to 'staying', so exclude them here to keep the two segments disjoint.
    return r.checkInDate > today && r.checkInDate <= end;
  }
  // leaving — check-outs from today (inclusive) through today+days
  return r.checkOutDate >= today && r.checkOutDate <= end;
}

/** Drop blackouts, cancellations, non-arrivals, refunds, and synthetic
 *  (non-BH-) rows. Mirrors the active-stay filter in OccupancyCalendar's
 *  findActiveRes so broadcasts never hit a block or a departed booking. */
function isExcluded(r: Reservation): boolean {
  return (
    Boolean(r.isBlackout) ||
    Boolean(r.isCancelled) ||
    Boolean(r.nonArrival) ||
    r.paymentStatus === 'Refunded' ||
    !r.reservationNumber.startsWith('BH-')
  );
}

function classify(
  r: Reservation,
  emailDirect: boolean,
): { delivery: Delivery; bookingId: number | null; email?: string; reason?: UnreachableReason } {
  const isOTA = r.channel === 'Booking.com' || r.channel === 'Airbnb';
  if (isOTA) {
    const bookingId = parseInt(r.reservationNumber.slice(3), 10);
    if (!Number.isFinite(bookingId)) {
      return { delivery: 'unreachable', bookingId: null, reason: 'bad-booking-id' };
    }
    return { delivery: 'chat', bookingId };
  }
  // Direct / Direct-Web / Direct-Phone — no Beds24 chat channel.
  if (!emailDirect) {
    return { delivery: 'unreachable', bookingId: null, reason: 'email-disabled' };
  }
  const email = pickEmail(r);
  if (email && isValidEmail(email)) {
    return { delivery: 'email', bookingId: null, email };
  }
  return { delivery: 'unreachable', bookingId: null, reason: 'no-email' };
}

/**
 * Resolve the recipients for a segment. Excluded and out-of-window rows are
 * dropped; the rest are classified into chat / email / unreachable. Dedup:
 *   - identical rows sharing a reservationNumber → once,
 *   - same Beds24 chat booking id → once,
 *   - same email address (a guest holding two direct bookings) → one email.
 * Combos are already single merged rows upstream, so this is mostly a safety net.
 */
export function resolveRecipients(
  reservations: Reservation[],
  opts: ResolveOptions,
): ResolvedRecipient[] {
  const out: ResolvedRecipient[] = [];
  const seenBooking = new Set<string>();
  const seenChat = new Set<number>();
  const seenEmail = new Set<string>();

  for (const r of reservations) {
    if (isExcluded(r) || !inSegment(r, opts)) continue;
    if (seenBooking.has(r.reservationNumber)) continue;

    const c = classify(r, opts.emailDirect);
    if (c.delivery === 'chat' && c.bookingId != null) {
      if (seenChat.has(c.bookingId)) continue;
      seenChat.add(c.bookingId);
    } else if (c.delivery === 'email' && c.email) {
      const key = c.email.toLowerCase();
      if (seenEmail.has(key)) continue;
      seenEmail.add(key);
    }

    seenBooking.add(r.reservationNumber);
    out.push({
      reservationNumber: r.reservationNumber,
      bookingId: c.bookingId,
      name: `${r.firstName} ${r.lastName}`.trim() || r.reservationNumber,
      room: r.room,
      channel: r.channel,
      checkInDate: r.checkInDate,
      checkOutDate: r.checkOutDate,
      delivery: c.delivery,
      email: c.email,
      reason: c.reason,
    });
  }

  return out;
}

export function tallyRecipients(recipients: ResolvedRecipient[]): RecipientCounts {
  let chat = 0;
  let email = 0;
  let unreachable = 0;
  for (const r of recipients) {
    if (r.delivery === 'chat') chat++;
    else if (r.delivery === 'email') email++;
    else unreachable++;
  }
  return { chat, email, unreachable, total: recipients.length };
}

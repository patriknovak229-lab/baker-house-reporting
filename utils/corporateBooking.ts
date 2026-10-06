/**
 * Corporate stays ↔ Beds24 bookings (server-side).
 *
 * Builds the booking a stay becomes, reads Beds24's batch reply back onto the
 * stays, and resolves a booking's group (master + physical sub-bookings) so
 * guest edits and cancellations reach every record Beds24 keeps for one stay.
 *
 * WHY THE BOOKING IS POSTED ON THE SELLABLE ROOM ID WITH checkAvailability
 * ------------------------------------------------------------------------
 * The agreement names room TYPES ("1KK Urban or Deluxe"), and Beds24 already
 * allocates API bookings on a type to a free physical unit — the same path
 * the manual New Booking form uses. `checkAvailability` makes Beds24 refuse a
 * stay that has no availability instead of saving an overbooking; such a stay
 * comes back as `failed` with the reason and can be retried on another type.
 * A stay Beds24 accepts but cannot fit into ONE unit lands unallocated, which
 * the Transactions room-assignment panel already resolves.
 */
import { APP_PHONE_MARKER, BEDS24_API_BASE } from './beds24Reservations';
import { countryToLang } from './countries';
import { SELLABLE_UNITS } from './stayRequest';
import {
  BILLING_CADENCE_LABELS,
  corporateMarker,
  type CorporateAgreement,
  type CorporateStay,
} from './corporateShared';

/** Indigo — the flag colour on the Beds24 calendar, matching the dashboard badge. */
export const CORPORATE_FLAG_COLOR = '4F46E5';

/** Beds24 bills per request; one array POST per chunk keeps a long schedule to a handful of calls. */
export const CREATE_CHUNK_SIZE = 25;

export function roomLabel(roomId: number): string {
  return SELLABLE_UNITS.find((u) => u.roomId === roomId)?.label ?? `room ${roomId}`;
}

export interface EffectiveGuest {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  /** True when no guest name is known yet and the company name stands in. */
  placeholder: boolean;
}

/**
 * The guest a stay is booked for: the stay's own details, else the
 * agreement's default guest, else the company itself with "TBA" — so the
 * booking is recognisable in Transactions and the cleaning sheet until the
 * operator fills the name in (which pushes the real name to Beds24).
 */
export function effectiveGuest(
  agreement: Pick<
    CorporateAgreement,
    'companyName' | 'guestFirstName' | 'guestLastName' | 'guestPhone' | 'guestEmail' | 'repPhone'
  >,
  stay: Pick<CorporateStay, 'guestFirstName' | 'guestLastName' | 'guestPhone' | 'guestEmail'>,
): EffectiveGuest {
  const first = stay.guestFirstName?.trim() || agreement.guestFirstName?.trim() || '';
  const last = stay.guestLastName?.trim() || agreement.guestLastName?.trim() || '';
  const placeholder = !first && !last;
  return {
    firstName: placeholder ? agreement.companyName : first,
    lastName: placeholder ? 'TBA' : last,
    phone: stay.guestPhone?.trim() || agreement.guestPhone?.trim() || agreement.repPhone?.trim() || '',
    email: stay.guestEmail?.trim() || agreement.guestEmail?.trim() || '',
    placeholder,
  };
}

export interface CorporateBookingPayload {
  roomId: number;
  status: 'confirmed';
  arrival: string;
  departure: string;
  numAdult: number;
  numChild: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  country: string;
  lang: string;
  referer: 'PhoneDirect';
  apiSource: 'Direct';
  comments: string;
  notes: string;
  flagColor: string;
  flagText: string;
  price: number;
  invoiceItems: { type: 'charge'; subType: number; description: string; qty: number; amount: number }[];
  actions: { checkAvailability: true };
}

export function buildCorporateBookingPayload(
  agreement: CorporateAgreement,
  stay: CorporateStay,
  totalStays: number,
): CorporateBookingPayload {
  const guest = effectiveGuest(agreement, stay);
  const price = Math.round(stay.priceCzk ?? 0);
  const countryCode = agreement.nationality.toUpperCase();

  // Same markers as the manual phone booking (channel = Direct-Phone), plus
  // the corporate tag Transactions reads. Keep the human line short — comments
  // show up in Beds24's booking view.
  const comments = [
    APP_PHONE_MARKER,
    corporateMarker(agreement.id),
    `Corporate stay ${stay.seq}/${totalStays} · ${agreement.companyName}`,
    agreement.notes?.trim() || '',
  ]
    .filter(Boolean)
    .join('\n');

  // Internal notes — invoicing facts the operator wants next to the booking in Beds24.
  const notes = [
    `Corporate agreement ${agreement.id} — ${agreement.companyName}${agreement.ico ? ` (IČO ${agreement.ico})` : ''}`,
    `Invoiced: ${BILLING_CADENCE_LABELS[agreement.billingCadence]}${agreement.billingEmail ? ` → ${agreement.billingEmail}` : ''}`,
    agreement.repName || agreement.repPhone
      ? `Company contact: ${[agreement.repName, agreement.repPhone, agreement.repEmail].filter(Boolean).join(' · ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    roomId: stay.roomId,
    status: 'confirmed',
    arrival: stay.arrival,
    departure: stay.departure,
    numAdult: agreement.adults,
    numChild: agreement.children,
    firstName: guest.firstName,
    lastName: guest.lastName,
    email: guest.email,
    phone: guest.phone,
    company: agreement.companyName,
    // Lowercase country + derived lang mirror the manual booking route, so the
    // mapper reads nationality the same way and Beds24 picks the right template language.
    country: countryCode.toLowerCase(),
    lang: countryToLang(countryCode),
    referer: 'PhoneDirect',
    apiSource: 'Direct',
    comments,
    notes,
    flagColor: CORPORATE_FLAG_COLOR,
    flagText: 'Corporate',
    price,
    invoiceItems: price > 0 ? [{ type: 'charge', subType: 1, description: 'Accommodation', qty: 1, amount: price }] : [],
    actions: { checkAvailability: true },
  };
}

// ─── Beds24 calls ────────────────────────────────────────────────────────────

export function asArray(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  const data = (json as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data : [];
}

/** First booking id in a Beds24 result item — `{ new: { id } }`, `{ id }`, or nested under data. */
export function extractBookingId(item: unknown): number | null {
  let found: number | null = null;
  const walk = (v: unknown, depth: number): void => {
    if (found !== null || !v || typeof v !== 'object' || depth > 4) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const obj = v as Record<string, unknown>;
    if (typeof obj.id === 'number' && Number.isFinite(obj.id)) {
      found = obj.id;
      return;
    }
    if (typeof obj.id === 'string' && /^\d+$/.test(obj.id)) {
      found = Number(obj.id);
      return;
    }
    if (obj.new !== undefined) walk(obj.new, depth + 1);
    if (found === null && obj.data !== undefined) walk(obj.data, depth + 1);
  };
  walk(item, 0);
  return found;
}

/** Beds24's reason for refusing one item, in one line. */
export function describeBeds24Failure(item: unknown): string {
  const obj = (item ?? {}) as Record<string, unknown>;
  const errors = obj.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const parts = errors.map((e) => {
      const err = (e ?? {}) as Record<string, unknown>;
      return [err.field, err.message ?? err.error ?? err.info].filter(Boolean).join(': ');
    });
    const text = parts.filter(Boolean).join('; ');
    if (text) return text.slice(0, 300);
  }
  for (const key of ['message', 'info', 'error']) {
    if (typeof obj[key] === 'string' && (obj[key] as string).trim()) return (obj[key] as string).slice(0, 300);
  }
  return JSON.stringify(item).slice(0, 300);
}

export interface Beds24ItemOutcome {
  ok: boolean;
  bookingId: number | null;
  error: string | null;
}

/**
 * Read a batch reply back, one outcome per booking sent, by position. Beds24
 * answers an array POST with an array in the same order; if the counts ever
 * differ we cannot tell which booking is which, so every item is reported as
 * unverified rather than guessed — a wrong guess here would create duplicates
 * on retry.
 */
export function parseBeds24BatchResponse(json: unknown, expected: number): Beds24ItemOutcome[] {
  const items = asArray(json);
  if (items.length !== expected) {
    const error =
      `Beds24 returned ${items.length} result(s) for ${expected} booking(s) — cannot match them up. ` +
      'Check the Beds24 calendar before retrying so nothing is created twice.';
    return Array.from({ length: expected }, () => ({ ok: false, bookingId: null, error }));
  }
  return items.map((item) => {
    const success = (item as { success?: unknown } | null)?.success !== false;
    if (!success) return { ok: false, bookingId: null, error: describeBeds24Failure(item) };
    const bookingId = extractBookingId(item);
    if (bookingId === null) {
      return {
        ok: false,
        bookingId: null,
        error: 'Beds24 accepted the booking but returned no id — verify it in Beds24 before retrying.',
      };
    }
    return { ok: true, bookingId, error: null };
  });
}

/** POST an array of bookings (new or modifications). Throws on a non-2xx reply. */
export async function postBeds24Bookings(token: string, payload: unknown[]): Promise<unknown> {
  const res = await fetch(`${BEDS24_API_BASE}/bookings`, {
    method: 'POST',
    headers: { token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Beds24 ${res.status}: ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Beds24 returned a non-JSON reply: ${text.slice(0, 200)}`);
  }
}

/**
 * Every live Beds24 record for one stay: the booking itself plus any
 * sub-bookings Beds24 allocated under it (a type booking becomes a master on
 * the virtual room + one sub on the physical unit). Falls back to the id
 * alone when the group cannot be read.
 */
export async function fetchBookingGroupIds(token: string, bookingId: number): Promise<number[]> {
  const params = new URLSearchParams();
  params.append('id', String(bookingId));
  for (const s of ['confirmed', 'new', 'request']) params.append('status', s);
  params.set('includeBookingGroup', 'true');
  const res = await fetch(`${BEDS24_API_BASE}/bookings?${params}`, { headers: { token }, cache: 'no-store' });
  if (!res.ok) throw new Error(`Beds24 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const rows = asArray(await res.json()) as { id?: number; masterId?: number | null }[];
  const ids = rows
    .filter((r) => typeof r.id === 'number' && (r.id === bookingId || r.masterId === bookingId))
    .map((r) => r.id as number);
  return Array.from(new Set([bookingId, ...ids]));
}

/** Apply the same modification to every record in a booking group; throws if any is refused. */
export async function modifyBookingGroup(
  token: string,
  bookingId: number,
  fields: Record<string, unknown>,
): Promise<number[]> {
  let ids: number[];
  try {
    ids = await fetchBookingGroupIds(token, bookingId);
  } catch (err) {
    console.error('[corporate] booking group lookup failed — modifying the master only:', err);
    ids = [bookingId];
  }
  const json = await postBeds24Bookings(
    token,
    ids.map((id) => ({ id, ...fields })),
  );
  const outcomes = asArray(json);
  const refused = outcomes.find((o) => (o as { success?: unknown } | null)?.success === false);
  if (refused) throw new Error(`Beds24 rejected the change: ${describeBeds24Failure(refused)}`);
  return ids;
}

/**
 * Legacy reservations — stays that PREDATE Beds24, imported from the channels'
 * own exports so analytics can see the whole history of the business.
 *
 * The property traded on Booking.com and Airbnb directly from late November
 * 2025; each unit only moved onto Beds24 later (the Deluxe studios on
 * 2026-02-06), and Beds24 imported just the bookings still open on the day of
 * the switch. Everything that had already checked out exists only in the
 * channels' extranets.
 *
 * These rows land in `bookings_mirror` with `source = 'legacy-import'` and a
 * `LG-…` reservation number, so they can never collide with a Beds24 `BH-…`
 * row, and the Beds24 sync never touches them. They are deliberately thin:
 *   - revenue and channel commission only — no operating costs were tracked
 *     before Beds24, so they are excluded from per-booking cost economics;
 *   - no email/phone/address; name + country only;
 *   - money in CZK. Some Booking.com prices were still in EUR, converted at the
 *     ČNB rate of the arrival date (the original amount stays in `raw`).
 *
 * Money follows each export as-is, which is close to — but not exactly — the
 * Beds24 convention for the same booking:
 *   - Booking.com "Commission amount" is the bare commission. Beds24's
 *     commission also folds in the Payments by Booking.com charge (≈ +11.7 %
 *     on the commission), and Beds24's price includes a small city-tax line.
 *   - Airbnb "Gross earnings" (incl. cleaning fee) and "Service fee" match the
 *     Beds24 price/commission exactly.
 *
 * Pure module: no database, no network — the CLI in
 * `scripts/import/legacy-reservations.ts` does the I/O.
 */
import type { BookingsMirrorInsert } from '../lib/db/schema/bookingsMirror';

export const LEGACY_SOURCE = 'legacy-import' as const;

export type LegacyChannel = 'Booking.com' | 'Airbnb';

export interface Money {
  amount: number;
  /** ISO 4217; null when the export left the cell empty (e.g. a cancelled booking's commission). */
  currency: string | null;
}

export interface LegacyReservation {
  channel: LegacyChannel;
  /** The channel's own reference: Booking.com reservation number / Airbnb confirmation code. */
  ref: string;
  guestName: string;
  /** YYYY-MM-DD */
  checkIn: string;
  /** YYYY-MM-DD */
  checkOut: string;
  nights: number;
  /** 0 = the export doesn't say (Airbnb payout reports). */
  guests: number;
  /** YYYY-MM-DD, property-local. */
  bookedDate: string;
  /** ISO instant when the export carries a time of day, else null. */
  bookedAt: string | null;
  cancelled: boolean;
  cancelledAt: string | null;
  price: Money;
  commission: Money;
  /** Listing / room-type name exactly as exported. */
  unitLabel: string;
  /** Rooms in the booking (Booking.com can book several of one type). */
  units: number;
  /** ISO 3166 alpha-2, upper case, or '' when unknown. */
  nationality: string;
  sourceFile: string;
  /** The original export row minus contact details — kept in `raw` for provenance. */
  row: Record<string, string>;
}

/** A row the parser could not turn into a reservation — reported, never imported. */
export interface RejectedRow {
  sourceFile: string;
  ref: string;
  reason: string;
}

export interface ParseResult {
  reservations: LegacyReservation[];
  rejected: RejectedRow[];
  /** Human-readable notes about lines that were skipped or merged on purpose. */
  notes: string[];
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/**
 * RFC 4180 CSV → one object per row keyed by trimmed header. Handles quoted
 * fields containing the delimiter, doubled quotes, CRLF and a UTF-8 BOM. The
 * delimiter is sniffed from the header line: Airbnb writes commas, while a
 * Booking.com sheet re-saved by Czech Excel comes out semicolon-separated.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const delimiter = countOutsideQuotes(firstLine, ';') > countOutsideQuotes(firstLine, ',') ? ';' : ',';

  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      records.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    records.push(row);
  }

  const nonEmpty = records.filter((r) => r.some((v) => v.trim() !== ''));
  const [header, ...body] = nonEmpty;
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

function countOutsideQuotes(line: string, ch: string): number {
  let count = 0;
  let inQuotes = false;
  for (const c of line) {
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ch && !inQuotes) count++;
  }
  return count;
}

// ── Value parsing ────────────────────────────────────────────────────────────

/** "1,635.89" / "1635,89" / "112.8" → number. Empty → 0. */
export function parseNumber(s: string): number {
  const t = s.replace(/[\s ]/g, '');
  if (t === '') return 0;
  const normalised = t.includes('.') ? t.replace(/,/g, '') : t.replace(',', '.');
  const value = Number(normalised);
  if (!Number.isFinite(value)) throw new Error(`not a number: "${s}"`);
  return value;
}

/** "112.8 EUR" → { 112.8, EUR }. Empty → { 0, null }. */
export function parseMoney(s: string, fallbackCurrency: string | null = null): Money {
  const t = s.trim();
  if (t === '') return { amount: 0, currency: null };
  const m = /^(-?[\d.,\s ]+?)\s*([A-Z]{3})?$/.exec(t);
  if (!m) throw new Error(`not an amount: "${s}"`);
  const currency = m[2] ?? fallbackCurrency;
  if (!currency) throw new Error(`amount without a currency: "${s}"`);
  return { amount: parseNumber(m[1]), currency };
}

/** "2025-12-09" or "9.12.2025" → "2025-12-09". */
function parseIsoOrCzechDay(s: string): string {
  const t = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  throw new Error(`not a date: "${s}"`);
}

/** Airbnb's US-format "12/22/2025" → "2025-12-22". */
function parseUsDay(s: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  if (!m) throw new Error(`not an MM/DD/YYYY date: "${s}"`);
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/**
 * Booking.com extranet timestamps are property-local (Europe/Prague) wall-clock
 * time with no offset: "2025-12-09 14:21:09" → "2025-12-09T13:21:09.000Z".
 */
export function pragueLocalToIso(local: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
  if (!m) throw new Error(`not a date-time: "${local}"`);
  const [, y, mo, d, h, mi, s = '00'] = m;
  const naive = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  // Probing the zone at the naive instant is exact everywhere except inside the
  // DST switch hour itself, which no booking export needs.
  return new Date(naive - pragueOffsetMinutes(naive) * 60_000).toISOString();
}

function pragueOffsetMinutes(utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Prague',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((wall - utcMs) / 60_000);
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/** "Jana Nováková" → { first: "Jana", last: "Nováková" }. */
export function splitGuestName(full: string): { first: string; last: string } {
  const tokens = full.trim().split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) return { first: tokens[0] ?? '', last: '' };
  return { first: tokens.slice(0, -1).join(' '), last: tokens[tokens.length - 1] };
}

// ── Booking.com ──────────────────────────────────────────────────────────────

/** Column names in the Czech and the English extranet export. */
const BCOM_COLUMNS = {
  ref: ['Číslo rezervace', 'Book number', 'Reservation number'],
  guest: ['Jméno hosta', 'Guest name(s)', 'Guest Name(s)'],
  checkIn: ['Příjezd', 'Check-in'],
  checkOut: ['Odjezd', 'Check-out'],
  booked: ['Provedení rezervace', 'Booked on'],
  status: ['Status'],
  rooms: ['Pokoje', 'Rooms'],
  persons: ['Počet osob', 'People', 'Persons'],
  price: ['Cena', 'Price'],
  commission: ['Výše provize', 'Commission amount'],
  country: ['Booker country'],
  unit: ['Typ ubytovací jednotky', 'Unit type'],
  nights: ['Délka pobytu (noci)', 'Duration (nights)'],
  cancelledOn: ['Datum zrušení rezervace', 'Cancellation date'],
} as const;

/** Contact details and free-text remarks are never stored, even in `raw`. */
const BCOM_DROPPED_COLUMNS = new Set([
  'Adresa', 'Address', 'Telefonní číslo', 'Phone number', 'Poznámky', 'Remarks',
]);

function pick(row: Record<string, string>, names: readonly string[]): string {
  for (const n of names) if (n in row) return row[n];
  return '';
}

function hasColumn(rows: Record<string, string>[], names: readonly string[]): boolean {
  return rows.length > 0 && names.some((n) => n in rows[0]);
}

export function parseBookingComExport(text: string, sourceFile: string): ParseResult {
  const rows = parseCsv(text);
  const result: ParseResult = { reservations: [], rejected: [], notes: [] };
  for (const [key, names] of Object.entries(BCOM_COLUMNS)) {
    if (key === 'country' || key === 'cancelledOn') continue; // optional
    if (!hasColumn(rows, names)) throw new Error(`${sourceFile}: no "${names[0]}" column — is this a Booking.com reservations export?`);
  }

  for (const row of rows) {
    const ref = pick(row, BCOM_COLUMNS.ref).replace(/\.0$/, '');
    try {
      const status = pick(row, BCOM_COLUMNS.status).trim().toLowerCase();
      let cancelled: boolean;
      if (status === 'ok') cancelled = false;
      else if (status.startsWith('cancelled') || status.startsWith('canceled')) cancelled = true;
      else throw new Error(`status "${status}" is not handled (only ok / cancelled_*)`);

      const checkIn = parseIsoOrCzechDay(pick(row, BCOM_COLUMNS.checkIn));
      const checkOut = parseIsoOrCzechDay(pick(row, BCOM_COLUMNS.checkOut));
      const nights = parseNumber(pick(row, BCOM_COLUMNS.nights)) || daysBetween(checkIn, checkOut);
      if (nights !== daysBetween(checkIn, checkOut)) {
        throw new Error(`${nights} nights does not match ${checkIn} → ${checkOut}`);
      }

      const bookedRaw = pick(row, BCOM_COLUMNS.booked);
      const bookedAt = /\d{1,2}:\d{2}/.test(bookedRaw) ? pragueLocalToIso(bookedRaw) : null;
      const cancelledRaw = pick(row, BCOM_COLUMNS.cancelledOn);
      const price = parseMoney(pick(row, BCOM_COLUMNS.price));
      const commission = parseMoney(pick(row, BCOM_COLUMNS.commission), price.currency);

      const kept = Object.fromEntries(Object.entries(row).filter(([k]) => !BCOM_DROPPED_COLUMNS.has(k)));
      result.reservations.push({
        channel: 'Booking.com',
        ref,
        guestName: pick(row, BCOM_COLUMNS.guest),
        checkIn,
        checkOut,
        nights,
        guests: Math.round(parseNumber(pick(row, BCOM_COLUMNS.persons))),
        bookedDate: parseIsoOrCzechDay(bookedRaw),
        bookedAt,
        cancelled,
        cancelledAt: cancelled && /\d{1,2}:\d{2}/.test(cancelledRaw) ? pragueLocalToIso(cancelledRaw) : null,
        price,
        commission,
        unitLabel: pick(row, BCOM_COLUMNS.unit),
        units: Math.max(1, Math.round(parseNumber(pick(row, BCOM_COLUMNS.rooms)))),
        nationality: pick(row, BCOM_COLUMNS.country).trim().toUpperCase(),
        sourceFile,
        row: kept,
      });
    } catch (err) {
      result.rejected.push({ sourceFile, ref: ref || '(no ref)', reason: (err as Error).message });
    }
  }
  return result;
}

// ── Airbnb ───────────────────────────────────────────────────────────────────

/**
 * Airbnb "transaction history" (payouts) CSV. Each payout line is followed by
 * the reservation lines it paid; only `Reservation` lines are bookings.
 *
 * Because it is a PAYOUT report, a reservation that never paid out (a full
 * cancellation) is simply absent — Airbnb cancellations cannot be recovered
 * from this file. A long stay paid in several instalments appears once per
 * instalment; those lines are summed into one reservation. The very same line
 * appearing twice (overlapping export periods) is dropped, not summed.
 */
export function parseAirbnbPayouts(text: string, sourceFile: string): ParseResult {
  const rows = parseCsv(text);
  const result: ParseResult = { reservations: [], rejected: [], notes: [] };
  if (!hasColumn(rows, ['Confirmation code']) || !hasColumn(rows, ['Gross earnings'])) {
    throw new Error(`${sourceFile}: no "Confirmation code" / "Gross earnings" column — is this an Airbnb transaction-history export?`);
  }

  const otherTypes = new Map<string, number>();
  const byCode = new Map<string, LegacyReservation>();
  const seenLines = new Set<string>();
  for (const row of rows) {
    const type = row['Type'];
    if (type !== 'Reservation') {
      if (type !== 'Payout') otherTypes.set(type, (otherTypes.get(type) ?? 0) + 1);
      continue;
    }
    const ref = row['Confirmation code'];
    try {
      const lineKey = [ref, row['Date'], row['Amount'], row['Gross earnings']].join('|');
      if (seenLines.has(lineKey)) {
        result.notes.push(`${sourceFile}: ${ref} — identical line repeated, counted once`);
        continue;
      }
      seenLines.add(lineKey);

      const currency = row['Currency'] || null;
      const gross = parseMoney(row['Gross earnings'], currency);
      const fee = parseMoney(row['Service fee'], currency);
      const existing = byCode.get(ref);
      if (existing) {
        // Instalment of a reservation already seen in this file — sum the money.
        existing.price.amount += gross.amount;
        existing.commission.amount += fee.amount;
        result.notes.push(`${sourceFile}: ${ref} — paid in instalments, lines summed`);
        continue;
      }

      const checkIn = parseUsDay(row['Start date']);
      const checkOut = parseUsDay(row['End date']);
      const nights = parseNumber(row['Nights']) || daysBetween(checkIn, checkOut);
      if (nights !== daysBetween(checkIn, checkOut)) {
        throw new Error(`${nights} nights does not match ${checkIn} → ${checkOut}`);
      }
      byCode.set(ref, {
        channel: 'Airbnb',
        ref,
        guestName: row['Guest'],
        checkIn,
        checkOut,
        nights,
        guests: 0,
        bookedDate: parseUsDay(row['Booking date']),
        bookedAt: null,
        cancelled: false,
        cancelledAt: null,
        price: { amount: gross.amount, currency: gross.currency ?? currency },
        commission: { amount: fee.amount, currency: fee.currency ?? currency },
        unitLabel: row['Listing'],
        units: 1,
        nationality: '',
        sourceFile,
        row: { ...row },
      });
    } catch (err) {
      result.rejected.push({ sourceFile, ref: ref || '(no code)', reason: (err as Error).message });
    }
  }
  for (const [type, count] of otherTypes) {
    result.notes.push(`${sourceFile}: ${count} "${type}" line${count === 1 ? '' : 's'} ignored (not a reservation)`);
  }
  result.reservations.push(...byCode.values());
  return result;
}

// ── Rooms ────────────────────────────────────────────────────────────────────

export interface RoomAssignment {
  /** Physical room, a "K.202 + K.203" package label, or a virtual room. */
  room: string;
  linkedRooms: string[] | null;
  /** True when the channel never said which unit — portfolio totals only. */
  unallocated: boolean;
}

const DELUXE_STUDIOS_VR = '1KK Deluxe Studios';
const BOTH_STUDIOS: RoomAssignment = { room: 'K.202 + K.203', linkedRooms: ['K.202', 'K.203'], unallocated: false };
const SOME_STUDIO: RoomAssignment = { room: DELUXE_STUDIOS_VR, linkedRooms: null, unallocated: true };
const single = (room: string): RoomAssignment => ({ room, linkedRooms: null, unallocated: false });

/**
 * Booking.com room TYPES in use before Beds24. The Deluxe studios were sold as
 * one two-unit type (named with a letter O: "K.2O3, K.202") plus an older
 * "Deluxe Apartment" type; neither tells which studio a guest got, so a
 * one-room booking goes to the virtual room and a two-room booking is both.
 */
const BCOM_ROOM_TYPES: Record<string, 'K.201' | 'deluxe-studio'> = {
  'K.201': 'K.201',
  'K.2O3, K.202': 'deluxe-studio',
  'Deluxe Apartment': 'deluxe-studio',
};

/** Airbnb listings — one listing per unit, except the Twins listing (both studios). */
const AIRBNB_LISTINGS: Record<string, RoomAssignment> = {
  'Premium New Apartment | 2x King Bed | Free Parking': single('K.201'),
  'Baker House Twins – 2 Private Studios Next Door': BOTH_STUDIOS,
  'New Courtyard Studio · Free Parking · Brno Centre': single('K.202'),
  'Baker House Apartments - 45 m² 1BR + Free Parking': single('K.203'),
};

const squash = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim();

/** Which room(s) a legacy reservation occupied, or null when the label is unknown. */
export function assignRoom(r: Pick<LegacyReservation, 'channel' | 'unitLabel' | 'units'>): RoomAssignment | null {
  const label = squash(r.unitLabel);
  if (r.channel === 'Airbnb') {
    const hit = Object.entries(AIRBNB_LISTINGS).find(([name]) => squash(name) === label);
    return hit ? hit[1] : null;
  }

  // Booking.com lists every booked room's type, comma-joined — and one type
  // name itself contains a comma, so match known names instead of splitting.
  let rest = label;
  const types: string[] = [];
  for (const name of Object.keys(BCOM_ROOM_TYPES).sort((a, b) => b.length - a.length)) {
    if (rest.includes(name)) {
      types.push(BCOM_ROOM_TYPES[name]);
      rest = rest.split(name).join('');
    }
  }
  if (types.length === 0 || rest.replace(/[,\s]/g, '') !== '') return null;
  const kinds = new Set(types);
  if (kinds.size !== 1) return null;
  const [kind] = [...kinds];
  if (kind === 'K.201') return r.units === 1 ? single('K.201') : null;
  if (r.units === 1) return SOME_STUDIO;
  if (r.units === 2) return BOTH_STUDIOS;
  return null;
}

// ── FX (ČNB) ─────────────────────────────────────────────────────────────────

/** CZK per ONE unit of each currency, per publication day. */
export type CnbTable = Map<string, Map<string, number>>;

/**
 * Parse a ČNB yearly rates file (`…/kurzy-devizoveho-trhu/rok.txt?rok=2025`):
 * `Date|1 AUD|…|100 HUF|…` then `02.01.2025|15,145|…`. The header repeats
 * mid-file whenever the currency list changes, so it is re-read each time.
 */
export function parseCnbYear(text: string, into: CnbTable = new Map()): CnbTable {
  let columns: { code: string; per: number }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split('|');
    if (/^(Date|Datum)$/i.test(cells[0])) {
      columns = cells.slice(1).map((h) => {
        const [per, code] = h.trim().split(/\s+/);
        return { code, per: Number(per) };
      });
      continue;
    }
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(cells[0]);
    if (!m || columns.length === 0) continue;
    const day = `${m[3]}-${m[2]}-${m[1]}`;
    const rates = new Map<string, number>();
    columns.forEach((col, i) => {
      const v = cells[i + 1];
      if (v) rates.set(col.code, parseNumber(v) / col.per);
    });
    into.set(day, rates);
  }
  return into;
}

export interface FxQuote {
  currency: string;
  rate: number;
  /** The ČNB publication day actually used (the last one on or before the requested day). */
  rateDate: string;
}

export function cnbQuote(table: CnbTable, currency: string, isoDay: string): FxQuote {
  if (currency === 'CZK') return { currency, rate: 1, rateDate: isoDay };
  let day = isoDay;
  for (let i = 0; i < 10; i++) {
    const rate = table.get(day)?.get(currency);
    if (rate !== undefined) return { currency, rate, rateDate: day };
    day = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  }
  throw new Error(`no ČNB ${currency} rate within 10 days before ${isoDay}`);
}

// ── Row ──────────────────────────────────────────────────────────────────────

const CHANNEL_PREFIX: Record<LegacyChannel, string> = { 'Booking.com': 'BCOM', Airbnb: 'ABNB' };

export function legacyReservationNumber(channel: LegacyChannel, ref: string): string {
  return `LG-${CHANNEL_PREFIX[channel]}-${ref}`;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Project a legacy reservation into a `bookings_mirror` row, mirroring how the
 * Beds24 projection fills the same columns for a past OTA stay (status
 * confirmed/cancelled, Paid, cleaning Completed, cancelled ⇒ price 0).
 *
 * `raw` keeps the export row for provenance, plus `cancelTime` /
 * `bookingTime` under the Beds24 key names — the analytics cancellation
 * classifier reads `raw ->> 'cancelTime'`.
 */
export function toLegacyMirrorRow(
  r: LegacyReservation,
  room: RoomAssignment,
  quote: (currency: string, isoDay: string) => FxQuote,
): BookingsMirrorInsert {
  const currency = r.price.currency ?? 'CZK';
  const fx = quote(currency, r.checkIn);
  const priceCzk = r.cancelled ? 0 : round2(r.price.amount * fx.rate);
  const commissionCzk = r.cancelled ? 0 : round2(r.commission.amount * fx.rate);
  const { first, last } = splitGuestName(r.guestName);

  return {
    reservationNumber: legacyReservationNumber(r.channel, r.ref),
    source: LEGACY_SOURCE,
    beds24Id: null,
    apiReference: r.ref,
    channel: r.channel,
    room: room.room,
    linkedRooms: room.linkedRooms,
    checkInDate: r.checkIn,
    checkOutDate: r.checkOut,
    reservationDate: r.bookedDate,
    bookingTimestamp: r.bookedAt ? new Date(r.bookedAt) : null,
    modifiedAt: null,
    numberOfNights: r.nights,
    numberOfGuests: r.guests,
    firstName: first,
    lastName: last,
    email: '',
    phone: '',
    nationality: r.nationality,
    price: String(priceCzk),
    amountPaid: String(priceCzk),
    commissionAmount: String(commissionCzk),
    paymentChargeAmount: '0',
    paymentStatus: 'Paid',
    cleaningStatus: 'Completed',
    rateType: null,
    status: r.cancelled ? 'cancelled' : 'confirmed',
    isCancelled: r.cancelled,
    isBlackout: false,
    isUnallocatedVr: room.unallocated,
    blackoutCreatedBy: null,
    blackoutReason: null,
    syncedRating: null,
    raw: {
      legacy: {
        channel: r.channel,
        file: r.sourceFile,
        row: r.row,
        ...(currency !== 'CZK'
          ? {
              fx: {
                currency,
                rate: fx.rate,
                rateDate: fx.rateDate,
                originalPrice: r.price.amount,
                originalCommission: r.commission.amount,
              },
            }
          : {}),
      },
      ...(r.bookedAt ? { bookingTime: r.bookedAt } : {}),
      ...(r.cancelledAt ? { cancelTime: r.cancelledAt } : {}),
    },
  };
}

/** `ref  # reason` per line; blank lines and `#` comments ignored. */
export function parseExclusions(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const [head, ...comment] = line.split('#');
    const ref = head.trim().split(/\s+/)[0];
    if (ref) out.set(ref, comment.join('#').trim());
  }
  return out;
}

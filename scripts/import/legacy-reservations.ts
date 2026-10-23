/**
 * Import pre-Beds24 reservations from channel exports into `bookings_mirror`
 * as `source = 'legacy-import'`. Dry run by default; `--apply` writes.
 *
 *   npx tsx scripts/import/legacy-reservations.ts \
 *     --bookingcom <reservations.csv> [--bookingcom …] \
 *     --airbnb <transaction-history.csv> [--airbnb …] \
 *     [--exclude <exclusions.txt>] [--apply]
 *
 * Inputs
 *   --bookingcom  Extranet → Reservations → download. The extranet gives .xls:
 *                 open it and save as CSV (UTF-8). Czech or English headers.
 *   --airbnb      Earnings → Transaction history → export CSV (payout report).
 *   --exclude     One channel ref per line, `# reason` optional — bookings that
 *                 must never be imported (friends' opening stays, a cancellation
 *                 that was really a rebooking, …).
 *
 * KEEP THE EXPORTS AND THE EXCLUSION LIST OUT OF THIS REPOSITORY — it is public
 * and they hold guest names. Pass paths to files stored elsewhere.
 *
 * Skips any reservation Beds24 already has (same channel ref = `api_reference`
 * on a non-legacy row): Beds24 imported the bookings still open on the day each
 * unit switched over, and its row is the richer one. Re-running is safe — it
 * upserts legacy rows only and can never modify a Beds24 row.
 */
import '../_loadEnv';

import { readFileSync } from 'fs';
import { basename } from 'path';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../../lib/db';
import { bookingsMirror } from '../../lib/db/schema';
import type { BookingsMirrorInsert } from '../../lib/db/schema/bookingsMirror';
import {
  LEGACY_SOURCE,
  assignRoom,
  cnbQuote,
  legacyReservationNumber,
  parseAirbnbPayouts,
  parseBookingComExport,
  parseCnbYear,
  parseExclusions,
  toLegacyMirrorRow,
  type CnbTable,
  type LegacyReservation,
  type ParseResult,
} from '../../utils/legacyReservations';

interface Args {
  bookingcom: string[];
  airbnb: string[];
  exclude: string | null;
  apply: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { bookingcom: [], airbnb: [], exclude: null, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--bookingcom') args.bookingcom.push(argv[++i]);
    else if (a === '--airbnb') args.airbnb.push(argv[++i]);
    else if (a === '--exclude') args.exclude = argv[++i];
    else throw new Error(`unknown argument "${a}"`);
  }
  if (args.bookingcom.length + args.airbnb.length === 0) throw new Error('no input files');
  return args;
}

async function loadCnb(years: Set<string>): Promise<CnbTable> {
  const table: CnbTable = new Map();
  for (const year of [...years].sort()) {
    const url = `https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/rok.txt?rok=${year}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`ČNB ${year}: HTTP ${res.status}`);
    parseCnbYear(await res.text(), table);
  }
  return table;
}

const fmt = (x: number) => Math.round(x).toLocaleString('en-US');

function printSummary(rows: BookingsMirrorInsert[]) {
  type Bucket = { stays: number; cancelled: number; nights: number; gross: number; commission: number };
  const buckets = new Map<string, Bucket>();
  const total: Bucket = { stays: 0, cancelled: 0, nights: 0, gross: 0, commission: 0 };
  for (const r of rows) {
    const key = `${r.checkInDate!.slice(0, 7)}  ${r.channel.padEnd(11)}`;
    const b = buckets.get(key) ?? { stays: 0, cancelled: 0, nights: 0, gross: 0, commission: 0 };
    for (const t of [b, total]) {
      if (r.isCancelled) t.cancelled++;
      else {
        t.stays++;
        t.nights += r.numberOfNights;
        t.gross += Number(r.price);
        t.commission += Number(r.commissionAmount);
      }
    }
    buckets.set(key, b);
  }
  console.log('  month    channel      stays  canc  nights   gross CZK  commission CZK');
  for (const [key, b] of [...buckets].sort()) {
    console.log(`  ${key}  ${String(b.stays).padStart(5)}  ${String(b.cancelled).padStart(4)}  ${String(b.nights).padStart(6)}  ${fmt(b.gross).padStart(10)}  ${fmt(b.commission).padStart(14)}`);
  }
  console.log(`  TOTAL ${String(rows.length).padStart(3)} rows       ${String(total.stays).padStart(5)}  ${String(total.cancelled).padStart(4)}  ${String(total.nights).padStart(6)}  ${fmt(total.gross).padStart(10)}  ${fmt(total.commission).padStart(14)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // 1. Parse every export.
  const parsed: ParseResult[] = [
    ...args.bookingcom.map((p) => parseBookingComExport(readFileSync(p, 'utf8'), basename(p))),
    ...args.airbnb.map((p) => parseAirbnbPayouts(readFileSync(p, 'utf8'), basename(p))),
  ];
  const notes = parsed.flatMap((p) => p.notes);
  const rejected = parsed.flatMap((p) => p.rejected);

  // The same booking in two overlapping exports → keep one.
  const byKey = new Map<string, LegacyReservation>();
  for (const r of parsed.flatMap((p) => p.reservations)) {
    const key = legacyReservationNumber(r.channel, r.ref);
    if (byKey.has(key)) notes.push(`${r.ref} appears in more than one export — counted once`);
    byKey.set(key, r);
  }
  const all = [...byKey.values()];
  console.log(`Parsed ${all.length} reservations (${args.bookingcom.length} Booking.com + ${args.airbnb.length} Airbnb file(s)).`);

  // 2. Exclusions.
  const exclusions = args.exclude ? parseExclusions(readFileSync(args.exclude, 'utf8')) : new Map<string, string>();
  const refsInInput = new Set(all.map((r) => r.ref));
  const unknownExclusions = [...exclusions.keys()].filter((ref) => !refsInInput.has(ref));
  const candidates = all.filter((r) => !exclusions.has(r.ref));

  // 3. Rooms.
  const unmapped = candidates.filter((r) => !assignRoom(r));
  const mappable = candidates.filter((r) => assignRoom(r));

  // 4. Already in Beds24?
  const refs = mappable.map((r) => r.ref);
  const existing = refs.length
    ? await db
        .select({
          reservationNumber: bookingsMirror.reservationNumber,
          source: bookingsMirror.source,
          apiReference: bookingsMirror.apiReference,
          channel: bookingsMirror.channel,
        })
        .from(bookingsMirror)
        .where(inArray(bookingsMirror.apiReference, refs))
    : [];
  const inBeds24 = new Map(
    existing.filter((e) => e.source !== LEGACY_SOURCE).map((e) => [`${e.channel}|${e.apiReference}`, e.reservationNumber]),
  );
  const alreadyImported = new Set(existing.filter((e) => e.source === LEGACY_SOURCE).map((e) => e.reservationNumber));
  const duplicates = mappable.filter((r) => inBeds24.has(`${r.channel}|${r.ref}`));
  const toImport = mappable.filter((r) => !inBeds24.has(`${r.channel}|${r.ref}`));

  // 5. Money → CZK.
  const fxYears = new Set(
    toImport.filter((r) => (r.price.currency ?? 'CZK') !== 'CZK').map((r) => r.checkIn.slice(0, 4)),
  );
  const cnb = fxYears.size ? await loadCnb(fxYears) : new Map();
  const rows = toImport.map((r) =>
    toLegacyMirrorRow(r, assignRoom(r)!, (currency, day) => cnbQuote(cnb, currency, day)),
  );
  if (rows.some((r) => !r.reservationNumber.startsWith('LG-'))) throw new Error('refusing to write a non-LG key');

  // Possible duplicates the ref match can't see: same channel + check-in + surname.
  const checkIns = [...new Set(rows.map((r) => r.checkInDate!))];
  const sameDay = checkIns.length
    ? await db
        .select({
          reservationNumber: bookingsMirror.reservationNumber,
          channel: bookingsMirror.channel,
          checkInDate: bookingsMirror.checkInDate,
          lastName: bookingsMirror.lastName,
        })
        .from(bookingsMirror)
        .where(and(ne(bookingsMirror.source, LEGACY_SOURCE), inArray(bookingsMirror.checkInDate, checkIns)))
    : [];
  const squash = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const lookalikes = rows.flatMap((r) =>
    sameDay
      .filter((b) => b.channel === r.channel && b.checkInDate === r.checkInDate && r.lastName && squash(b.lastName) === squash(r.lastName))
      .map((b) => `${r.reservationNumber} ↔ ${b.reservationNumber} (${r.checkInDate})`),
  );

  // 6. Report.
  console.log(`\nAlready in Beds24 (skipped): ${duplicates.length}`);
  console.log(`Excluded by list:            ${all.length - candidates.length}`);
  for (const [ref, reason] of exclusions) if (refsInInput.has(ref)) console.log(`  - ${ref}${reason ? `  ${reason}` : ''}`);
  if (unknownExclusions.length) console.log(`  ⚠ in the exclusion list but in no export: ${unknownExclusions.join(', ')}`);
  console.log(`Unknown unit (skipped):      ${unmapped.length}`);
  for (const r of unmapped) console.log(`  - ${r.channel} ${r.ref}: "${r.unitLabel}" × ${r.units}`);
  console.log(`Unreadable rows (skipped):   ${rejected.length}`);
  for (const r of rejected) console.log(`  - ${r.sourceFile} ${r.ref}: ${r.reason}`);
  for (const n of notes) console.log(`  · ${n}`);
  if (lookalikes.length) {
    console.log(`⚠ Same channel, check-in and surname as a Beds24 row — check before applying:`);
    for (const l of lookalikes) console.log(`  - ${l}`);
  }
  const fxRows = rows.filter((r) => (r.raw as { legacy: { fx?: unknown } }).legacy.fx);
  if (fxRows.length) {
    const rates = fxRows.map((r) => (r.raw as { legacy: { fx: { rate: number } } }).legacy.fx.rate);
    console.log(`Converted to CZK at the ČNB rate of the arrival day: ${fxRows.length} rows (EUR ${Math.min(...rates).toFixed(3)}–${Math.max(...rates).toFixed(3)})`);
  }
  const byRoom = new Map<string, number>();
  for (const r of rows) byRoom.set(r.room, (byRoom.get(r.room) ?? 0) + 1);
  console.log(`Rooms: ${[...byRoom].map(([room, n]) => `${room} ${n}`).join(' · ')}`);

  console.log(`\nTo import: ${rows.length} (${rows.filter((r) => alreadyImported.has(r.reservationNumber)).length} already imported → refreshed)`);
  printSummary(rows);

  if (!args.apply) {
    console.log('\nDry run — nothing written. Re-run with --apply to write.');
    return;
  }

  // 7. Write — legacy rows only. The conflict guard means even a key clash
  //    could never overwrite a Beds24 row.
  if (rows.length) {
    await db
      .insert(bookingsMirror)
      .values(rows)
      .onConflictDoUpdate({
        target: bookingsMirror.reservationNumber,
        set: {
          apiReference: sql`excluded.api_reference`,
          channel: sql`excluded.channel`,
          room: sql`excluded.room`,
          linkedRooms: sql`excluded.linked_rooms`,
          checkInDate: sql`excluded.check_in_date`,
          checkOutDate: sql`excluded.check_out_date`,
          reservationDate: sql`excluded.reservation_date`,
          bookingTimestamp: sql`excluded.booking_timestamp`,
          numberOfNights: sql`excluded.number_of_nights`,
          numberOfGuests: sql`excluded.number_of_guests`,
          firstName: sql`excluded.first_name`,
          lastName: sql`excluded.last_name`,
          nationality: sql`excluded.nationality`,
          price: sql`excluded.price`,
          amountPaid: sql`excluded.amount_paid`,
          commissionAmount: sql`excluded.commission_amount`,
          status: sql`excluded.status`,
          isCancelled: sql`excluded.is_cancelled`,
          isUnallocatedVr: sql`excluded.is_unallocated_vr`,
          raw: sql`excluded.raw`,
          syncedAt: sql`now()`,
        },
        setWhere: eq(bookingsMirror.source, LEGACY_SOURCE),
      });
  }
  const [after] = await db
    .select({ n: sql<number>`count(*)::int`, first: sql<string>`min(check_in_date)::text`, last: sql<string>`max(check_in_date)::text` })
    .from(bookingsMirror)
    .where(eq(bookingsMirror.source, LEGACY_SOURCE));
  console.log(`\n✅ Written. bookings_mirror now holds ${after.n} legacy rows (check-in ${after.first} → ${after.last}).`);
}

main().catch((err) => {
  console.error('❌', err instanceof Error ? err.message : err);
  process.exit(1);
});

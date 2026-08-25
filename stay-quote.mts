/**
 * READ-ONLY feasibility + price prototype for a long-stay REQUEST that is not
 * yet in the system. Untracked scratch file — the engine draft for the
 * "can we accommodate this?" button.
 *
 * Run:  npx tsx stay-quote.mts <check-in> <check-out> [guests]
 *   e.g. npx tsx stay-quote.mts 2026-09-01 2026-10-01 2
 *
 * Occupancy comes from public.bookings_mirror (synced from Beds24; includes
 * blackout/inventory-override rows). Cancelled rows are excluded — the Aug-3
 * lesson. Prices come from public.market_daily.live_price (our own asking rate
 * per listing per night), falling back to PriceLabs recommended_price.
 *
 * Nothing here writes anywhere.
 */
import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';
import { ALLOCATION_GROUPS, PHYSICAL_ROOMS, planReallocation, type ReallocInput } from './utils/roomAllocation';

const url = /^DATABASE_URL=(.*)$/m.exec(fs.readFileSync('.env.local', 'utf8'))![1].replace(/^["']|["']$/g, '');
const sql = neon(url);

const [checkIn, checkOut, guestsArg, discountArg] = process.argv.slice(2);
if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut ?? '')) {
  console.error('usage: npx tsx stay-quote.mts <YYYY-MM-DD in> <YYYY-MM-DD out> [guests] [discount%]');
  process.exit(1);
}
const guests = guestsArg ? Number(guestsArg) : null;
/** Operator discount, applied to the whole itinerary and shown per reservation. */
const discountPct = discountArg ? Number(discountArg) : 0;

// Prague "today" — matches pragueToday() semantics well enough for a read-only probe.
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Prague' });

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const nightsBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** VR listing (market_daily) each physical unit is priced from. */
const LISTING_FOR_ROOM: Record<string, string> = {
  'K.102': '311322___679714', // 1KK Urban Studios
  'K.103': '311322___679714',
  'K.106': '311322___679714',
  'K.202': '311322___648816', // 1KK Deluxe Studios
  'K.203': '311322___648816',
  'K.201': '311322___656437', // Executive 2BR
  'O.308': '311322___674672', // Deluxe 2BR
};
const TYPE_OF_ROOM: Record<string, string> = {
  'K.102': '1KK Urban', 'K.103': '1KK Urban', 'K.106': '1KK Urban',
  'K.202': '1KK Deluxe', 'K.203': '1KK Deluxe',
  'K.201': 'Executive 2BR', 'O.308': 'Deluxe 2BR',
};
const ALL_ROOMS = PHYSICAL_ROOMS.map((u) => u.room);

// ── Load occupancy ───────────────────────────────────────────────────────────
type Row = {
  reservation_number: string; room: string; linked_rooms: string[] | null;
  check_in_date: string; check_out_date: string; is_blackout: boolean;
  is_unallocated_vr: boolean; number_of_guests: number; guest: string; nights: number;
  blackout_reason: string | null;
};

// Window: the request span plus slack, so overlapping stays on both edges are seen.
const winFrom = addDays(checkIn, -60);
const winTo = addDays(checkOut, 60);

const rows = (await sql`
  select reservation_number, room, linked_rooms,
         check_in_date::text as check_in_date, check_out_date::text as check_out_date,
         is_blackout, blackout_reason, is_unallocated_vr, number_of_guests,
         (first_name || ' ' || last_name) as guest, number_of_nights as nights
  from bookings_mirror
  where is_cancelled = false
    and check_in_date < ${winTo} and check_out_date > ${winFrom}
  order by check_in_date
`) as unknown as Row[];

/** Physical units a row occupies. Empty ⇒ unallocated VR (needs placement). */
function unitsOf(r: Row): string[] {
  const linked = (r.linked_rooms ?? []).filter((x) => ALL_ROOMS.includes(x));
  if (linked.length) return linked;
  if (ALL_ROOMS.includes(r.room)) return [r.room];
  return [];
}

const inHouse = (r: Row) => r.check_in_date <= TODAY;
const movable = (r: Row) => !r.is_blackout && !inHouse(r);

// ── Availability without any shuffle ─────────────────────────────────────────
type Span = { from: string; to: string };
const busy: Record<string, Span[]> = Object.fromEntries(ALL_ROOMS.map((r) => [r, [] as Span[]]));
const unallocatedByGroup = new Map<string, Row[]>();

for (const r of rows) {
  const units = unitsOf(r);
  if (!units.length) {
    // Unallocated VR booking — belongs to a group but holds no specific unit yet.
    const g = ALLOCATION_GROUPS.find((x) => x.typeLabel === r.room);
    if (g) unallocatedByGroup.set(g.typeLabel, [...(unallocatedByGroup.get(g.typeLabel) ?? []), r]);
    continue;
  }
  for (const u of units) busy[u].push({ from: r.check_in_date, to: r.check_out_date });
}

const freeFor = (room: string, from: string, to: string) =>
  !busy[room].some((s) => s.from < to && s.to > from);

/** Furthest checkout reachable in `room` starting at `from`, no shuffle. */
function maxEndNoShuffle(room: string, from: string, cap: string): string {
  const blockers = busy[room].filter((s) => s.to > from).map((s) => s.from).filter((f) => f > from);
  const firstBlock = blockers.length ? blockers.sort()[0] : cap;
  return firstBlock < cap ? firstBlock : cap;
}

// ── Availability WITH within-type shuffle (oracle = the live solver) ─────────
/** Existing bookings of a group as solver inputs (combos split into pinned parts). */
function groupInputs(groupLabel: string): ReallocInput[] {
  const g = ALLOCATION_GROUPS.find((x) => x.typeLabel === groupLabel)!;
  const unitNames = g.units.map((u) => u.room);
  const out: ReallocInput[] = [];
  for (const r of rows) {
    const units = unitsOf(r).filter((u) => unitNames.includes(u));
    if (units.length > 1) {
      // Combo stay (e.g. K.202 + K.203): pin every leg, it cannot be shuffled.
      units.forEach((u, i) =>
        out.push({ reservationNumber: `${r.reservation_number}#${i}`, checkIn: r.check_in_date, checkOut: r.check_out_date, currentRoom: u, movable: false }),
      );
    } else if (units.length === 1) {
      out.push({ reservationNumber: r.reservation_number, checkIn: r.check_in_date, checkOut: r.check_out_date, currentRoom: units[0], movable: movable(r) });
    }
  }
  for (const r of unallocatedByGroup.get(groupLabel) ?? []) {
    out.push({ reservationNumber: r.reservation_number, checkIn: r.check_in_date, checkOut: r.check_out_date, currentRoom: null, movable: true });
  }
  return out;
}
const GROUP_INPUTS = new Map(ALLOCATION_GROUPS.map((g) => [g.typeLabel, groupInputs(g.typeLabel)]));

/** Can this group host [from,to) in ONE unit, allowing within-type shuffles? */
function tryGroup(groupLabel: string, from: string, to: string) {
  const g = ALLOCATION_GROUPS.find((x) => x.typeLabel === groupLabel)!;
  const inputs: ReallocInput[] = [
    ...GROUP_INPUTS.get(groupLabel)!,
    { reservationNumber: 'REQUEST', checkIn: from, checkOut: to, currentRoom: null, movable: true },
  ];
  const plan = planReallocation(g, inputs);
  if (!plan.feasible) return null;
  const placement = plan.placements.find((p) => p.reservationNumber === 'REQUEST');
  return { room: placement?.room ?? '?', moves: plan.moves.length, plan };
}

/** Furthest checkout reachable from `from` in this group WITH shuffle (binary search). */
function maxEndWithShuffle(groupLabel: string, from: string, cap: string) {
  if (!tryGroup(groupLabel, from, addDays(from, 1))) return null;
  let lo = 1, hi = nightsBetween(from, cap), best = tryGroup(groupLabel, from, addDays(from, 1))!;
  let bestN = 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const got = tryGroup(groupLabel, from, addDays(from, mid));
    if (got) { best = got; bestN = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return { end: addDays(from, bestN), ...best };
}

// ── Pricing ──────────────────────────────────────────────────────────────────
type PriceRow = { listing_id: string; stay_date: string; live: string | null; rec: string | null };
const priceRows = (await sql`
  select listing_id, stay_date::text as stay_date, live_price as live, recommended_price as rec
  from market_daily where stay_date >= ${checkIn} and stay_date < ${checkOut}
`) as unknown as PriceRow[];
const priceIdx = new Map<string, { live: number | null; rec: number | null }>();
for (const p of priceRows) {
  priceIdx.set(`${p.listing_id}|${p.stay_date}`, {
    live: p.live == null ? null : Number(p.live),
    rec: p.rec == null ? null : Number(p.rec),
  });
}
function priceSegment(room: string, from: string, to: string) {
  const listing = LISTING_FOR_ROOM[room];
  let total = 0, nights = 0, fromLive = 0, fromRec = 0, missing = 0;
  for (let d = from; d < to; d = addDays(d, 1)) {
    nights++;
    const p = priceIdx.get(`${listing}|${d}`);
    if (p?.live != null) { total += p.live; fromLive++; }
    else if (p?.rec != null) { total += p.rec; fromRec++; }
    else missing++;
  }
  return { total, nights, fromLive, fromRec, missing, adr: nights ? total / nights : 0 };
}

// ── Scenarios ────────────────────────────────────────────────────────────────
const totalNights = nightsBetween(checkIn, checkOut);
console.log(`\n═══ REQUEST  ${checkIn} → ${checkOut}   (${totalNights} nights${guests ? `, ${guests} guests` : ''})`);
console.log(`    Prague today: ${TODAY}   ·   occupancy rows in window: ${rows.length}\n`);

// Capacity, inferred from history (no capacity table exists locally).
if (guests) {
  const caps = new Map<string, number>();
  for (const r of rows) for (const u of unitsOf(r)) caps.set(u, Math.max(caps.get(u) ?? 0, r.number_of_guests));
  console.log('— max guests ever hosted per unit (capacity proxy, NOT authoritative):');
  console.log('  ' + ALL_ROOMS.map((r) => `${r}:${caps.get(r) ?? '?'}`).join('  ') + '\n');
}

// 1. Single room, whole stay, no moves.
const wholeStay = ALL_ROOMS.filter((r) => freeFor(r, checkIn, checkOut));
console.log('╭─ A. ONE ROOM, NO MOVES');
if (wholeStay.length) {
  for (const r of wholeStay) {
    const p = priceSegment(r, checkIn, checkOut);
    console.log(`│  ✅ ${r} (${TYPE_OF_ROOM[r]})  ${p.total.toLocaleString('cs-CZ')} CZK   ADR ${Math.round(p.adr).toLocaleString('cs-CZ')}  [live ${p.fromLive}/${p.nights}, rec ${p.fromRec}, gaps ${p.missing}]`);
  }
} else console.log('│  ❌ no single unit is free for the whole span');

// 2. One room after a within-type shuffle.
console.log('╰─\n╭─ B. ONE ROOM, WITH WITHIN-TYPE SHUFFLE');
let anyShuffle = false;
for (const g of ALLOCATION_GROUPS) {
  const got = tryGroup(g.typeLabel, checkIn, checkOut);
  if (got) {
    anyShuffle = true;
    const p = priceSegment(got.room, checkIn, checkOut);
    console.log(`│  ✅ ${g.typeLabel}: place in ${got.room} after ${got.moves} move(s)  ${p.total.toLocaleString('cs-CZ')} CZK`);
    for (const m of got.plan.moves) console.log(`│       ↳ move ${m.reservationNumber} ${m.from} → ${m.to}`);
  } else {
    console.log(`│  ❌ ${g.typeLabel}: no arrangement even with shuffles`);
  }
}
if (!anyShuffle) console.log('│  (a split stay is the only option)');

// 3. Split stay — fewest segments (greedy jump), first without then with shuffle.
function splitPlan(useShuffle: boolean) {
  const segs: { room: string; from: string; to: string; moves: number; plan?: ReturnType<typeof tryGroup> }[] = [];
  let t = checkIn;
  let guard = 0;
  while (t < checkOut && guard++ < 40) {
    let best: { room: string; end: string; moves: number; plan?: ReturnType<typeof tryGroup> } | null = null;
    for (const room of ALL_ROOMS) {
      if (!freeFor(room, t, addDays(t, 1))) continue;
      const end = maxEndNoShuffle(room, t, checkOut);
      if (end > t && (!best || end > best.end)) best = { room, end, moves: 0 };
    }
    if (useShuffle) {
      for (const g of ALLOCATION_GROUPS) {
        const got = maxEndWithShuffle(g.typeLabel, t, checkOut);
        if (got && (!best || got.end > best.end || (got.end === best.end && got.moves < best.moves))) {
          best = { room: got.room, end: got.end, moves: got.moves, plan: got.plan as never };
        }
      }
    }
    if (!best) return { blockedAt: t };
    segs.push({ room: best.room, from: t, to: best.end, moves: best.moves });
    t = best.end;
  }
  return t >= checkOut ? { segs } : { blockedAt: t };
}

/** Who is holding `room` on the night of `date` — for the blocking-night report. */
function holderOf(room: string, date: string) {
  const r = rows.find((x) => unitsOf(x).includes(room) && x.check_in_date <= date && x.check_out_date > date);
  if (!r) return null;
  const who = r.is_blackout ? `BLACKOUT${r.blackout_reason ? ` (${r.blackout_reason})` : ''}` : r.guest.trim() || r.reservation_number;
  return `${who} ${r.check_in_date}→${r.check_out_date}${inHouse(r) ? ' [in-house]' : ''}`;
}

function reportBlocked(date: string) {
  console.log(`│  ❌ blocked on ${date} — no sellable unit free that night:`);
  for (const room of ALL_ROOMS) {
    const h = holderOf(room, date);
    console.log(`│       ${room}  ${h ?? 'free'}`);
  }
  console.log('│     → the stay cannot be sold through this night in any room type.');
}

const czk = (n: number) => `${Math.round(n).toLocaleString('cs-CZ')} CZK`;

for (const [label, useShuffle] of [['C. ITINERARY, NO SHUFFLE ALLOWED', false], ['D. ITINERARY, SHUFFLE ALLOWED', true]] as const) {
  console.log('╰─\n╭─ ' + label);
  const result = splitPlan(useShuffle);
  if (!result.segs) { reportBlocked(result.blockedAt!); continue; }
  const segs = result.segs;
  let gross = 0, moves = 0, gaps = 0;
  console.log('│  #  dates                    n   sellable unit        list price      ADR   allocation');
  segs.forEach((s, i) => {
    const p = priceSegment(s.room, s.from, s.to);
    gross += p.total; moves += s.moves; gaps += p.missing;
    const alloc = s.moves ? `${s.room} after ${s.moves} shuffle move(s)` : `${s.room}, no moves`;
    console.log(
      `│  ${i + 1}  ${s.from}→${s.to}  ${String(p.nights).padStart(2)}n  ` +
      `${TYPE_OF_ROOM[s.room].padEnd(14)} ${czk(p.total).padStart(12)} ${czk(p.adr).padStart(9)}   ${alloc}`,
    );
  });
  const net = gross * (1 - discountPct / 100);
  console.log(`│  ── ${segs.length} reservation(s) · ${segs.length - 1} guest move(s)${moves ? ` · ${moves} shuffle move(s) of other guests` : ''}`);
  console.log(`│  ── LIST TOTAL  ${czk(gross)}   (${totalNights} nights, ADR ${czk(gross / totalNights)})${gaps ? `  ⚠ ${gaps} night(s) unpriced` : ''}`);
  if (discountPct) {
    console.log(`│  ── DISCOUNT    −${discountPct}%  = −${czk(gross - net)}`);
    console.log(`│  ── QUOTE       ${czk(net)}   (ADR ${czk(net / totalNights)})`);
    console.log('│     per reservation after discount:');
    segs.forEach((s, i) => {
      const p = priceSegment(s.room, s.from, s.to);
      console.log(`│       ${i + 1}. ${s.from}→${s.to}  ${TYPE_OF_ROOM[s.room].padEnd(14)} ${czk(p.total * (1 - discountPct / 100)).padStart(12)}`);
    });
  }
}
console.log('╰─');
console.log('\n⚠ prices above are LIST sums of our daily asking rate (market_daily.live_price,');
console.log('  PriceLabs recommended as fallback) — NOT Beds24-evaluated offers. The real quote');
console.log('  per segment comes from /inventory/rooms/offers on the server, which applies rate');
console.log('  plans and LOS rules. Expect the Beds24 number to be lower on long segments.\n');

// Occupancy grid for the eyeball check.
console.log('— occupancy in the request window (X = held, · = free):');
const gridDays: string[] = [];
for (let d = checkIn; d < checkOut; d = addDays(d, 1)) gridDays.push(d);
const head = gridDays.map((d) => d.slice(8, 10).padStart(2)).join('');
console.log('        ' + head);
for (const room of ALL_ROOMS) {
  const line = gridDays.map((d) => (freeFor(room, d, addDays(d, 1)) ? ' ·' : ' X')).join('');
  console.log(room.padEnd(8) + line);
}
const unal = [...unallocatedByGroup.values()].flat();
if (unal.length) {
  console.log('\n⚠ unallocated VR bookings in play (must also be placed):');
  for (const r of unal) console.log(`   ${r.reservation_number} ${r.guest} ${r.check_in_date}→${r.check_out_date} (${r.room})`);
}
console.log();

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

// Bypass Next.js's static route-handler cache — must read live Redis state
// on every request, otherwise newly logged consumable / assignment / pickup
// entries don't surface in the reporting dashboard until a redeploy.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// ── Redis keys (must match baker-house-cleaning/src/lib/storage.ts) ──────────
const KEY_CLEANERS_CONFIG = 'baker:cleaners-config';
const KEY_CLEANING_ASSIGNMENTS = 'baker:cleaning-assignments';
const KEY_MANUAL_CLEANING_EVENTS = 'baker:manual-cleaning-events';
const KEY_LAUNDRY_CONFIG = 'baker:laundry-config';
const KEY_LAUNDRY_ASSIGNMENTS = 'baker:laundry-assignments';
const KEY_CONSUMABLE_ENTRIES = 'baker:consumable-entries';

// ── Room mapping: Beds24 roomId → reporting display name ─────────────────────
// Matches cleaning app src/lib/room-mapping.ts + reporting types/reservation.ts
export const BEDS24_ID_TO_ROOM: Record<string, string> = {
  // Deluxe
  '656437': 'K.201',
  '648596': 'K.202',
  '648772': 'K.203',
  '674672': 'O.308',
  // Urban (new — opening soon)
  '679703': 'K.102',
  '679704': 'K.103',
  '679705': 'K.106',
};

// Reverse: reporting room display name → Beds24 roomId
export const ROOM_TO_BEDS24_ID: Record<string, string> = Object.fromEntries(
  Object.entries(BEDS24_ID_TO_ROOM).map(([id, name]) => [name, id])
);

// ── Types mirrored from cleaning app ─────────────────────────────────────────
interface CleanersConfig {
  cleaners: { id: string; name: string }[];
  rates: Record<string, Record<string, number>>; // rates[cleanerId][roomId]
  /** Cleaners archived from a slot — historical fee lookups fall back here. */
  archived?: ArchivedCleaner[];
}

/** Mirrors cleaning app's ArchivedCleaner — kept inline to avoid a shared dep. */
interface ArchivedCleaner {
  id: string;
  originalSlotId: string;
  name: string;
  color: string;
  deactivatedAt: string;
  archivedAt: string;
  rates: Record<string, number>;
}

interface LaundryProviderSlot {
  id: string;
  name: string;
  /** Per-set pricing — cleaning-app's new model. */
  deluxeSetPrice?: number;
  urbanSetPrice?: number;
}

interface LaundryConfig {
  providers: LaundryProviderSlot[];
  rates: Record<string, Record<string, number>>; // rates[providerId][roomId] (legacy)
  /** Providers archived from a slot — historical fee lookups fall back here. */
  archived?: ArchivedLaundryProvider[];
}

/** Mirrors cleaning app's ArchivedLaundryProvider. */
interface ArchivedLaundryProvider {
  id: string;
  originalSlotId: string;
  name: string;
  deactivatedAt: string;
  archivedAt: string;
  rates: Record<string, number>;
  /** Snapshotted per-set prices at the time of archival. */
  deluxeSetPrice?: number;
  urbanSetPrice?: number;
}

/** baker:laundry-sets blob (subset we need here). */
interface LaundrySetsConfig {
  setsPerRoom: Record<string, number>;
}

/** Room → category map. Mirrors cleaning app's room-mapping.ts. */
const ROOM_CATEGORIES: Record<string, 'deluxe' | 'urban'> = {
  '656437': 'deluxe', // K.201
  '648596': 'deluxe', // K.202
  '648772': 'deluxe', // K.203
  '674672': 'deluxe', // O.308
  '679703': 'urban',  // K.102
  '679704': 'urban',  // K.103
  '679705': 'urban',  // K.106
};

/** Cost for a single laundry assignment given the per-set price model
 *  with a fallback to the legacy per-room rates. Mirror of cleaning
 *  app's getLaundryAssignmentCost in cleaning-types.ts. */
function laundryCostForAssignment(
  provider: LaundryProviderSlot | ArchivedLaundryProvider,
  roomId: string,
  setsPerRoom: Record<string, number>,
  legacyRates: Record<string, Record<string, number>>
): number {
  const setsForRoom = setsPerRoom[roomId] ?? 1;
  const category = ROOM_CATEGORIES[roomId];
  let perSet: number | undefined;
  if (category === 'deluxe') perSet = provider.deluxeSetPrice;
  else if (category === 'urban') perSet = provider.urbanSetPrice;
  if (typeof perSet === 'number' && perSet > 0) {
    return Math.round(perSet * setsForRoom);
  }
  return legacyRates[provider.id]?.[roomId] ?? 0;
}

// Cleaning assignments: nested date → roomId → cleanerId
type CleaningAssignmentsNested = Record<string, Record<string, string>>;

// Laundry assignments: flat "date|roomId" → providerId
type LaundryAssignmentsFlat = Record<string, string | null>;

/** Manually-added cleaning event from cleaning app (off-checkout cleanings). */
interface ManualCleaningEvent {
  id: string;
  date: string;       // YYYY-MM-DD
  roomId: string;
  roomName: string;
  price?: number;     // optional custom override price (CZK)
  cleanerName?: string;
  createdAt: string;
  /** Cleaning-app reservation tie ("BH-{bookId}"). Optional for back-compat. */
  reservationNumber?: string;
}

interface ConsumableEntry {
  id: string;
  date: string;
  roomId: string;
  amount: number;
  /** Cleaning-app reservation tie ("BH-{bookId}"). Optional for back-compat. */
  reservationNumber?: string;
}

export interface VariableCostEntry {
  cleaning: number;
  laundry: number;
  consumables: number;
}

// ── Response type: a flat map by "date|roomId" (legacy) + a byReservation
//     map. Entries that carry a reservationNumber land in byReservation;
//     entries without one fall back to byDateRoom so they still surface.
export type VariableCostsLookup = Record<string, VariableCostEntry>;
export interface VariableCostsResponse {
  byDateRoom: VariableCostsLookup;
  byReservation: Record<string, VariableCostEntry>;
}

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function GET() {
  const redis = getRedis();
  if (!redis) {
    return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });
  }

  // Fetch all 7 keys in parallel
  const [
    cleanersRaw,
    assignmentsRaw,
    manualCleaningRaw,
    laundryRaw,
    laundryAssignmentsRaw,
    laundrySetsRaw,
    entriesRaw,
  ] = await Promise.all([
    redis.get(KEY_CLEANERS_CONFIG),
    redis.get(KEY_CLEANING_ASSIGNMENTS),
    redis.get(KEY_MANUAL_CLEANING_EVENTS),
    redis.get(KEY_LAUNDRY_CONFIG),
    redis.get(KEY_LAUNDRY_ASSIGNMENTS),
    redis.get('baker:laundry-sets'),
    redis.get(KEY_CONSUMABLE_ENTRIES),
  ]);

  const cleanersConfig = (cleanersRaw ?? { cleaners: [], rates: {}, archived: [] }) as CleanersConfig;
  // Merge archived cleaner rates into the lookup so historical assignments
  // that now reference an archive id still resolve to the correct fee.
  for (const a of cleanersConfig.archived ?? []) {
    cleanersConfig.rates[a.id] = { ...a.rates };
  }
  const cleaningAssignments = (assignmentsRaw ?? {}) as CleaningAssignmentsNested;
  const manualCleaningEvents = (Array.isArray(manualCleaningRaw) ? manualCleaningRaw : []) as ManualCleaningEvent[];
  const laundryConfig = (laundryRaw ?? { providers: [], rates: {}, archived: [] }) as LaundryConfig;
  // Merge archived providers into the slot list so a per-set price snapshot
  // on an archive id is also discoverable when we look up the provider.
  const providerById = new Map<string, LaundryProviderSlot | ArchivedLaundryProvider>();
  for (const p of laundryConfig.providers ?? []) providerById.set(p.id, p);
  for (const a of laundryConfig.archived ?? []) providerById.set(a.id, a);
  // Keep the legacy per-room map populated for the fallback path.
  for (const a of laundryConfig.archived ?? []) {
    laundryConfig.rates[a.id] = { ...a.rates };
  }
  const laundryAssignments = (laundryAssignmentsRaw ?? {}) as LaundryAssignmentsFlat;
  const laundrySets = (laundrySetsRaw ?? { setsPerRoom: {} }) as LaundrySetsConfig;
  const consumableEntries = (entriesRaw ?? []) as ConsumableEntry[];

  const lookup: VariableCostsLookup = {};
  const byReservation: Record<string, VariableCostEntry> = {};

  function ensureEntry(date: string, roomId: string): VariableCostEntry {
    const key = `${date}|${roomId}`;
    if (!lookup[key]) lookup[key] = { cleaning: 0, laundry: 0, consumables: 0 };
    return lookup[key];
  }
  function ensureRes(reservationNumber: string): VariableCostEntry {
    if (!byReservation[reservationNumber]) {
      byReservation[reservationNumber] = { cleaning: 0, laundry: 0, consumables: 0 };
    }
    return byReservation[reservationNumber];
  }

  // ── Cleaning: nested assignments[date][roomId] → cleanerId → rate ────────
  for (const [date, rooms] of Object.entries(cleaningAssignments)) {
    for (const [roomId, cleanerId] of Object.entries(rooms)) {
      if (!cleanerId) continue;
      const rate = cleanersConfig.rates[cleanerId]?.[roomId] ?? 0;
      if (rate > 0) {
        ensureEntry(date, roomId).cleaning = rate;
      }
    }
  }

  // ── Manual cleaning events: off-checkout cleanings added in the cleaning
  //    app. If the operator set a custom price, that overrides any
  //    assignment-derived rate for the same (date, roomId). If no custom
  //    price was set, the regular cleaner-assignment rate above (if any)
  //    is left in place; if neither exists the entry stays at 0.
  for (const event of manualCleaningEvents) {
    if (!event?.date || !event?.roomId) continue;
    const hasPrice = typeof event.price === 'number' && event.price > 0;
    if (event.reservationNumber) {
      // Reservation-linked manual cleanings attribute their fee directly to
      // that reservation in byReservation, NOT into the byDateRoom map
      // (avoids double-counting on the dashboard side).
      if (hasPrice) ensureRes(event.reservationNumber).cleaning += event.price!;
    } else if (hasPrice) {
      ensureEntry(event.date, event.roomId).cleaning = event.price!;
    } else {
      // Make sure the cell exists (so the room shows up in reporting even
      // when neither a price nor an assignment-rate is present yet).
      ensureEntry(event.date, event.roomId);
    }
  }

  // ── Laundry: flat assignments["date|roomId"] → providerId → cost ─────────
  //    Cost = sets × per-set price for the room's category, falling back to
  //    legacy per-room rate when the provider hasn't migrated yet.
  for (const [key, providerId] of Object.entries(laundryAssignments)) {
    if (!providerId) continue;
    const [date, roomId] = key.split('|');
    if (!date || !roomId) continue;
    const provider = providerById.get(providerId);
    if (!provider) continue;
    const cost = laundryCostForAssignment(provider, roomId, laundrySets.setsPerRoom, laundryConfig.rates);
    if (cost > 0) {
      ensureEntry(date, roomId).laundry = cost;
    }
  }

  // ── Consumables: sum entries — by reservation when linked, else by
  //     date+roomId so legacy entries still surface somewhere.
  for (const entry of consumableEntries) {
    if (!entry.amount || entry.amount <= 0) continue;
    if (entry.reservationNumber) {
      ensureRes(entry.reservationNumber).consumables += entry.amount;
    } else {
      ensureEntry(entry.date, entry.roomId).consumables += entry.amount;
    }
  }

  const body: VariableCostsResponse = { byDateRoom: lookup, byReservation };
  return NextResponse.json(body);
}

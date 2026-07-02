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
const KEY_FIXED_COSTS_CONFIG = 'baker:fixed-costs-config';
const KEY_WEAR_TEAR_EVENTS = 'baker:wear-tear-events';
const KEY_DAMAGES_EVENTS = 'baker:damages-events';

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

/** Mirrors cleaning app's IncidentEvent (wear & tear / damages event log). */
interface IncidentEvent {
  id: string;
  date: string;     // YYYY-MM-DD
  roomId: string;
  roomName?: string;
  amount: number;
  note?: string;
  createdAt?: string;
}

/** Mirrors cleaning app's FixedCostItem (now exposed as Subscriptions). */
interface SubscriptionItemRaw {
  id: string;
  label: string;
  rooms: Record<string, { enabled: boolean; monthlyAmount: number }>;
  startDate?: string;
  endDate?: string;
}

/** Subscription item shape returned to clients — same as raw + dates. */
export interface SubscriptionItem {
  id: string;
  label: string;
  rooms: Record<string, { enabled: boolean; monthlyAmount: number }>;
  startDate?: string;
  endDate?: string;
}

export interface VariableCostEntry {
  cleaning: number;
  laundry: number;
  consumables: number;
  /** Wear & Tear incident costs for this (date|roomId) or reservation. */
  wearTear: number;
  /** Damages incident costs for this (date|roomId) or reservation. */
  damages: number;
  // ── Unit counts (parallel to the cost fields) for the per-unit overview ──
  /** Laundry sets consumed (Σ setsPerRoom over laundry events). */
  laundrySets?: number;
  /** Consumable sets logged (1 per entry). */
  consumableUnits?: number;
  /** Wear & Tear incidents (1 per event). */
  wearTearUnits?: number;
  /** Damages incidents (1 per event). */
  damagesUnits?: number;
}

// ── Response type: a flat map by "date|roomId" (legacy) + a byReservation
//     map. Entries that carry a reservationNumber land in byReservation;
//     entries without one fall back to byDateRoom so they still surface.
//     Subscriptions are recurring monthly costs not tied to a date — exposed
//     separately so the bridge can scale them by months-in-period.
export type VariableCostsLookup = Record<string, VariableCostEntry>;
export interface VariableCostsResponse {
  byDateRoom: VariableCostsLookup;
  byReservation: Record<string, VariableCostEntry>;
  /** Subscriptions: monthlyAmount per Beds24 roomId (sum across line items)
   *  — legacy snapshot, ignores effective dates. Callers that need
   *  time-aware accounting should use `subscriptionItems`. */
  subscriptionsByRoom: Record<string, number>;
  /** Raw subscription items with effective dates. Callers compute
   *  months-active-in-range × monthlyAmount per scoped room. */
  subscriptionItems: SubscriptionItem[];
  /** "date|roomId" of manually-added (off-checkout) cleanings — i.e. extra
   *  cleanings (mid-stay / special) on top of the checkout cleaning. */
  manualCleaningKeys: string[];
  /** "date|roomId" of cleanings the operator marked "no laundry" (mid-stay /
   *  special cleanings that don't change linen → no laundry event). */
  noLaundryKeys: string[];
  /** "date|roomId" of cleanings the operator removed (e.g. stay prolonged) —
   *  the reservation still counts but no cleaning happened. */
  dismissedCleaningKeys: string[];
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

  // Fetch all keys in parallel — schedule snapshot lets us validate that
  // a laundry assignment still has an underlying cleaning event (skip
  // orphans left behind by past cancellations).
  const [
    cleanersRaw,
    assignmentsRaw,
    manualCleaningRaw,
    laundryRaw,
    laundryAssignmentsRaw,
    laundrySetsRaw,
    manualLaundryRaw,
    entriesRaw,
    subscriptionsRaw,
    wearTearRaw,
    damagesRaw,
    noLaundryRaw,
    dismissedRaw,
  ] = await Promise.all([
    redis.get(KEY_CLEANERS_CONFIG),
    redis.get(KEY_CLEANING_ASSIGNMENTS),
    redis.get(KEY_MANUAL_CLEANING_EVENTS),
    redis.get(KEY_LAUNDRY_CONFIG),
    redis.get(KEY_LAUNDRY_ASSIGNMENTS),
    redis.get('baker:laundry-sets'),
    redis.get('baker:manual-laundry-events'),
    redis.get(KEY_CONSUMABLE_ENTRIES),
    redis.get(KEY_FIXED_COSTS_CONFIG),
    redis.get(KEY_WEAR_TEAR_EVENTS),
    redis.get(KEY_DAMAGES_EVENTS),
    redis.get('baker:no-laundry-cleanings'),
    redis.get('baker:dismissed-cleanings'),
  ]);

  // Set of valid (date, roomId) cleanings — Beds24 tasks + manual laundry
  // events. Used to reject orphan laundry assignments whose underlying
  // event has been removed.
  const validLaundryKeys = new Set<string>();
  try {
    const snapRaw = (await redis.get('baker:beds24-schedule-snapshot')) as {
      schedule?: { tasks?: Array<{ date: string; roomId: string }> };
    } | null;
    for (const t of snapRaw?.schedule?.tasks ?? []) {
      validLaundryKeys.add(`${t.date}|${t.roomId}`);
    }
  } catch {
    /* if snapshot missing, fall back to counting every assignment */
  }
  const manualLaundryEvents = (Array.isArray(manualLaundryRaw) ? manualLaundryRaw : []) as Array<{
    date: string;
    roomId: string;
  }>;
  for (const m of manualLaundryEvents) {
    validLaundryKeys.add(`${m.date}|${m.roomId}`);
  }
  // Manual (off-checkout) cleanings are real cleanings too — their laundry
  // must not be treated as an orphan just because there's no Beds24 checkout
  // task on that date. Without this, a mid-stay/special cleaning's laundry was
  // silently dropped from the reporting totals.
  for (const m of (Array.isArray(manualCleaningRaw) ? manualCleaningRaw : []) as Array<{ date?: string; roomId?: string }>) {
    if (m?.date && m?.roomId) validLaundryKeys.add(`${m.date}|${m.roomId}`);
  }

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
    if (!lookup[key]) {
      lookup[key] = { cleaning: 0, laundry: 0, consumables: 0, wearTear: 0, damages: 0, laundrySets: 0, consumableUnits: 0, wearTearUnits: 0, damagesUnits: 0 };
    }
    return lookup[key];
  }
  function ensureRes(reservationNumber: string): VariableCostEntry {
    if (!byReservation[reservationNumber]) {
      byReservation[reservationNumber] = {
        cleaning: 0, laundry: 0, consumables: 0, wearTear: 0, damages: 0, laundrySets: 0, consumableUnits: 0, wearTearUnits: 0, damagesUnits: 0,
      };
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
    // Skip orphan assignments (cleaning event has since been cancelled).
    // If the snapshot wasn't available the set is empty — fall through and
    // count everything to avoid silently zeroing the dashboard.
    if (validLaundryKeys.size > 0 && !validLaundryKeys.has(key)) continue;
    const [date, roomId] = key.split('|');
    if (!date || !roomId) continue;
    const provider = providerById.get(providerId);
    if (!provider) continue;
    const cost = laundryCostForAssignment(provider, roomId, laundrySets.setsPerRoom, laundryConfig.rates);
    if (cost > 0) {
      const e = ensureEntry(date, roomId);
      e.laundry = cost;
      e.laundrySets = (e.laundrySets ?? 0) + (laundrySets.setsPerRoom[roomId] ?? 1);
    }
  }

  // ── Consumables: one set per checkout, bucketed by (date, roomId) exactly
  //     like cleaning & laundry. Attributing by reservationNumber instead
  //     silently dropped multi-room bookings: Beds24 splits a multi-room stay
  //     into a master + sub-bookings, and the reporting side collapses them
  //     into ONE reservation — so a set logged against a sub-booking's bookId
  //     matched no reservation and vanished from the P&L. Date+room keys the
  //     physical checkout, so every room's set counts, and consumables now
  //     behave identically to cleaning/laundry (incl. how refunded stays are
  //     handled). entry.reservationNumber is kept on the record for
  //     traceability but is intentionally NOT used for cost bucketing.
  for (const entry of consumableEntries) {
    if (!entry.amount || entry.amount <= 0) continue;
    const e = ensureEntry(entry.date, entry.roomId);
    e.consumables += entry.amount;
    e.consumableUnits = (e.consumableUnits ?? 0) + 1;
  }

  // ── Wear & Tear: incident events (no reservation link). Aggregated by
  //    (date, roomId) so they bucket into the same period+room scope as
  //    cleaning/laundry/consumables.
  const wearTearEvents = (Array.isArray(wearTearRaw) ? wearTearRaw : []) as IncidentEvent[];
  for (const ev of wearTearEvents) {
    if (!ev?.date || !ev?.roomId) continue;
    if (!ev.amount || ev.amount <= 0) continue;
    const e = ensureEntry(ev.date, ev.roomId);
    e.wearTear += ev.amount;
    e.wearTearUnits = (e.wearTearUnits ?? 0) + 1;
  }

  // ── Damages: same shape as wear & tear.
  const damagesEvents = (Array.isArray(damagesRaw) ? damagesRaw : []) as IncidentEvent[];
  for (const ev of damagesEvents) {
    if (!ev?.date || !ev?.roomId) continue;
    if (!ev.amount || ev.amount <= 0) continue;
    const e = ensureEntry(ev.date, ev.roomId);
    e.damages += ev.amount;
    e.damagesUnits = (e.damagesUnits ?? 0) + 1;
  }

  // ── Subscriptions: recurring monthly per-room costs (internet, TV, …).
  //    Return raw items with effective dates for time-aware accounting,
  //    plus a flat byRoom snapshot for legacy callers that ignore dates.
  const subscriptionItemsRaw = (Array.isArray(subscriptionsRaw) ? subscriptionsRaw : []) as SubscriptionItemRaw[];
  const subscriptionItems: SubscriptionItem[] = subscriptionItemsRaw.map((item) => ({
    id: item.id,
    label: item.label,
    rooms: item.rooms ?? {},
    ...(item.startDate ? { startDate: item.startDate } : {}),
    ...(item.endDate ? { endDate: item.endDate } : {}),
  }));
  const subscriptionsByRoom: Record<string, number> = {};
  for (const item of subscriptionItems) {
    for (const [roomId, cfg] of Object.entries(item.rooms ?? {})) {
      if (!cfg?.enabled) continue;
      if (!cfg.monthlyAmount || cfg.monthlyAmount <= 0) continue;
      subscriptionsByRoom[roomId] = (subscriptionsByRoom[roomId] ?? 0) + cfg.monthlyAmount;
    }
  }

  const manualCleaningKeys = manualCleaningEvents.map((e) => `${e.date}|${e.roomId}`);
  const noLaundryKeys = (Array.isArray(noLaundryRaw) ? noLaundryRaw : []) as string[];
  const dismissedCleaningKeys = (Array.isArray(dismissedRaw) ? dismissedRaw : [])
    .map((d: { date?: string; roomId?: string }) => (d?.date && d?.roomId ? `${d.date}|${d.roomId}` : ''))
    .filter(Boolean);

  const body: VariableCostsResponse = {
    byDateRoom: lookup,
    byReservation,
    subscriptionsByRoom,
    subscriptionItems,
    manualCleaningKeys,
    noLaundryKeys,
    dismissedCleaningKeys,
  };
  return NextResponse.json(body);
}

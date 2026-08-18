/**
 * The variable-cost engine — cleaning, laundry, consumables, wear & tear, misc
 * and subscriptions, per (date, room) and per reservation.
 *
 * EXTRACTED VERBATIM from `app/api/variable-costs/route.ts`, which is now a thin
 * wrapper around `computeVariableCosts()`. Nothing about the calculation changed;
 * it moved so a SECOND caller (the analytics cost view) can reuse it instead of
 * re-deriving cost logic that would immediately drift from the P&L.
 *
 * WHY THIS STILL READS REDIS: the cleaning app's *assignments* have migrated to
 * `cleaning.*` in Postgres, but the RATE CARDS have not — cleaner fees, laundry
 * per-set prices, subscription amounts, wear & tear and misc events all still
 * live in Redis and are owned by the other app. A cost figure therefore cannot be
 * computed in SQL today. That is the one place the analytics section touches
 * Redis, it happens on a single tab, and moving those rate cards to Postgres is
 * the change that would make even this unnecessary.
 *
 * Server-only: reaches Upstash and `@/lib/db`. Never import it from a client
 * component (see the note at the top of `lib/db.ts`).
 */
import { Redis } from '@upstash/redis';
import {
  readCleaningAssignmentsPg,
  readLaundryAssignmentsPg,
  readConsumableEntriesPg,
} from '@/utils/cleaningDataPg';
import {
  type SubscriptionItem,
  type VariableCostEntry,
  type VariableCostsLookup,
  type VariableCostsResponse,
} from '@/utils/variableCostsShared';

// ── Redis keys (must match baker-house-cleaning/src/lib/storage.ts) ──────────
const KEY_CLEANERS_CONFIG = 'baker:cleaners-config';
const KEY_CLEANING_ASSIGNMENTS = 'baker:cleaning-assignments';
const KEY_MANUAL_CLEANING_EVENTS = 'baker:manual-cleaning-events';
const KEY_LAUNDRY_CONFIG = 'baker:laundry-config';
const KEY_LAUNDRY_ASSIGNMENTS = 'baker:laundry-assignments';
const KEY_CONSUMABLE_ENTRIES = 'baker:consumable-entries';
const KEY_FIXED_COSTS_CONFIG = 'baker:fixed-costs-config';
const KEY_WEAR_TEAR_EVENTS = 'baker:wear-tear-events';
// "Misc" is the renamed ad-hoc bucket (was "Other"), stored under the legacy
// other-cost-events key. The old standalone "Damages" category was retired —
// breakage now goes under Wear & Tear.
const KEY_MISC_EVENTS = 'baker:other-cost-events';

// Room mapping + the response contract live in `@/utils/variableCostsShared`
// (imported at the top of this file). They are NOT re-exported from here on
// purpose: a value import from a route handler pulls this module's server-only
// dependencies into the client bundle.

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

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

/**
 * Where the CLEANING APP's three migrated domains are read from.
 * `READ_CLEANING_DATA=postgres` switches cleaning assignments, laundry
 * assignments and consumable entries to `cleaning.*` in the shared Neon
 * database; anything else keeps the legacy Redis keys. Defaults to redis, so
 * deploying this changes nothing.
 *
 * MUST be flipped to `postgres` BEFORE the cleaning app moves those domains
 * from `dual` to `postgres`. The moment it does, its Redis writes stop and
 * these keys freeze — reading them after that silently produces stale costs.
 * While the cleaning app is on `dual` both stores are identical, so either
 * value is correct and the switch can be verified at leisure.
 */
function readsCleaningFromPostgres(): boolean {
  return process.env.READ_CLEANING_DATA?.trim().toLowerCase() === 'postgres';
}


/**
 * Compute every variable cost the dashboard knows about.
 *
 * Returns null when Redis is not configured, so callers can decide between a 503
 * (the route) and degrading to a costs-unavailable state (analytics).
 */
export async function computeVariableCosts(): Promise<VariableCostsResponse | null> {

  const redis = getRedis();
  if (!redis) return null;

  // The three cleaning-app domains that have moved to Postgres. Everything
  // else on this route is still Redis-only (cleaner/laundry config, manual
  // events, subscriptions, wear&tear, misc, no-laundry, dismissed, adjustments).
  const fromPg = readsCleaningFromPostgres();

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
    miscRaw,
    noLaundryRaw,
    dismissedRaw,
    cleaningAdjustmentsRaw,
  ] = await Promise.all([
    redis.get(KEY_CLEANERS_CONFIG),
    fromPg ? readCleaningAssignmentsPg() : redis.get(KEY_CLEANING_ASSIGNMENTS),
    redis.get(KEY_MANUAL_CLEANING_EVENTS),
    redis.get(KEY_LAUNDRY_CONFIG),
    fromPg ? readLaundryAssignmentsPg() : redis.get(KEY_LAUNDRY_ASSIGNMENTS),
    redis.get('baker:laundry-sets'),
    redis.get('baker:manual-laundry-events'),
    fromPg ? readConsumableEntriesPg() : redis.get(KEY_CONSUMABLE_ENTRIES),
    redis.get(KEY_FIXED_COSTS_CONFIG),
    redis.get(KEY_WEAR_TEAR_EVENTS),
    redis.get(KEY_MISC_EVENTS),
    redis.get('baker:no-laundry-cleanings'),
    redis.get('baker:dismissed-cleanings'),
    redis.get('baker:cleaning-adjustments'),
  ]);

  // Checkout tasks from the current Beds24 schedule snapshot — the source of
  // truth for which (date, roomId) cells had a real checkout. The cleaning app
  // counts cleanings off these tasks, not off raw assignments, so we use them
  // to reject orphaned cleaning/laundry assignments left behind by cancelled
  // or moved bookings.
  const checkoutTaskKeys = new Set<string>();
  try {
    const snapRaw = (await redis.get('baker:beds24-schedule-snapshot')) as {
      schedule?: { tasks?: Array<{ date: string; roomId: string }> };
    } | null;
    for (const t of snapRaw?.schedule?.tasks ?? []) {
      checkoutTaskKeys.add(`${t.date}|${t.roomId}`);
    }
  } catch {
    /* if snapshot missing, fall back to counting every assignment */
  }
  // Only apply the orphan filter when we actually have a snapshot — otherwise
  // fall back to counting everything rather than silently zeroing the dashboard.
  const hasSnapshot = checkoutTaskKeys.size > 0;

  // Dismissed cleanings (operator removed — stay prolonged etc.). The cleaning
  // app filters these out of its task list before counting, so exclude them.
  const dismissedKeySet = new Set<string>(
    (Array.isArray(dismissedRaw) ? dismissedRaw : [])
      .map((d: { date?: string; roomId?: string }) => (d?.date && d?.roomId ? `${d.date}|${d.roomId}` : ''))
      .filter(Boolean),
  );

  // Manual (off-checkout) cleanings — real cleanings even without a Beds24
  // checkout task on that date.
  const manualCleaningKeySet = new Set<string>(
    (Array.isArray(manualCleaningRaw) ? manualCleaningRaw : [])
      .map((m: { date?: string; roomId?: string }) => (m?.date && m?.roomId ? `${m.date}|${m.roomId}` : ''))
      .filter(Boolean),
  );

  // Set of valid (date, roomId) LAUNDRY cells — Beds24 tasks + manual laundry
  // events + manual cleanings. Used to reject orphan laundry assignments whose
  // underlying event has been removed.
  const validLaundryKeys = new Set<string>(checkoutTaskKeys);
  const manualLaundryEvents = (Array.isArray(manualLaundryRaw) ? manualLaundryRaw : []) as Array<{
    date: string;
    roomId: string;
  }>;
  for (const m of manualLaundryEvents) {
    validLaundryKeys.add(`${m.date}|${m.roomId}`);
  }
  for (const k of manualCleaningKeySet) validLaundryKeys.add(k);

  // Set of valid (date, roomId) CLEANING cells — live checkout tasks (minus
  // dismissed) + manual cleanings. Mirrors the cleaning app, which only counts
  // a cleaning when a checkout task exists; a raw assignment left behind by a
  // cancelled/moved booking is an orphan and must not be billed.
  const validCleaningKeys = new Set<string>(manualCleaningKeySet);
  for (const k of checkoutTaskKeys) if (!dismissedKeySet.has(k)) validCleaningKeys.add(k);

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
      lookup[key] = { cleaning: 0, laundry: 0, consumables: 0, wearTear: 0, misc: 0, laundrySets: 0, consumableUnits: 0, wearTearUnits: 0, miscUnits: 0 };
    }
    return lookup[key];
  }
  function ensureRes(reservationNumber: string): VariableCostEntry {
    if (!byReservation[reservationNumber]) {
      byReservation[reservationNumber] = {
        cleaning: 0, laundry: 0, consumables: 0, wearTear: 0, misc: 0, laundrySets: 0, consumableUnits: 0, wearTearUnits: 0, miscUnits: 0,
      };
    }
    return byReservation[reservationNumber];
  }

  // ── Cleaning: nested assignments[date][roomId] → cleanerId → rate ────────
  //    An assignment only bills when a live checkout task (or manual cleaning)
  //    exists for that date+room — otherwise it's an orphan from a cancelled or
  //    moved booking. This mirrors the cleaning app, which counts checkout
  //    tasks rather than raw assignments.
  for (const [date, rooms] of Object.entries(cleaningAssignments)) {
    for (const [roomId, cleanerId] of Object.entries(rooms)) {
      if (!cleanerId) continue;
      const key = `${date}|${roomId}`;
      if (hasSnapshot && !validCleaningKeys.has(key)) continue;
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

  // ── Cleaning adjustments: operator surcharge / reduction on top of the base
  //    fee, keyed date|roomId. Applied only where a billed cleaning exists so a
  //    stale adjustment can't conjure a phantom cost.
  const cleaningAdjustments =
    cleaningAdjustmentsRaw && typeof cleaningAdjustmentsRaw === 'object' && !Array.isArray(cleaningAdjustmentsRaw)
      ? (cleaningAdjustmentsRaw as Record<string, { amount?: number }>)
      : {};
  for (const [key, adj] of Object.entries(cleaningAdjustments)) {
    const amount = adj?.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount === 0) continue;
    const cell = lookup[key];
    if (cell && cell.cleaning > 0) cell.cleaning += amount;
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

  // ── Misc (ad-hoc, renamed from Other): same shape as wear & tear,
  //    bucketed by (date, roomId).
  const miscEvents = (Array.isArray(miscRaw) ? miscRaw : []) as IncidentEvent[];
  for (const ev of miscEvents) {
    if (!ev?.date || !ev?.roomId) continue;
    if (!ev.amount || ev.amount <= 0) continue;
    const e = ensureEntry(ev.date, ev.roomId);
    e.misc += ev.amount;
    e.miscUnits = (e.miscUnits ?? 0) + 1;
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
  return body;
}

/**
 * Client-safe contract for /api/variable-costs.
 *
 * These constants and types are consumed by BOTH the route handler and browser
 * code (GrossProfitBridgeView, PerformancePage, CommissionPage, and the
 * grossProfit / commissionCalc engines behind them).
 *
 * WHY THIS FILE EXISTS: they used to live in `app/api/variable-costs/route.ts`.
 * Importing a *value* (ROOM_TO_BEDS24_ID) from a route handler drags the whole
 * route module — and its server-only imports (Upstash Redis, `@/lib/db`) — into
 * the client bundle. `lib/db.ts` throws at module evaluation when there is no
 * connection string, and `process.env.POSTGRES_URL` is never defined in the
 * browser, so that import chain white-screened every page on hydration.
 *
 * Keep this module free of server-only imports. Nothing here may reach Redis,
 * Postgres, `next/server`, or `process.env`.
 */

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

/** Subscription item shape returned to clients — same as raw + dates. */
export interface SubscriptionItem {
  id: string;
  label: string;
  rooms: Record<string, { enabled: boolean; monthlyAmount: number }>;
  startDate?: string;
  endDate?: string;
}

/** One subscription line item's cost contribution for a period/scope.
 *  Carries the item's own label so a statement can show "Parking" and
 *  "Internet + TV" separately instead of one opaque "Subscriptions" total. */
export interface SubscriptionLine {
  id: string;
  label: string;
  amount: number;
}

export interface VariableCostEntry {
  cleaning: number;
  laundry: number;
  consumables: number;
  /** Wear & Tear incident costs for this (date|roomId) or reservation. */
  wearTear: number;
  /** Misc (ad-hoc) incident costs for this (date|roomId). */
  misc: number;
  // ── Unit counts (parallel to the cost fields) for the per-unit overview ──
  /** Laundry sets consumed (Σ setsPerRoom over laundry events). */
  laundrySets?: number;
  /** Consumable sets logged (1 per entry). */
  consumableUnits?: number;
  /** Wear & Tear incidents (1 per event). */
  wearTearUnits?: number;
  /** Misc entries (1 per event). */
  miscUnits?: number;
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

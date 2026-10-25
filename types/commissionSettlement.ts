import type { SettlementMode } from '@/utils/commissionConfig';
import type { SubscriptionLine } from '@/utils/variableCostsShared';

export type CommissionSettlementStatus = 'issued' | 'reconciled';

/**
 * A snapshot of one apartment's owner settlement for one calendar month.
 *
 * The figures are frozen at issue time so the history stays stable even if the
 * underlying cleaning-app costs or Beds24 revenue are later edited. Re-issuing
 * the same unit + month overwrites the record (deterministic id).
 */
export interface CommissionSettlement {
  id: string;                     // `settle-{unitId}-{month}` e.g. settle-K.102-2026-06
  unitId: string;                 // 'K.102'
  room: string;
  ownerName: string;
  mode: SettlementMode;
  month: string;                  // 'YYYY-MM'
  periodStart: string;            // 'YYYY-MM-DD'
  periodEnd: string;              // 'YYYY-MM-DD'

  // ── Net-sales bridge (this unit's share) ────────────────────────────────
  gbv: number;
  otaCommission: number;
  paymentFees: number;
  netSales: number;

  // ── Operational costs (this unit's share) ───────────────────────────────
  cleaning: number;
  laundry: number;
  consumables: number;
  subscriptions: number;
  /** `subscriptions` itemised per cleaning-app line item (Internet + TV,
   *  Parking, …), already divided by the pool divisor so it sums to
   *  `subscriptions`. Optional: snapshots issued before itemisation existed
   *  carry only the lump total, and statements fall back to showing that. */
  subscriptionBreakdown?: SubscriptionLine[];
  wearTear: number;
  misc: number;
  operationalCosts: number;

  grossProfit: number;
  commissionRate: number;         // 0.25
  commissionAmount: number;       // BHA keeps
  payableToOwner: number;         // owner receives

  // ── Pool context (urban-pool only) ──────────────────────────────────────
  poolRooms?: string[];
  poolDivisor?: number;
  poolGrossProfit?: number;

  // ── Verification (cleaning-app reconciliation) ──────────────────────────
  reconciles: boolean;            // breakdown total === billed cleanings
  reconcileNote?: string;

  // ── Persistence / bank linking ──────────────────────────────────────────
  status: CommissionSettlementStatus;
  bankTransactionId?: string;
  reconciledAt?: string;
  /** Set when the PDF was last emailed to the owner → drives the "Sent" badge. */
  emailedAt?: string;
  emailedTo?: string;
  createdAt: string;
  createdBy: string;
}

/**
 * How the month's billed cleanings are made up, at the level the settlement is
 * computed (whole Urban pool, or the standalone unit). The signed lines add up
 * to `total`; the month reconciles when that equals `billed`.
 *
 * Computed live only — there is no column for it, so an issued settlement keeps
 * just `reconciles` + `reconcileNote`.
 */
export interface CleaningBreakdown {
  /** Reservations with at least one night in the month (one per booking). */
  reservations: number;
  /** Of those, the ones checking out next month — cleaned and billed then. */
  checkoutNextMonth: number;
  /** Last month's reservations whose checkout falls in this month. */
  carryIn: number;
  /** Cleanings added by hand in the cleaning app, not on a checkout. */
  extra: number;
  /** Vacated-unit cleanings from mid-stay room moves. */
  roomMoves: number;
  /** Guests who never arrived — revenue kept, nothing to clean. */
  nonArrivals: number;
  /** Checkout cleanings removed in the cleaning app (e.g. stay prolonged). */
  removed: number;
  /** What the lines above add up to. */
  total: number;
  /** Cleanings the cleaning app actually billed. */
  billed: number;
}

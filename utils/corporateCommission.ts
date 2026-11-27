/**
 * Corporate commission / rebate — pure rules, safe to import from the client.
 *
 * Some companies (travel agencies, relocation firms, other intermediaries)
 * invoice a percentage of every booking's total back to us. Economically that
 * is the same as a Booking.com or Airbnb commission: a cost of the sale. So
 * instead of teaching every report about a new kind of cost, the percentage on
 * the agreement is turned into CZK per booking and written to the booking's
 * own Beds24 `commission` field — the field OTA bookings already fill. From
 * there it reaches every consumer unchanged:
 *
 *   Beds24 `commission` → Reservation.commissionAmount (mapToReservation)
 *     → reservationRevenue → Net Sales / Gross Profit (Performance)
 *     → computeSettlement   (owner Commission tab, 25 % of GP)
 *     → bookings_mirror.commission_amount → Analytics (costs, rates, overview)
 *     → the drawer's "Corporate commission" line in Transactions
 *
 * The percentage lives on the agreement (our record, one per company deal);
 * the CZK lives on each booking in Beds24. `planCommissionSync` compares the
 * two so the agreement screen can show — and fix — any booking whose
 * commission no longer matches (a price edited in Beds24, a % changed later).
 */
import type { CorporateStay } from './corporateShared';

/**
 * Upper bound on the percentage. Real rebates sit around 5–20 %; anything
 * above this is a typo (150 for 15) that would wipe out the stay's revenue.
 */
export const MAX_COMMISSION_PERCENT = 50;

/** Differences below half a haléř are rounding noise, not drift. */
const EPSILON_CZK = 0.005;

/**
 * CZK the company invoices back on a booking priced `priceCzk`, to the haléř
 * (Beds24 keeps two decimals; OTA commissions arrive like 2 286.16).
 */
export function commissionCzk(priceCzk: number | null | undefined, percent: number): number {
  if (!priceCzk || !(priceCzk > 0) || !(percent > 0)) return 0;
  return Math.round(priceCzk * percent) / 100;
}

/**
 * Commission across the stays that count (planned, created, failed) at their
 * agreed price — the figure next to the agreement's total.
 */
export function agreementCommissionCzk(
  stays: Pick<CorporateStay, 'status' | 'priceCzk'>[],
  percent: number,
): number {
  if (!(percent > 0)) return 0;
  let sum = 0;
  for (const s of stays) {
    if (s.status !== 'planned' && s.status !== 'created' && s.status !== 'failed') continue;
    sum += commissionCzk(s.priceCzk, percent);
  }
  return Math.round(sum * 100) / 100;
}

// ─── Beds24 sync plan ────────────────────────────────────────────────────────

/** The money fields of one Beds24 booking record, as GET /bookings returns them. */
export interface LiveBookingMoney {
  id: number;
  price: number;
  commission: number;
  status: string;
}

/**
 * in-sync   — Beds24 already carries the commission the % gives.
 * update    — Beds24 differs; `targetCzk` is what to write.
 * cancelled — cancelled in Beds24; no sale, nothing to write.
 * missing   — Beds24 did not return the booking (deleted, or the read failed for it).
 */
export type CommissionSyncAction = 'in-sync' | 'update' | 'cancelled' | 'missing';

export interface CommissionSyncItem {
  stayId: string;
  seq: number;
  bookingId: number;
  reservationNumber: string | null;
  /** Live Beds24 price — the base the % applies to. Null when missing. */
  priceCzk: number | null;
  /** Commission Beds24 holds now. Null when missing. */
  currentCzk: number | null;
  /** Commission the agreement's % gives on the live price. Null when nothing applies. */
  targetCzk: number | null;
  action: CommissionSyncAction;
}

/**
 * Compare every created stay's Beds24 booking with the agreement's %.
 *
 * The base is the LIVE Beds24 price, not the price frozen on the stay: once a
 * booking exists, price edits happen in Beds24 (same rule as shorten-stay),
 * and the company invoices its % of what the guest was really charged.
 * A % of 0 is a real target too — lowering a rebate to none must clear the
 * commission already written, not leave it behind.
 */
export function planCommissionSync(
  stays: Pick<CorporateStay, 'id' | 'seq' | 'status' | 'beds24BookingId' | 'reservationNumber'>[],
  live: Map<number, LiveBookingMoney>,
  percent: number,
): CommissionSyncItem[] {
  const items: CommissionSyncItem[] = [];
  for (const s of stays) {
    if (s.status !== 'created' || !s.beds24BookingId) continue;
    const base = { stayId: s.id, seq: s.seq, bookingId: s.beds24BookingId, reservationNumber: s.reservationNumber };
    const b = live.get(s.beds24BookingId);
    if (!b) {
      items.push({ ...base, priceCzk: null, currentCzk: null, targetCzk: null, action: 'missing' });
      continue;
    }
    const price = Number.isFinite(b.price) ? b.price : 0;
    const current = Number.isFinite(b.commission) ? b.commission : 0;
    if (b.status === 'cancelled' || b.status === 'canceled') {
      items.push({ ...base, priceCzk: price, currentCzk: current, targetCzk: null, action: 'cancelled' });
      continue;
    }
    const target = commissionCzk(price, percent);
    items.push({
      ...base,
      priceCzk: price,
      currentCzk: current,
      targetCzk: target,
      action: Math.abs(current - target) < EPSILON_CZK ? 'in-sync' : 'update',
    });
  }
  return items;
}

/** What the commission check / push hands back (GET|POST …/commission, PATCH agreement). */
export interface CommissionSyncResult {
  percent: number;
  /** Per created stay, after any write (written ones read `in-sync`). */
  items: CommissionSyncItem[];
  /** Stay ids whose Beds24 commission was written in this call. */
  updated: string[];
  failed: { stayId: string; error: string }[];
  /** Set when Beds24 could not be reached at all — items are then empty. */
  error: string | null;
}

/** One-line state for the agreement screen. */
export function describeCommissionSync(items: CommissionSyncItem[]): {
  tone: 'ok' | 'warn' | 'none';
  text: string;
} {
  const live = items.filter((i) => i.action === 'in-sync' || i.action === 'update');
  const pending = items.filter((i) => i.action === 'update');
  const missing = items.filter((i) => i.action === 'missing');
  if (live.length === 0 && missing.length === 0) return { tone: 'none', text: 'No bookings in Beds24 yet' };
  const n = (k: number) => `${k} booking${k === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (pending.length > 0) parts.push(`${n(pending.length)} not updated in Beds24`);
  if (missing.length > 0) parts.push(`${n(missing.length)} not found in Beds24`);
  if (parts.length > 0) return { tone: 'warn', text: parts.join(' · ') };
  return { tone: 'ok', text: `Beds24 matches on ${n(live.length)}` };
}

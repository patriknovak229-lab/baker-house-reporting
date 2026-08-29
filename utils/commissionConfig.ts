/**
 * Owner-settlement configuration for the Accounting → Commission tab.
 *
 * Baker House Apartments (operator entity Truthseeker s.r.o.) manages a set of
 * apartments on behalf of their owners and retains a management commission of
 * 25% of the gross profit each apartment generates. The remaining 75% is
 * settled to the owner.
 *
 * Two settlement modes:
 *  - 'urban-pool':  The three Urban studios (K.102, K.103, K.106) are sold under
 *                   a single Beds24 room type, so revenue is not meaningfully
 *                   attributable to a specific physical unit. Gross profit is
 *                   computed on the whole pool and split equally (÷3). K.103 is
 *                   owned by BHA itself, so it has no settlement — but it still
 *                   contributes to (and takes) its third of the pool.
 *  - 'standalone':  A single unit sold on its own (e.g. O.308). Gross profit is
 *                   taken directly for that room, no pooling.
 *
 * Rooms deliberately excluded from settlements: K.103 (BHA-owned), and the
 * Deluxe K-block K.201 / K.202 / K.203 (also BHA-owned).
 */
import type { Room } from '@/types/reservation';

export const COMMISSION_RATE = 0.25;

export type SettlementMode = 'urban-pool' | 'standalone';

export interface CommissionUnit {
  /** Stable id — also the physical room name. */
  id: string;
  room: Room;
  ownerName: string;
  mode: SettlementMode;
  /** Human label for the apartment type. */
  typeLabel: string;
  /**
   * True for apartments BHA owns itself. They appear in the annual overview
   * with real revenue and real costs, but there is no external owner: no
   * commission is charged AND nothing is payable out. Note this is not the same
   * as a 0% management fee, which would mean the owner keeps 100% — hence a
   * flag rather than a rate of zero.
   */
  bhaOwned?: boolean;
}

/** The rooms that make up the Urban pool (in canonical order). */
export const URBAN_POOL_ROOMS: Room[] = ['K.102', 'K.103', 'K.106'];
export const URBAN_POOL_DIVISOR = URBAN_POOL_ROOMS.length; // 3

/** Units that produce an owner settlement. */
export const COMMISSION_UNITS: CommissionUnit[] = [
  { id: 'K.102', room: 'K.102', ownerName: 'Stanislav Stefanic', mode: 'urban-pool', typeLabel: '1KK Urban Studio' },
  { id: 'K.106', room: 'K.106', ownerName: 'Stanislav Komanec', mode: 'urban-pool', typeLabel: '1KK Urban Studio' },
  { id: 'O.308', room: 'O.308', ownerName: 'Stanislav Stefanic', mode: 'standalone', typeLabel: '2 Bedroom Deluxe' },
];

/**
 * Every physical room, including the BHA-owned ones that never settle.
 *
 * Drives the annual overview only — the monthly settlement cards stay on
 * COMMISSION_UNITS, so nothing here can accidentally issue a statement for a
 * room that has no owner. The BHA-owned rooms are flagged `bhaOwned`: their
 * revenue and costs are real and belong in a whole-business view, but the
 * commission and payable lines are structurally zero.
 *
 * K.202 / K.203 sell under one Beds24 room type (the "1KK Deluxe Studios" VR)
 * yet are listed standalone here on purpose: both are BHA-owned, so nothing is
 * settled on them and per-room figures may as well follow the actual physical
 * allocation. A booking still sitting on the VR itself belongs to no room and
 * surfaces in the annual overview's "Unallocated" row rather than being split.
 */
export const ANNUAL_UNITS: CommissionUnit[] = [
  COMMISSION_UNITS[0],                                                    // K.102
  { id: 'K.103', room: 'K.103', ownerName: 'Baker House Apartments', mode: 'urban-pool', typeLabel: '1KK Urban Studio', bhaOwned: true },
  COMMISSION_UNITS[1],                                                    // K.106
  { id: 'K.201', room: 'K.201', ownerName: 'Baker House Apartments', mode: 'standalone', typeLabel: '2KK Deluxe',       bhaOwned: true },
  { id: 'K.202', room: 'K.202', ownerName: 'Baker House Apartments', mode: 'standalone', typeLabel: '1KK Deluxe Studio', bhaOwned: true },
  { id: 'K.203', room: 'K.203', ownerName: 'Baker House Apartments', mode: 'standalone', typeLabel: '1KK Deluxe Studio', bhaOwned: true },
  COMMISSION_UNITS[2],                                                    // O.308
];

/** The commission actually charged on a unit's gross profit. */
export function unitCommissionRate(unit: CommissionUnit): number {
  return unit.bhaOwned ? 0 : COMMISSION_RATE;
}

export function getCommissionUnit(id: string): CommissionUnit | undefined {
  return COMMISSION_UNITS.find((u) => u.id === id);
}

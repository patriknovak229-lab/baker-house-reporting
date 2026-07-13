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

export function getCommissionUnit(id: string): CommissionUnit | undefined {
  return COMMISSION_UNITS.find((u) => u.id === id);
}

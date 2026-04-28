export type VoucherStatus = 'issued' | 'used' | 'deleted';
export type VoucherDiscountType = 'fixed' | 'percentage';

export interface Voucher {
  id: string;                    // UUID
  code: string;                  // e.g. "Karen500" — customer-facing
  discountType: VoucherDiscountType;
  value: number;                 // CZK amount or percentage (1–100)
  status: VoucherStatus;
  /** The reservation the voucher was CREATED FOR — set when the operator
   *  links the voucher to a guest's stay at issuance time. May be empty for
   *  standalone promo vouchers. Distinct from where it ends up being USED. */
  reservationNumber?: string;
  /** The reservation the voucher was REDEEMED ON — set by the redeem endpoint
   *  on first use. Often the same as reservationNumber (guest applies their own
   *  voucher to a future booking) but can differ if the voucher was gifted. */
  redeemedOnReservationNumber?: string;
  guestName?: string;
  guestEmail?: string;           // guest's own email (never OTA conduit)
  guestPhone?: string;
  expiresAt: string;             // ISO date — 12 months from creation
  createdAt: string;             // ISO timestamp
  createdBy: string;             // email of creator
  usedAt?: string;               // ISO timestamp — set on redemption
}

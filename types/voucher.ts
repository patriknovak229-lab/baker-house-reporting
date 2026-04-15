export type VoucherStatus = 'issued' | 'used' | 'deleted';
export type VoucherDiscountType = 'fixed' | 'percentage';

export interface Voucher {
  id: string;                    // UUID
  code: string;                  // e.g. "Karen500" — customer-facing
  discountType: VoucherDiscountType;
  value: number;                 // CZK amount or percentage (1–100)
  status: VoucherStatus;
  reservationNumber?: string;    // linked reservation (always saved when available)
  guestName?: string;
  guestEmail?: string;           // guest's own email (never OTA conduit)
  guestPhone?: string;
  expiresAt: string;             // ISO date — 12 months from creation
  createdAt: string;             // ISO timestamp
  createdBy: string;             // email of creator
  usedAt?: string;               // ISO timestamp — set on redemption
}

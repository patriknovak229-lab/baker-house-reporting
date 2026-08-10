/**
 * Storage-mode resolver for the Redis → Postgres migration.
 *
 * Each domain migrates independently behind an env flag:
 *   - 'redis'    → legacy behaviour: read + write Redis only        [default]
 *   - 'dual'     → write BOTH stores, read from Redis               [parity bake]
 *   - 'postgres' → read + write Postgres only                       [migrated]
 *
 * Flip one domain by setting e.g. STORE_VOUCHERS=dual in the environment.
 * Everything defaults to 'redis', so nothing changes until a domain is opted in.
 */
export type StoreMode = 'redis' | 'dual' | 'postgres';

export type StoreDomain =
  // Wave 1 — self-contained / low blast radius
  | 'occupancySnapshots'
  | 'vouchers'
  | 'emailSendLog'
  | 'autoReplyLog'
  | 'invoiceRequests'
  | 'invoiceCategories'
  | 'supplierWhitelist'
  | 'bankCostWhitelist'
  | 'gmailInvoiceToken'
  // Wave 2 — financial records
  | 'supplierInvoices'
  | 'revenueInvoices'
  | 'additionalPayments'
  | 'splitPayments'
  | 'stripePayments'
  | 'settlementGroups'
  | 'commissionSettlements'
  // Wave 3 — hard-rule domains (sign-off gated)
  | 'bankTransactions'
  | 'reservationOverrides';

const ENV_KEYS: Record<StoreDomain, string> = {
  occupancySnapshots: 'STORE_OCCUPANCY_SNAPSHOTS',
  vouchers: 'STORE_VOUCHERS',
  emailSendLog: 'STORE_EMAIL_SEND_LOG',
  autoReplyLog: 'STORE_AUTO_REPLY_LOG',
  invoiceRequests: 'STORE_INVOICE_REQUESTS',
  invoiceCategories: 'STORE_INVOICE_CATEGORIES',
  supplierWhitelist: 'STORE_SUPPLIER_WHITELIST',
  bankCostWhitelist: 'STORE_BANK_COST_WHITELIST',
  gmailInvoiceToken: 'STORE_GMAIL_INVOICE_TOKEN',
  supplierInvoices: 'STORE_SUPPLIER_INVOICES',
  revenueInvoices: 'STORE_REVENUE_INVOICES',
  additionalPayments: 'STORE_ADDITIONAL_PAYMENTS',
  splitPayments: 'STORE_SPLIT_PAYMENTS',
  stripePayments: 'STORE_STRIPE_PAYMENTS',
  settlementGroups: 'STORE_SETTLEMENT_GROUPS',
  commissionSettlements: 'STORE_COMMISSION_SETTLEMENTS',
  bankTransactions: 'STORE_BANK_TRANSACTIONS',
  reservationOverrides: 'STORE_RESERVATION_OVERRIDES',
};

const VALID_MODES: readonly StoreMode[] = ['redis', 'dual', 'postgres'];

/** Resolve the current storage mode for a domain (defaults to 'redis'). */
export function getStoreMode(domain: StoreDomain): StoreMode {
  const raw = process.env[ENV_KEYS[domain]]?.trim().toLowerCase();
  return (VALID_MODES as readonly string[]).includes(raw ?? '')
    ? (raw as StoreMode)
    : 'redis';
}

/** Reads should come from Postgres (only in fully-migrated 'postgres' mode). */
export const readsFromPostgres = (d: StoreDomain): boolean =>
  getStoreMode(d) === 'postgres';

/** Writes should hit Postgres ('dual' or 'postgres'). */
export const writesToPostgres = (d: StoreDomain): boolean =>
  getStoreMode(d) !== 'redis';

/** Writes should still hit Redis ('redis' or 'dual') — dropped once migrated. */
export const writesToRedis = (d: StoreDomain): boolean =>
  getStoreMode(d) !== 'postgres';

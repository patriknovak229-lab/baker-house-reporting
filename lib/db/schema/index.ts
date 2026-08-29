// Drizzle schema barrel.
//
// Per-domain table definitions live in sibling files and are re-exported
// here so `import * as schema from '@/lib/db/schema'` picks them all up.

export * from './occupancySnapshots';
export * from './vouchers';
export * from './emailSendLog';
export * from './invoiceRequests';
export * from './autoReply';
export * from './accountingConfig';
export * from './appSettings';
export * from './supplierInvoices';
export * from './revenueInvoices';
export * from './additionalPayments';
export * from './splitPayments';
export * from './stripePayments';
export * from './settlementGroups';
export * from './commissionSettlements';
export * from './bankTransactions';
export * from './reservationOverrides';
export * from './bookingsMirror';
export * from './marketSnapshots';
export * from './priceSnapshots';
export * from './roomMoves';

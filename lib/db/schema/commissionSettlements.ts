import { pgTable, text, numeric, integer, boolean, date, timestamp } from 'drizzle-orm/pg-core';
import type { CommissionSettlementStatus } from '../../../types/commissionSettlement';

/**
 * Owner commission settlements — was Redis JSON array `baker:commission-settlements`.
 * Frozen monthly snapshots (id = `settle-{unit}-{month}`); store values as issued.
 */
export const commissionSettlements = pgTable('commission_settlements', {
  id: text('id').primaryKey(),
  unitId: text('unit_id').notNull(),
  room: text('room').notNull(),
  ownerName: text('owner_name').notNull(),
  mode: text('mode').$type<'urban-pool' | 'standalone'>().notNull(),
  month: text('month').notNull(),
  periodStart: date('period_start', { mode: 'string' }).notNull(),
  periodEnd: date('period_end', { mode: 'string' }).notNull(),
  gbv: numeric('gbv').notNull(),
  otaCommission: numeric('ota_commission').notNull(),
  paymentFees: numeric('payment_fees').notNull(),
  netSales: numeric('net_sales').notNull(),
  cleaning: numeric('cleaning').notNull(),
  laundry: numeric('laundry').notNull(),
  consumables: numeric('consumables').notNull(),
  subscriptions: numeric('subscriptions').notNull(),
  wearTear: numeric('wear_tear').notNull(),
  misc: numeric('misc').notNull(),
  operationalCosts: numeric('operational_costs').notNull(),
  grossProfit: numeric('gross_profit').notNull(),
  commissionRate: numeric('commission_rate').notNull(),
  commissionAmount: numeric('commission_amount').notNull(),
  payableToOwner: numeric('payable_to_owner').notNull(),
  poolRooms: text('pool_rooms').array(),
  poolDivisor: integer('pool_divisor'),
  poolGrossProfit: numeric('pool_gross_profit'),
  reconciles: boolean('reconciles').notNull(),
  reconcileNote: text('reconcile_note'),
  status: text('status').$type<CommissionSettlementStatus>().notNull(),
  bankTransactionId: text('bank_transaction_id'),
  reconciledAt: timestamp('reconciled_at', { withTimezone: true, mode: 'date' }),
  emailedAt: timestamp('emailed_at', { withTimezone: true, mode: 'date' }),
  emailedTo: text('emailed_to'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  createdBy: text('created_by').notNull(),
});

export type CommissionSettlementRow = typeof commissionSettlements.$inferSelect;
export type CommissionSettlementInsert = typeof commissionSettlements.$inferInsert;

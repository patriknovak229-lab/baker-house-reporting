/**
 * Postgres repository for owner commission settlements (Redis→Postgres cutover).
 * Frozen monthly snapshots — store values EXACTLY as issued (money via unbounded
 * numeric, round-tripped String()↔Number() so sub-cent commission shares stay
 * byte-identical). Row↔domain mapping restores the app's shapes (timestamps →
 * ISO strings, absent → undefined). `replaceAll` mirrors the routes' whole-array
 * `set` semantics atomically via db.batch. toRow mirrors scripts/backfill.
 */
import { db } from '@/lib/db';
import { commissionSettlements } from '@/lib/db/schema';
import type { CommissionSettlement } from '@/types/commissionSettlement';
import type {
  CommissionSettlementInsert,
  CommissionSettlementRow,
} from '@/lib/db/schema/commissionSettlements';

const u = <T>(x: T | null): T | undefined => (x == null ? undefined : x);
const n = (x?: number | null) => (x != null ? String(x) : null);

function toRow(c: CommissionSettlement): CommissionSettlementInsert {
  return {
    id: c.id,
    unitId: c.unitId,
    room: c.room,
    ownerName: c.ownerName,
    mode: c.mode,
    month: c.month,
    periodStart: c.periodStart.slice(0, 10),
    periodEnd: c.periodEnd.slice(0, 10),
    gbv: String(c.gbv),
    otaCommission: String(c.otaCommission),
    paymentFees: String(c.paymentFees),
    netSales: String(c.netSales),
    cleaning: String(c.cleaning),
    laundry: String(c.laundry),
    consumables: String(c.consumables),
    subscriptions: String(c.subscriptions),
    wearTear: String(c.wearTear),
    misc: String(c.misc),
    operationalCosts: String(c.operationalCosts),
    grossProfit: String(c.grossProfit),
    commissionRate: String(c.commissionRate),
    commissionAmount: String(c.commissionAmount),
    payableToOwner: String(c.payableToOwner),
    poolRooms: c.poolRooms ?? null,
    poolDivisor: c.poolDivisor ?? null,
    poolGrossProfit: n(c.poolGrossProfit),
    reconciles: c.reconciles,
    reconcileNote: c.reconcileNote ?? null,
    status: c.status,
    bankTransactionId: c.bankTransactionId ?? null,
    reconciledAt: c.reconciledAt ? new Date(c.reconciledAt) : null,
    emailedAt: c.emailedAt ? new Date(c.emailedAt) : null,
    emailedTo: c.emailedTo ?? null,
    createdAt: new Date(c.createdAt),
    createdBy: c.createdBy,
  };
}

function fromRow(r: CommissionSettlementRow): CommissionSettlement {
  return {
    id: r.id,
    unitId: r.unitId,
    room: r.room,
    ownerName: r.ownerName,
    mode: r.mode,
    month: r.month,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    gbv: Number(r.gbv),
    otaCommission: Number(r.otaCommission),
    paymentFees: Number(r.paymentFees),
    netSales: Number(r.netSales),
    cleaning: Number(r.cleaning),
    laundry: Number(r.laundry),
    consumables: Number(r.consumables),
    subscriptions: Number(r.subscriptions),
    wearTear: Number(r.wearTear),
    misc: Number(r.misc),
    operationalCosts: Number(r.operationalCosts),
    grossProfit: Number(r.grossProfit),
    commissionRate: Number(r.commissionRate),
    commissionAmount: Number(r.commissionAmount),
    payableToOwner: Number(r.payableToOwner),
    poolRooms: u(r.poolRooms),
    poolDivisor: u(r.poolDivisor),
    poolGrossProfit: r.poolGrossProfit != null ? Number(r.poolGrossProfit) : undefined,
    reconciles: r.reconciles,
    reconcileNote: u(r.reconcileNote),
    status: r.status,
    bankTransactionId: u(r.bankTransactionId),
    reconciledAt: r.reconciledAt ? r.reconciledAt.toISOString() : undefined,
    emailedAt: r.emailedAt ? r.emailedAt.toISOString() : undefined,
    emailedTo: u(r.emailedTo),
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy,
  };
}

export async function listCommissionSettlementsPg(): Promise<CommissionSettlement[]> {
  return (await db.select().from(commissionSettlements)).map(fromRow);
}

export async function replaceAllCommissionSettlementsPg(items: CommissionSettlement[]): Promise<void> {
  const rows = items.map(toRow);
  if (rows.length === 0) {
    await db.delete(commissionSettlements);
    return;
  }
  await db.batch([db.delete(commissionSettlements), db.insert(commissionSettlements).values(rows)]);
}

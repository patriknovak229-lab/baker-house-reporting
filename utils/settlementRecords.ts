/**
 * Helpers to build the two accounting records that back an OTA settlement.
 *
 * Every paid-channel settlement (Airbnb, Booking, …) decomposes into:
 *   • a REVENUE record  = gross booking volume  → P&L line I. (sales)
 *   • a COST record     = channel fees          → P&L A. Výkonová spotřeba
 * and gross − fees = net = the bank payout(s). These records are created,
 * updated and deleted together with the SettlementGroup that owns them.
 */
import type { SettlementGroup } from '@/types/settlementGroup';
import type { RevenueInvoice } from '@/types/revenueInvoice';
import type { SupplierInvoice } from '@/types/supplierInvoice';

export const REVENUE_KEY  = 'baker:revenue-invoices';
export const SUPPLIER_KEY = 'baker:supplier-invoices';

/** Minimal Redis surface used by appendRecords (Upstash client satisfies this) */
interface RedisLike {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<unknown>;
}

/**
 * Append records to a JSON-array Redis key WITHOUT clobbering concurrent writes.
 *
 * The store keeps each collection as one JSON array under a single key, so a naive
 * read-modify-write can drop a record another request just added. This reads fresh,
 * appends only missing ids (idempotent), writes, then reads back to verify the ids
 * landed — retrying if a concurrent write raced us. Prevents the "settlement group
 * references a cost record that doesn't exist" data loss.
 */
export async function appendRecords<T extends { id: string }>(
  redis: RedisLike, key: string, items: T[],
): Promise<void> {
  if (items.length === 0) return;
  for (let attempt = 0; attempt < 4; attempt++) {
    const arr = (await redis.get<T[]>(key)) ?? [];
    const have = new Set(arr.map((a) => a.id));
    const toAdd = items.filter((i) => !have.has(i.id));
    if (toAdd.length === 0) return; // all present already (idempotent)
    await redis.set(key, [...toAdd, ...arr]);
    const after = (await redis.get<T[]>(key)) ?? [];
    const afterIds = new Set(after.map((a) => a.id));
    if (items.every((i) => afterIds.has(i.id))) return; // verified
  }
}

/** Category id used for channel/distribution fees on the cost side */
export const DISTRIBUTION_FEES_CATEGORY = 'distribution-fees';

export function sourceLabel(source?: string): string {
  if (source === 'airbnb')  return 'Airbnb';
  if (source === 'booking') return 'Booking.com B.V.';
  return 'OTA channel';
}

/** Short channel label used in the settlement's display name */
export function channelLabel(source?: string): string {
  if (source === 'airbnb')  return 'Airbnb';
  if (source === 'booking') return 'Booking.com';
  return 'OTA';
}

/** Canonical settlement display name — always "<Channel> <Month Year>" from the accrual period */
export function settlementDisplayName(source?: string, periodStart?: string): string {
  const label = channelLabel(source);
  if (!periodStart) return label;
  const d = new Date(periodStart + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return `${label} ${periodStart}`;
  return `${label} ${d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`;
}

function periodTag(group: SettlementGroup): string {
  return group.periodStart ? group.periodStart.slice(0, 7) : '';
}

/** Build (or rebuild) the gross-revenue record for a settlement */
export function buildSettlementRevenue(group: SettlementGroup, existingId?: string): RevenueInvoice {
  const label = sourceLabel(group.source);
  const date  = group.periodStart ?? new Date().toISOString().slice(0, 10);
  const tag   = periodTag(group);
  return {
    id:            existingId ?? crypto.randomUUID(),
    sourceType:    'ota',
    category:      'ota_gross',
    status:        'reconciled',
    invoiceNumber: `${group.source ?? 'ota'}-gross-${date}`,
    invoiceDate:   date,
    dueDate:       date,
    amountCZK:     group.grossAmount ?? 0,
    clientName:    label,
    description:   `Gross booking volume · ${label}${tag ? ' · ' + tag : ''}`,
    settlementGroupId: group.id,
    createdAt:     new Date().toISOString(),
  };
}

/** Build (or rebuild) the channel-fees cost record for a settlement */
export function buildSettlementCost(group: SettlementGroup, existingId?: string): SupplierInvoice {
  const label = sourceLabel(group.source);
  const date  = group.periodStart ?? new Date().toISOString().slice(0, 10);
  const tag   = periodTag(group);
  return {
    id:            existingId ?? crypto.randomUUID(),
    supplierName:  label,
    invoiceNumber: `${group.source ?? 'ota'}-fees-${date}`,
    invoiceDate:   date,
    dueDate:       date,
    amountCZK:     group.commissionAmount ?? 0,
    category:      DISTRIBUTION_FEES_CATEGORY,
    status:        'reconciled',
    sourceType:    'manual',
    settlementGroupId: group.id,
    autoProcessed: true,
    description:   `Channel fees · ${label}${tag ? ' · ' + tag : ''}`,
    createdAt:     new Date().toISOString(),
  };
}

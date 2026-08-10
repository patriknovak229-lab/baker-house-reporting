/**
 * Postgres repository for vouchers (Redis→Postgres cutover).
 * Row↔domain mapping restores the app's expected shapes (money → number,
 * timestamps → ISO strings, absent → undefined). `replaceAll` mirrors the
 * route's whole-array `set` semantics atomically via db.batch.
 */
import { db } from '@/lib/db';
import { vouchers } from '@/lib/db/schema';
import type { Voucher } from '@/types/voucher';
import type { VoucherInsert, VoucherRow } from '@/lib/db/schema/vouchers';

const u = <T>(x: T | null): T | undefined => (x == null ? undefined : x);

function toRow(v: Voucher): VoucherInsert {
  return {
    id: v.id,
    code: v.code,
    discountType: v.discountType,
    value: String(v.value),
    status: v.status,
    reservationNumber: v.reservationNumber ?? null,
    redeemedOnReservationNumber: v.redeemedOnReservationNumber ?? null,
    guestName: v.guestName ?? null,
    guestEmail: v.guestEmail ?? null,
    guestPhone: v.guestPhone ?? null,
    expiresAt: v.expiresAt.slice(0, 10),
    createdAt: new Date(v.createdAt),
    createdBy: v.createdBy,
    usedAt: v.usedAt ? new Date(v.usedAt) : null,
  };
}

function fromRow(r: VoucherRow): Voucher {
  return {
    id: r.id,
    code: r.code,
    discountType: r.discountType,
    value: Number(r.value),
    status: r.status,
    reservationNumber: u(r.reservationNumber),
    redeemedOnReservationNumber: u(r.redeemedOnReservationNumber),
    guestName: u(r.guestName),
    guestEmail: u(r.guestEmail),
    guestPhone: u(r.guestPhone),
    expiresAt: r.expiresAt,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy,
    usedAt: r.usedAt ? r.usedAt.toISOString() : undefined,
  };
}

export async function listVouchersPg(): Promise<Voucher[]> {
  return (await db.select().from(vouchers)).map(fromRow);
}

export async function replaceAllVouchersPg(items: Voucher[]): Promise<void> {
  const rows = items.map(toRow);
  if (rows.length === 0) {
    await db.delete(vouchers);
    return;
  }
  await db.batch([db.delete(vouchers), db.insert(vouchers).values(rows)]);
}

/**
 * Postgres repository for scheduled split payments (Redis→Postgres cutover).
 * Row↔domain mapping restores the app's shapes (money via numeric
 * String()↔Number(), sendDate as YYYY-MM-DD, timestamps → ISO strings, absent →
 * undefined). `replaceAll` mirrors the routes' whole-array set semantics
 * atomically via db.batch. toRow mirrors scripts/backfill/split-payments.ts.
 *
 * IDs are `sp_<ts36>_<rand>` (generateId), NOT UUIDs; replaceAll dedups by id
 * (last-wins) so a whole-array write can never abort on a duplicate PK —
 * matching the backfill's onConflictDoUpdate and the stripePayments repo.
 */
import { asc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { splitPayments } from '@/lib/db/schema';
import type { SplitPayment } from '@/types/splitPayment';
import type { SplitPaymentInsert, SplitPaymentRow } from '@/lib/db/schema/splitPayments';

const u = <T>(x: T | null): T | undefined => (x == null ? undefined : x);

function toRow(s: SplitPayment): SplitPaymentInsert {
  return {
    id: s.id,
    reservationNumber: s.reservationNumber,
    paymentNumber: s.paymentNumber,
    totalPayments: s.totalPayments,
    description: s.description,
    amountCzk: String(s.amountCzk),
    sendDate: s.sendDate.slice(0, 10),
    guestEmail: s.guestEmail ?? null,
    guestName: s.guestName ?? null,
    guestPhone: s.guestPhone ?? null,
    status: s.status,
    stripeSessionId: s.stripeSessionId ?? null,
    sentAt: s.sentAt ? new Date(s.sentAt) : null,
    failureReason: s.failureReason ?? null,
    failureCount: s.failureCount ?? null,
    createdAt: new Date(s.createdAt),
  };
}

function fromRow(r: SplitPaymentRow): SplitPayment {
  return {
    id: r.id,
    reservationNumber: r.reservationNumber,
    paymentNumber: r.paymentNumber,
    totalPayments: r.totalPayments,
    description: r.description,
    amountCzk: Number(r.amountCzk),
    sendDate: r.sendDate,
    guestEmail: u(r.guestEmail),
    guestName: u(r.guestName),
    guestPhone: u(r.guestPhone),
    status: r.status,
    stripeSessionId: u(r.stripeSessionId),
    sentAt: r.sentAt ? r.sentAt.toISOString() : undefined,
    failureReason: u(r.failureReason),
    failureCount: u(r.failureCount),
    createdAt: r.createdAt.toISOString(),
  };
}

export async function listSplitPaymentsPg(): Promise<SplitPayment[]> {
  // Order by createdAt (then paymentNumber) to reproduce the Redis array's
  // append order. Consumers re-sort by paymentNumber where it matters, so this
  // is defensive parity only.
  return (
    await db.select().from(splitPayments).orderBy(asc(splitPayments.createdAt), asc(splitPayments.paymentNumber))
  ).map(fromRow);
}

export async function replaceAllSplitPaymentsPg(items: SplitPayment[]): Promise<void> {
  const byId = new Map<string, SplitPaymentInsert>();
  for (const s of items) {
    if (!s?.id) continue; // skip malformed (mirrors backfill's guard)
    byId.set(s.id, toRow(s)); // last-wins on duplicate id
  }
  const rows = [...byId.values()];
  if (rows.length === 0) {
    await db.delete(splitPayments);
    return;
  }
  await db.batch([db.delete(splitPayments), db.insert(splitPayments).values(rows)]);
}

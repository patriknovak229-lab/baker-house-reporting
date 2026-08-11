/**
 * Postgres repository for the completed-Stripe-Checkout mirror (Redis→Postgres
 * cutover). Append-only log; one row per completed Checkout session. Row↔domain
 * mapping restores the app's shapes (money via numeric String()↔Number(),
 * timestamp → ISO string, absent → '' for the required guest fields).
 *
 * DEDUP: the live Redis array is appended with NO uniqueness check, so it can
 * hold duplicate sessionIds (webhook redelivery). session_id is the Postgres PK,
 * so replaceAll collapses duplicates last-wins before the bulk insert — matching
 * the backfill's onConflictDoUpdate. This is the only functional tightening.
 */
import { asc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { stripePaymentLog } from '@/lib/db/schema';
import type { StripePaymentLogInsert, StripePaymentLogRow } from '@/lib/db/schema/stripePayments';
import type { StripePaymentRecord } from '@/app/api/stripe/webhook/route';

const u = <T>(x: T | null): T | undefined => (x == null ? undefined : x);

function toRow(r: StripePaymentRecord): StripePaymentLogInsert {
  return {
    sessionId: r.sessionId,
    description: r.description,
    amountCzk: String(r.amountCzk),
    guestEmail: r.guestEmail ?? null,
    guestPhone: r.guestPhone ?? null,
    guestName: r.guestName ?? null,
    reservationNumber: r.reservationNumber ?? null,
    paidAt: new Date(r.paidAt),
  };
}

function fromRow(row: StripePaymentLogRow): StripePaymentRecord {
  return {
    sessionId: row.sessionId,
    description: row.description,
    amountCzk: Number(row.amountCzk),
    guestEmail: row.guestEmail ?? '',
    guestPhone: row.guestPhone ?? '',
    guestName: u(row.guestName),
    reservationNumber: u(row.reservationNumber),
    paidAt: row.paidAt.toISOString(),
  };
}

export async function listStripePaymentsPg(): Promise<StripePaymentRecord[]> {
  // Order by paidAt (then sessionId) to reproduce the Redis array's append
  // (chronological) order, so check-payment's stable-sort auto-match tie-breaks
  // deterministically — matching the legacy Redis path.
  return (
    await db.select().from(stripePaymentLog).orderBy(asc(stripePaymentLog.paidAt), asc(stripePaymentLog.sessionId))
  ).map(fromRow);
}

export async function replaceAllStripePaymentsPg(items: StripePaymentRecord[]): Promise<void> {
  const byId = new Map<string, StripePaymentLogInsert>();
  for (const r of items) {
    if (!r?.sessionId) continue; // skip malformed (mirrors backfill's guard)
    byId.set(r.sessionId, toRow(r)); // last-wins on duplicate sessionId
  }
  const rows = [...byId.values()];
  if (rows.length === 0) {
    await db.delete(stripePaymentLog);
    return;
  }
  await db.batch([db.delete(stripePaymentLog), db.insert(stripePaymentLog).values(rows)]);
}

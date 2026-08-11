/**
 * Postgres repository for Stripe additional payments + their refunds (Redis→
 * Postgres cutover). The embedded `AdditionalPayment.refunds[]` splits into the
 * `payment_refunds` child table on write and reassembles on read, so the whole-
 * array read-modify-write the routes do round-trips identically (the
 * reconciliation engine's net-paid calc depends on refunds being present).
 *
 * Money via unbounded numeric String()↔Number(); timestamps → ISO strings;
 * absent → undefined. replaceAll rebuilds BOTH tables from the full array
 * atomically via db.batch, deduped by id (last-wins) to match the backfill's
 * onConflictDoUpdate and stay safe against any duplicate PK.
 */
import { asc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { additionalPayments, paymentRefunds } from '@/lib/db/schema';
import type { AdditionalPayment, PaymentRefund } from '@/types/additionalPayment';
import type {
  AdditionalPaymentInsert,
  AdditionalPaymentRow,
  PaymentRefundInsert,
  PaymentRefundRow,
} from '@/lib/db/schema/additionalPayments';

const u = <T>(x: T | null): T | undefined => (x == null ? undefined : x);
const n = (x?: number | null) => (x != null ? String(x) : null);
const num = (x: string | null): number | undefined => (x != null ? Number(x) : undefined);

function payToRow(p: AdditionalPayment): AdditionalPaymentInsert {
  return {
    id: p.id,
    reservationNumber: p.reservationNumber,
    description: p.description,
    amountCzk: String(p.amountCzk),
    guestEmail: p.guestEmail ?? null,
    guestName: p.guestName ?? null,
    status: p.status,
    createdAt: new Date(p.createdAt),
    paidAt: p.paidAt ? new Date(p.paidAt) : null,
    invoiceId: p.invoiceId ?? null,
    stripeFeeCzk: n(p.stripeFeeCzk),
    isMainPayment: p.isMainPayment ?? null,
  };
}

function refundToRow(paymentId: string, r: PaymentRefund): PaymentRefundInsert {
  return {
    id: r.id,
    additionalPaymentId: paymentId,
    amountCzk: String(r.amountCzk),
    refundedAt: new Date(r.refundedAt),
    reason: r.reason ?? null,
    refundedBy: r.refundedBy ?? null,
    status: r.status,
    failureReason: r.failureReason ?? null,
  };
}

function refundFromRow(r: PaymentRefundRow): PaymentRefund {
  return {
    id: r.id,
    amountCzk: Number(r.amountCzk),
    refundedAt: r.refundedAt.toISOString(),
    reason: u(r.reason),
    refundedBy: u(r.refundedBy),
    status: r.status,
    failureReason: u(r.failureReason),
  };
}

function payFromRow(row: AdditionalPaymentRow, refunds: PaymentRefund[]): AdditionalPayment {
  return {
    id: row.id,
    reservationNumber: row.reservationNumber,
    description: row.description,
    amountCzk: Number(row.amountCzk),
    guestEmail: u(row.guestEmail),
    guestName: u(row.guestName),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    paidAt: row.paidAt ? row.paidAt.toISOString() : undefined,
    invoiceId: u(row.invoiceId),
    stripeFeeCzk: num(row.stripeFeeCzk),
    isMainPayment: u(row.isMainPayment),
    // Omit the key entirely when there are no refunds (matches the Redis shape
    // where unrefunded payments have no `refunds` property).
    ...(refunds.length > 0 ? { refunds } : {}),
  };
}

export async function listAdditionalPaymentsPg(): Promise<AdditionalPayment[]> {
  const [pays, refs] = await Promise.all([
    db.select().from(additionalPayments).orderBy(asc(additionalPayments.createdAt), asc(additionalPayments.id)),
    db.select().from(paymentRefunds).orderBy(asc(paymentRefunds.refundedAt)),
  ]);
  const byPayment = new Map<string, PaymentRefund[]>();
  for (const r of refs) {
    const list = byPayment.get(r.additionalPaymentId) ?? [];
    list.push(refundFromRow(r));
    byPayment.set(r.additionalPaymentId, list);
  }
  return pays.map((p) => payFromRow(p, byPayment.get(p.id) ?? []));
}

export async function replaceAllAdditionalPaymentsPg(items: AdditionalPayment[]): Promise<void> {
  // Dedup by id (last-wins) across both tables — ids are Stripe session/refund
  // ids (unique by construction), but this keeps the bulk insert safe.
  const payById = new Map<string, AdditionalPaymentInsert>();
  const refundById = new Map<string, PaymentRefundInsert>();
  for (const p of items) {
    if (!p?.id) continue;
    payById.set(p.id, payToRow(p));
    for (const r of p.refunds ?? []) {
      if (!r?.id) continue;
      refundById.set(r.id, refundToRow(p.id, r));
    }
  }
  const payRows = [...payById.values()];
  const refundRows = [...refundById.values()];

  if (payRows.length === 0) {
    await db.batch([db.delete(paymentRefunds), db.delete(additionalPayments)]);
    return;
  }
  // Delete children before parents, insert parents before children (no FK, but
  // logically ordered). db.batch runs as one atomic tx on neon-http.
  if (refundRows.length > 0) {
    await db.batch([
      db.delete(paymentRefunds),
      db.delete(additionalPayments),
      db.insert(additionalPayments).values(payRows),
      db.insert(paymentRefunds).values(refundRows),
    ]);
  } else {
    await db.batch([
      db.delete(paymentRefunds),
      db.delete(additionalPayments),
      db.insert(additionalPayments).values(payRows),
    ]);
  }
}

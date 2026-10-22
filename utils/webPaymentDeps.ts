/**
 * Real I/O behind utils/webPaymentServer.ts — Stripe, the bookings mirror, the
 * Stripe payment log and the reservation overlay. Server-only.
 */
import { and, eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import { bookingsMirror, reservationOverrides } from "@/lib/db/schema";
import type { BookingsMirrorRow } from "@/lib/db/schema/bookingsMirror";
import { readsFromPostgres, writesToPostgres } from "@/lib/dataStore";
import type { PlatformRefund, StayShortening } from "@/types/reservation";
import { readAllAdditionalPayments } from "@/utils/additionalPaymentsStore";
import { readAllReservationOverrides } from "@/utils/reservationOverridesStore";
import { readAllStripePayments } from "@/utils/stripePaymentsStore";
import { stripeClient } from "@/utils/stripePayouts";
import { sendTelegram } from "@/utils/telegram";
import type { StripeRefundLite, WebBookingFacts } from "@/utils/webPaymentRefund";
import type { RecordOutcome, WebPaymentDeps, WebPaymentStripe } from "@/utils/webPaymentServer";

interface OverlayEntry {
  platformRefund?: PlatformRefund | null;
  nonArrival?: unknown;
  stayShortened?: StayShortening | null;
}

function refundLite(r: Stripe.Refund): StripeRefundLite {
  return { id: r.id, amountHal: r.amount, status: r.status ?? "pending", created: r.created, metadata: r.metadata ?? {} };
}

function stripeDeps(stripe: Stripe): WebPaymentStripe {
  return {
    async retrieveSession(sessionId) {
      const s = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["payment_intent.latest_charge"] });
      const pi = s.payment_intent;
      const charge = pi && typeof pi !== "string" ? pi.latest_charge : null;
      return {
        id: s.id,
        paymentStatus: s.payment_status,
        currency: s.currency ?? "",
        charge: charge && typeof charge !== "string"
          ? { id: charge.id, amountHal: charge.amount, amountRefundedHal: charge.amount_refunded, currency: charge.currency }
          : null,
      };
    },
    async listRefunds(chargeId) {
      const list = await stripe.refunds.list({ charge: chargeId, limit: 100 });
      return list.data.map(refundLite);
    },
    async createRefund({ chargeId, amountHal, metadata }, idempotencyKey) {
      const r = await stripe.refunds.create(
        { charge: chargeId, amount: amountHal, reason: "requested_by_customer", metadata },
        { idempotencyKey },
      );
      return refundLite(r);
    },
  };
}

function facts(row: BookingsMirrorRow, overlay: OverlayEntry | undefined): WebBookingFacts {
  return {
    reservationNumber: row.reservationNumber,
    channel: row.channel,
    checkInDate: row.checkInDate,
    checkOutDate: row.checkOutDate,
    price: Number(row.price),
    email: row.email,
    bookingTimestamp: row.bookingTimestamp ? row.bookingTimestamp.toISOString() : null,
    isCancelled: row.isCancelled,
    stayShortened: overlay?.stayShortened ?? null,
  };
}

/**
 * Add to a booking's platform refund with one row-level compare-and-swap on
 * public.reservation_overrides: only the `platformRefund` key is replaced, and
 * only if it still holds what was read — so a concurrent edit of the same
 * refund retries instead of being overwritten, and other keys on the row are
 * never touched. Never the whole-table writeAllReservationOverrides.
 */
async function recordPlatformRefundPg(
  reservationNumber: string,
  merge: (existing: PlatformRefund | null) => PlatformRefund | null,
): Promise<RecordOutcome> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const rows = await db
      .select({ data: reservationOverrides.data })
      .from(reservationOverrides)
      .where(eq(reservationOverrides.reservationNumber, reservationNumber));
    const data = rows[0]?.data as OverlayEntry | undefined;
    const existing = data?.platformRefund ?? null;
    const next = merge(existing);
    if (!next) return { mode: "server", written: false, platformRefund: existing };

    const done = rows.length === 0
      ? await db
          .insert(reservationOverrides)
          .values({ reservationNumber, data: { platformRefund: next } })
          .onConflictDoNothing()
          .returning({ rn: reservationOverrides.reservationNumber })
      : await db
          .update(reservationOverrides)
          .set({ data: sql`${reservationOverrides.data} || jsonb_build_object('platformRefund', ${JSON.stringify(next)}::jsonb)` })
          .where(and(
            eq(reservationOverrides.reservationNumber, reservationNumber),
            sql`coalesce(${reservationOverrides.data} -> 'platformRefund', 'null'::jsonb) = ${JSON.stringify(existing)}::jsonb`,
          ))
          .returning({ rn: reservationOverrides.reservationNumber });
    if (done.length > 0) return { mode: "server", written: true, platformRefund: next };
  }
  throw new Error("The booking's refund was being edited at the same time — record it again");
}

export function pragueDate(unixSeconds?: number): string {
  const d = unixSeconds === undefined ? new Date() : new Date(unixSeconds * 1000);
  return d.toLocaleDateString("sv-SE", { timeZone: "Europe/Prague" });
}

export function webPaymentDeps(): WebPaymentDeps {
  let overlays: Promise<Record<string, OverlayEntry>> | null = null;
  const overlayMap = () => (overlays ??= readAllReservationOverrides<OverlayEntry>());
  const stripe = stripeClient();

  return {
    async loadBooking(reservationNumber) {
      const [rows, map] = await Promise.all([
        db.select().from(bookingsMirror).where(eq(bookingsMirror.reservationNumber, reservationNumber)).limit(1),
        overlayMap(),
      ]);
      return rows[0] ? facts(rows[0], map[reservationNumber]) : null;
    },
    async loadSameGuestBookings(email) {
      const [rows, map] = await Promise.all([
        db.select().from(bookingsMirror).where(and(
          eq(bookingsMirror.channel, "Direct-Web"),
          sql`lower(${bookingsMirror.email}) = ${email.trim().toLowerCase()}`,
        )),
        overlayMap(),
      ]);
      return rows.map((r) => facts(r, map[r.reservationNumber]));
    },
    async loadCheckouts() {
      return (await readAllStripePayments()).map((p) => ({
        sessionId: p.sessionId,
        description: p.description ?? "",
        amountCzk: p.amountCzk,
        guestEmail: p.guestEmail ?? "",
        paidAt: p.paidAt,
      }));
    },
    async loadOverlay(reservationNumber) {
      return (await overlayMap())[reservationNumber] ?? null;
    },
    async additionalPaymentOwner(sessionId) {
      return (await readAllAdditionalPayments()).find((p) => p.id === sessionId)?.reservationNumber ?? null;
    },
    stripe: stripe ? stripeDeps(stripe) : null,
    async recordPlatformRefund(reservationNumber, merge) {
      // Per-row writes only make sense where the overlay lives in Postgres alone;
      // elsewhere (local dev on the frozen Redis key) the drawer saves it.
      if (!readsFromPostgres("reservationOverrides") || !writesToPostgres("reservationOverrides")) return { mode: "client" };
      return recordPlatformRefundPg(reservationNumber, merge);
    },
    async notify(html) {
      await sendTelegram(html);
    },
    pragueDate,
    nowIso: () => new Date().toISOString(),
  };
}

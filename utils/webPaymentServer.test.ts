import { describe, it, expect, vi } from "vitest";
import type { PlatformRefund } from "@/types/reservation";
import type { StripeRefundLite, WebBookingFacts, WebCheckout } from "./webPaymentRefund";
import {
  getWebPaymentState,
  recordExistingRefund,
  refundWebPayment,
  WebPaymentError,
  type RecordOutcome,
  type WebPaymentDeps,
} from "./webPaymentServer";

/**
 * The refund flow end to end against an in-memory Stripe + overlay, modelled on
 * BH-92586229: a 48 735,60 Kč website payment for a 28-night stay shortened to
 * 6 nights, whose guest also has an earlier booking paid separately.
 */
const RN = "BH-92586229";
const SESSION = "cs_test_w07";
const CHARGE = "ch_test_1";

const CHECKOUTS: WebCheckout[] = [
  { sessionId: "cs_test_w06", description: "Web booking 2026-09-12 → 2026-09-27", amountCzk: 27521.6, guestEmail: "guest6@example.com", paidAt: "2026-09-03T16:14:03Z" },
  { sessionId: SESSION, description: "Web booking 2026-09-27 → 2026-10-25", amountCzk: 48735.6, guestEmail: "guest6@example.com", paidAt: "2026-09-04T13:27:16Z" },
];

const BOOKING: WebBookingFacts = {
  reservationNumber: RN,
  channel: "Direct-Web",
  checkInDate: "2026-09-27",
  checkOutDate: "2026-10-03",
  price: 48735.6,
  email: "guest6@example.com",
  bookingTimestamp: "2026-09-04T13:27:33Z",
  isCancelled: false,
  stayShortened: { fromArrival: "2026-09-27", fromDeparture: "2026-10-25", originalPriceCzk: 48735.6 },
};
const OTHER: WebBookingFacts = {
  ...BOOKING,
  reservationNumber: "BH-92538626",
  checkInDate: "2026-09-12",
  checkOutDate: "2026-09-27",
  price: 27521.6,
  bookingTimestamp: "2026-09-03T16:14:19Z",
  stayShortened: null,
};

function world(opts: {
  booking?: Partial<WebBookingFacts>;
  overlay?: { platformRefund?: PlatformRefund | null; nonArrival?: unknown };
  refunds?: StripeRefundLite[];
  apOwner?: string | null;
  stripe?: boolean;
  recordMode?: "server" | "client" | "throw";
  createRefund?: (amountHal: number) => StripeRefundLite;
} = {}) {
  let overlay = { ...(opts.overlay ?? {}) };
  const refunds: StripeRefundLite[] = [...(opts.refunds ?? [])];
  const notes: string[] = [];
  let seq = 0;
  const createRefund = vi.fn(async (input: { chargeId: string; amountHal: number; metadata: Record<string, string> }, key: string) => {
    const r = opts.createRefund?.(input.amountHal)
      ?? { id: `re_new_${++seq}`, amountHal: input.amountHal, status: "pending", created: 1_793_440_800, metadata: input.metadata };
    refunds.push(r);
    return { ...r, key };
  });
  const deps: WebPaymentDeps = {
    loadBooking: async (rn) => (rn === RN ? { ...BOOKING, ...opts.booking } : null),
    loadSameGuestBookings: async () => [{ ...BOOKING, ...opts.booking }, OTHER],
    loadCheckouts: async () => CHECKOUTS,
    loadOverlay: async () => overlay,
    additionalPaymentOwner: async () => opts.apOwner ?? null,
    stripe: opts.stripe === false ? null : {
      retrieveSession: async (id) => ({
        id,
        paymentStatus: "paid",
        currency: "czk",
        charge: { id: CHARGE, amountHal: 4_873_560, amountRefundedHal: 0, currency: "czk" },
      }),
      listRefunds: async () => [...refunds],
      createRefund,
    },
    recordPlatformRefund: async (_rn, merge): Promise<RecordOutcome> => {
      if (opts.recordMode === "client") return { mode: "client" };
      if (opts.recordMode === "throw") throw new Error("database unreachable");
      const next = merge(overlay.platformRefund ?? null);
      if (!next) return { mode: "server", written: false, platformRefund: overlay.platformRefund ?? null };
      overlay = { ...overlay, platformRefund: next };
      return { mode: "server", written: true, platformRefund: next };
    },
    notify: async (html) => { notes.push(html); },
    pragueDate: (unix) => (unix === undefined ? "2026-10-31" : new Date(unix * 1000).toLocaleDateString("sv-SE", { timeZone: "Europe/Prague" })),
    nowIso: () => "2026-10-31T10:00:00.000Z",
  };
  return { deps, notes, createRefund, overlay: () => overlay, refunds };
}

const refundInput = (over: Partial<Parameters<typeof refundWebPayment>[1]> = {}) => ({
  reservationNumber: RN,
  sessionId: SESSION,
  amountCzk: 22000,
  reason: "22 nights <resold>",
  idempotencyKey: "key-12345678",
  operator: "admin@example.com",
  ...over,
});

async function rejects(p: Promise<unknown>, status: number, text?: string) {
  const err = await p.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(WebPaymentError);
  expect((err as WebPaymentError).status).toBe(status);
  if (text) expect((err as WebPaymentError).message).toContain(text);
}

describe("web payment state", () => {
  it("shows the linked payment with live Stripe figures", async () => {
    const w = world({ refunds: [{ id: "re_dash", amountHal: 100_000, status: "succeeded", created: 1_760_000_000 }] });
    const s = await getWebPaymentState(w.deps, RN);
    expect(s.link).toMatchObject({ status: "linked", checkout: { sessionId: SESSION } });
    expect(s.blocked).toBeUndefined();
    expect(s.stripe).toMatchObject({ paidCzk: 48735.6, refundedCzk: 1000, refundableCzk: 47735.6 });
    expect(s.unrecorded.map((r) => r.id)).toEqual(["re_dash"]); // made in the Dashboard, not counted yet
    expect(s.unrecorded[0].fromApp).toBe(false);
  });

  it("explains why there's nothing to refund", async () => {
    expect((await getWebPaymentState(world({ booking: { isCancelled: true } }).deps, RN)).blocked).toContain("Cancelled");
    expect((await getWebPaymentState(world({ overlay: { nonArrival: { flaggedAt: "x" } } }).deps, RN)).blocked).toContain("non-arrival");
    expect((await getWebPaymentState(world({ stripe: false }).deps, RN)).blocked).toContain("Stripe isn't configured");
    const taken = await getWebPaymentState(world({ apOwner: "BH-1" }).deps, RN);
    expect(taken.link.status).toBe("ambiguous");
    expect(taken.blocked).toContain("BH-1");
  });

  it("refuses non-website bookings and unknown ones", async () => {
    await rejects(getWebPaymentState(world({ booking: { channel: "Booking.com" } }).deps, RN), 400);
    await rejects(getWebPaymentState(world().deps, "BH-1"), 404);
  });
});

describe("refunding a web payment", () => {
  it("refunds through Stripe and records it on the booking in one step", async () => {
    const w = world();
    const out = await refundWebPayment(w.deps, refundInput());

    expect(w.createRefund).toHaveBeenCalledTimes(1);
    const [params, key] = w.createRefund.mock.calls[0];
    expect(params).toEqual({
      chargeId: CHARGE,
      amountHal: 2_200_000,
      metadata: {
        source: "reporting-web-refund",
        reservationNumber: RN,
        sessionId: SESSION,
        operatorEmail: "admin@example.com",
        idempotencyKey: "key-12345678",
        operatorNote: "22 nights <resold>",
      },
    });
    expect(key).toBe("web-refund-key-12345678");

    expect(out.recorded).toBe("server");
    expect(out.remainingRefundableCzk).toBe(26735.6);
    expect(w.overlay().platformRefund).toMatchObject({
      amountCzk: 22000,
      refundedAt: "2026-10-31",
      reason: "22 nights <resold>",
      flaggedBy: "admin@example.com",
      originalPriceCzk: 48735.6,
      stripeRefunds: [{ id: "re_new_1", sessionId: SESSION, amountCzk: 22000, by: "admin@example.com" }],
    });
    expect(w.notes).toHaveLength(1);
    expect(w.notes[0]).toContain("Recorded on the booking ✅");
    expect(w.notes[0]).toContain("22 nights &lt;resold&gt;"); // user text escaped for Telegram HTML
  });

  it("refunds to the haléř — the whole 48 735,60 Kč", async () => {
    const w = world();
    const out = await refundWebPayment(w.deps, refundInput({ amountCzk: "48735.60" }));
    expect(w.createRefund.mock.calls[0][0].amountHal).toBe(4_873_560);
    expect(out.remainingRefundableCzk).toBe(0);
    expect(w.overlay().platformRefund?.amountCzk).toBe(48735.6);
  });

  it("caps the refund at what Stripe still holds", async () => {
    const w = world({ refunds: [{ id: "re_dash", amountHal: 4_000_000, status: "succeeded", created: 1 }] });
    await rejects(refundWebPayment(w.deps, refundInput({ amountCzk: 10_000 })), 400, "735,6 Kč");
    expect(w.createRefund).not.toHaveBeenCalled();
  });

  it("finishes a retried request instead of refunding twice", async () => {
    const w = world();
    await refundWebPayment(w.deps, refundInput());
    // Same idempotency key again — e.g. the response was lost and the operator clicked again
    const again = await refundWebPayment(w.deps, refundInput());
    expect(w.createRefund).toHaveBeenCalledTimes(1);
    expect(again.recorded).toBe("already");
    expect(w.overlay().platformRefund?.amountCzk).toBe(22000);
  });

  it("refuses when the booking can't take a refund — before touching Stripe", async () => {
    for (const w of [
      world({ booking: { isCancelled: true } }),
      world({ overlay: { nonArrival: { flaggedAt: "x" } } }),
      world({ apOwner: "BH-1" }),
    ]) {
      await rejects(refundWebPayment(w.deps, refundInput()), 409);
      expect(w.createRefund).not.toHaveBeenCalled();
    }
    await rejects(refundWebPayment(world({ stripe: false }).deps, refundInput()), 409, "Stripe");
  });

  it("refuses a payment that isn't the one tied to this booking", async () => {
    const w = world();
    await rejects(refundWebPayment(w.deps, refundInput({ sessionId: "cs_test_w06" })), 409, "reload");
    expect(w.createRefund).not.toHaveBeenCalled();
  });

  it("validates the amount and the idempotency key", async () => {
    const w = world();
    await rejects(refundWebPayment(w.deps, refundInput({ amountCzk: 0 })), 400);
    await rejects(refundWebPayment(w.deps, refundInput({ amountCzk: "1.234" })), 400);
    await rejects(refundWebPayment(w.deps, refundInput({ idempotencyKey: "" })), 400);
    expect(w.createRefund).not.toHaveBeenCalled();
  });

  it("records nothing when Stripe refuses", async () => {
    const w = world();
    w.createRefund.mockRejectedValueOnce(new Error("Insufficient funds"));
    await rejects(refundWebPayment(w.deps, refundInput()), 502, "Insufficient funds");
    expect(w.overlay().platformRefund).toBeUndefined();

    const failed = world({ createRefund: (amountHal) => ({ id: "re_x", amountHal, status: "failed", created: 1 }) });
    await rejects(refundWebPayment(failed.deps, refundInput()), 502, "failed");
    expect(failed.overlay().platformRefund).toBeUndefined();
  });

  it("keeps the refund and says so when recording it fails", async () => {
    const w = world({ recordMode: "throw" });
    const out = await refundWebPayment(w.deps, refundInput());
    expect(out.recorded).toBe("failed");
    expect(out.recordError).toContain("database unreachable");
    expect(out.entry).toMatchObject({ id: "re_new_1", amountCzk: 22000 });
    expect(w.notes[0]).toContain("NOT recorded");
    // …and the drawer then offers it as an unrecorded refund
    expect((await getWebPaymentState(w.deps, RN)).unrecorded.map((r) => r.id)).toEqual(["re_new_1"]);
  });

  it("hands the record to the drawer where the overlay can't take a per-row write", async () => {
    const out = await refundWebPayment(world({ recordMode: "client" }).deps, refundInput());
    expect(out.recorded).toBe("client");
    expect(out.platformRefund).toBeNull();
    expect(out.entry.amountCzk).toBe(22000);
  });

  it("adds to a refund already recorded by hand", async () => {
    const w = world({
      overlay: {
        platformRefund: { amountCzk: 1000, refundedAt: "2026-10-05", flaggedAt: "2026-10-05T09:00:00Z", flaggedBy: "ops@example.com", originalPriceCzk: 48735.6 },
      },
    });
    await refundWebPayment(w.deps, refundInput({ reason: undefined }));
    expect(w.overlay().platformRefund).toMatchObject({ amountCzk: 23000, flaggedBy: "ops@example.com", refundedAt: "2026-10-31" });
  });
});

describe("recording a refund made in the Stripe Dashboard", () => {
  const dash: StripeRefundLite = { id: "re_dash", amountHal: 500_000, status: "succeeded", created: 1_791_540_000, metadata: {} };

  it("counts it once, dated when Stripe made it", async () => {
    const w = world({ refunds: [dash] });
    const out = await recordExistingRefund(w.deps, { reservationNumber: RN, refundId: "re_dash", operator: "ops@example.com" });
    expect(out.recorded).toBe("server");
    expect(w.overlay().platformRefund).toMatchObject({ amountCzk: 5000, refundedAt: "2026-10-09" });
    const again = await recordExistingRefund(w.deps, { reservationNumber: RN, refundId: "re_dash", operator: "ops@example.com" });
    expect(again.recorded).toBe("already");
    expect(w.overlay().platformRefund?.amountCzk).toBe(5000);
    expect(w.notes).toHaveLength(1);
    expect(w.createRefund).not.toHaveBeenCalled();
  });

  it("refuses refunds that aren't on this payment or didn't go through", async () => {
    await rejects(recordExistingRefund(world({ refunds: [dash] }).deps, { reservationNumber: RN, refundId: "re_other", operator: "x" }), 404);
    await rejects(
      recordExistingRefund(world({ refunds: [{ ...dash, status: "failed" }] }).deps, { reservationNumber: RN, refundId: "re_dash", operator: "x" }),
      400,
    );
  });
});

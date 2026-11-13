/**
 * Real wiring for the pay-later engine (io.ts). Server-only.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { appSettings, reservationOverrides } from '@/lib/db/schema';
import { readsFromPostgres, writesToPostgres } from '@/lib/dataStore';
import { webPaymentRepo } from '@/data-access/webPayments';
import type { Issue } from '@/types/reservation';
import type { WebPaymentMode } from '@/types/webPayment';
import { readAllAdditionalPayments } from '@/utils/additionalPaymentsStore';
import { cronBaseUrl } from '@/utils/cronAuth';
import { sendGuestEmail } from '@/utils/guestEmail';
import { readAllReservationOverrides, writeAllReservationOverrides } from '@/utils/reservationOverridesStore';
import { appendStripePayment } from '@/utils/stripePaymentsStore';
import { sendTechnicalAlert } from '@/utils/telegram';
import { readAllVouchers, writeAllVouchers } from '@/utils/vouchersStore';
import { realBeds24 } from './beds24Ops';
import { pragueDateOf } from './dates';
import type { PayLaterIo } from './io';
import { realStripe } from './stripeOps';

export const MODE_KEY = 'web-payments:mode';
const MODES: WebPaymentMode[] = ['off', 'manual', 'auto'];

/** Missing or unreadable → 'off': nothing is ever charged by accident. */
export async function readWebPaymentMode(): Promise<WebPaymentMode> {
  const r = await db.select().from(appSettings).where(eq(appSettings.key, MODE_KEY)).limit(1);
  const v = (r[0]?.value as { mode?: string } | undefined)?.mode;
  return MODES.includes(v as WebPaymentMode) ? (v as WebPaymentMode) : 'off';
}

export async function writeWebPaymentMode(mode: WebPaymentMode, by: string): Promise<void> {
  if (!MODES.includes(mode)) throw new Error(`Bad mode ${mode}`);
  const value = { mode, by, at: new Date().toISOString() };
  await db
    .insert(appSettings)
    .values({ key: MODE_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}

type WithIssues = { issues?: Issue[] };

/**
 * Change one booking's Pending tasks. Where the overlay lives in Postgres alone
 * this is a row-level compare-and-swap on `data.issues` (the same pattern as
 * the web-refund record, utils/webPaymentDeps): other keys on the row and other
 * bookings are never touched, and a concurrent edit retries instead of being
 * overwritten. Elsewhere (local dev on Redis) the store's whole-map write.
 * `change` returns the new list, or null for "nothing to do".
 */
async function changeIssues(reservationNumber: string, change: (issues: Issue[]) => Issue[] | null): Promise<boolean> {
  if (readsFromPostgres('reservationOverrides') && writesToPostgres('reservationOverrides')) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const rows = await db
        .select({ data: reservationOverrides.data })
        .from(reservationOverrides)
        .where(eq(reservationOverrides.reservationNumber, reservationNumber));
      const existing = (rows[0]?.data as WithIssues | undefined)?.issues;
      const before = Array.isArray(existing) ? existing : null;
      const next = change(before ?? []);
      if (!next) return false;
      const done =
        rows.length === 0
          ? await db
              .insert(reservationOverrides)
              .values({ reservationNumber, data: { issues: next } })
              .onConflictDoNothing()
              .returning({ rn: reservationOverrides.reservationNumber })
          : await db
              .update(reservationOverrides)
              .set({ data: sql`${reservationOverrides.data} || jsonb_build_object('issues', ${JSON.stringify(next)}::jsonb)` })
              .where(
                and(
                  eq(reservationOverrides.reservationNumber, reservationNumber),
                  sql`coalesce(${reservationOverrides.data} -> 'issues', 'null'::jsonb) = ${JSON.stringify(before)}::jsonb`,
                ),
              )
              .returning({ rn: reservationOverrides.reservationNumber });
      if (done.length > 0) return true;
    }
    throw new Error(`Tasks on ${reservationNumber} were being edited at the same time`);
  }
  const overrides = await readAllReservationOverrides<WithIssues>();
  const current = overrides[reservationNumber] ?? {};
  const next = change(Array.isArray(current.issues) ? current.issues : []);
  if (!next) return false;
  overrides[reservationNumber] = { ...current, issues: next };
  await writeAllReservationOverrides(overrides);
  return true;
}

export function webPaymentsIo(): PayLaterIo {
  return {
    repo: webPaymentRepo,
    stripe: realStripe(),
    beds24: realBeds24(),

    async sendEmail(to, subject, html) {
      await sendGuestEmail({ to, subject, html });
    },

    async techAlert(html) {
      await sendTechnicalAlert(html).catch((err) => console.error('[web-payments] Telegram failed:', err));
    },

    async addTask(reservationNumber, id, text) {
      // One task per id, ever: a task ops resolved stays resolved (no re-nagging).
      return changeIssues(reservationNumber, (issues) => {
        if (issues.some((i) => i.id === id)) return null;
        const now = new Date();
        return [...issues, { id, category: 'problem', text, actionableDate: pragueDateOf(now), resolved: false, createdAt: now.toISOString() }];
      });
    },

    async resolveTasks(reservationNumber, idPrefix) {
      await changeIssues(reservationNumber, (issues) =>
        issues.some((i) => i.id.startsWith(idPrefix) && !i.resolved)
          ? issues.map((i) => (i.id.startsWith(idPrefix) ? { ...i, resolved: true } : i))
          : null,
      );
    },

    async paidElsewhere(reservationNumbers) {
      const out = new Map<string, string>();
      if (reservationNumbers.length === 0) return out;
      const [overrides, links] = await Promise.all([
        readAllReservationOverrides<{ paymentStatusOverride?: string | null }>(),
        readAllAdditionalPayments(),
      ]);
      for (const rn of reservationNumbers) {
        const override = overrides[rn]?.paymentStatusOverride;
        if (override === 'Paid' || override === 'Partially Paid') {
          out.set(rn, `the drawer's payment status is set to "${override}"`);
          continue;
        }
        const paid = links.filter((p) => p.reservationNumber === rn && (p.status === 'paid' || p.status === 'partially-refunded'));
        if (paid.length > 0) {
          const sum = paid.reduce((s, p) => s + p.amountCzk, 0);
          out.set(rn, `a payment link was paid (${sum.toLocaleString('cs-CZ')} Kč)`);
        }
      }
      return out;
    },

    async restoreVoucher(code, reservationNumber) {
      const vouchers = await readAllVouchers();
      const norm = code.trim().toLowerCase();
      const idx = vouchers.findIndex((v) => v.code.toLowerCase() === norm && v.status !== 'deleted');
      if (idx === -1) return 'not_found';
      const v = vouchers[idx];
      if (v.status !== 'used' || v.redeemedOnReservationNumber !== reservationNumber) return 'not_used_here';
      vouchers[idx] = { ...v, status: 'issued', usedAt: undefined, redeemedOnReservationNumber: undefined };
      await writeAllVouchers(vouchers);
      return 'restored';
    },

    async logPayment(record) {
      await appendStripePayment({ ...record, reservationNumber: undefined });
    },

    mode: readWebPaymentMode,
    now: () => new Date(),
    newId: (prefix) => `${prefix}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
    newToken: () => randomBytes(24).toString('base64url'),
    baseUrl: cronBaseUrl,
  };
}

/**
 * Parity monitor read layer — assembles snapshot rows back into the per-stay,
 * per-unit view the Pricing tab renders. Pure Postgres reads.
 */
import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import { priceCheckRequests, priceSnapshots } from '@/lib/db/schema';
import type { PriceSnapshotRow } from '@/lib/db/schema';
import { PARITY_UNITS } from '@/data/parityConfig';
import type {
  DiscountLine,
  ParityCell,
  ParityOffer,
  ParityRequestView,
  ParityResponse,
  ParityRunView,
  ParitySlotView,
} from '@/utils/parityTypes';

function toNum(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function rowToOffer(row: PriceSnapshotRow): ParityOffer {
  return {
    price: toNum(row.price),
    originalPrice: toNum(row.originalPrice),
    labels: Array.isArray(row.labels) ? (row.labels as string[]) : [],
    discountBreakdown: Array.isArray(row.discounts) ? (row.discounts as DiscountLine[]) : undefined,
    availability: (row.availability as ParityOffer['availability']) ?? 'not_available',
  };
}

/** Group one run's rows into the slot × unit × channel view. */
export function rowsToSlots(rows: PriceSnapshotRow[]): ParitySlotView[] {
  const bySlot = new Map<string, PriceSnapshotRow[]>();
  for (const row of rows) {
    const key = `${row.checkIn}|${row.nights}`;
    const list = bySlot.get(key) ?? [];
    list.push(row);
    bySlot.set(key, list);
  }

  const slots: ParitySlotView[] = [];
  for (const slotRows of bySlot.values()) {
    const first = slotRows[0];
    const units: ParityCell[] = PARITY_UNITS.map((unit) => {
      const unitRows = slotRows.filter((r) => r.unitId === unit.id);
      const channel = (name: string) => unitRows.find((r) => r.channel === name);
      const bookingRow = channel('booking');
      return {
        unitId: unit.id,
        unitLabel: unit.label,
        web: channel('web') ? rowToOffer(channel('web')!) : null,
        airbnb: channel('airbnb') ? rowToOffer(channel('airbnb')!) : null,
        booking: bookingRow ? rowToOffer(bookingRow) : null,
        expectedBooking: bookingRow ? toNum(bookingRow.expectedPrice) : null,
      };
    });
    slots.push({
      checkIn: first.checkIn,
      checkOut: addDays(first.checkIn, first.nights),
      nights: first.nights,
      leadDays: first.leadDays,
      units,
    });
  }

  slots.sort((a, b) => (a.checkIn !== b.checkIn ? a.checkIn.localeCompare(b.checkIn) : a.nights - b.nights));
  return slots;
}

async function loadRun(runId: string): Promise<PriceSnapshotRow[]> {
  return db.select().from(priceSnapshots).where(eq(priceSnapshots.runId, runId));
}

export async function readParity(): Promise<ParityResponse> {
  // Latest grid run.
  const [latest] = await db
    .select({ runId: priceSnapshots.runId, capturedAt: priceSnapshots.capturedAt, source: priceSnapshots.source })
    .from(priceSnapshots)
    .where(eq(priceSnapshots.source, 'grid'))
    .orderBy(desc(priceSnapshots.capturedAt))
    .limit(1);

  let latestGrid: ParityRunView | null = null;
  if (latest) {
    const rows = await loadRun(latest.runId);
    latestGrid = {
      runId: latest.runId,
      source: 'grid',
      capturedAt: latest.capturedAt.toISOString(),
      slots: rowsToSlots(rows),
    };
  }

  // Recent custom checks, newest first, with results where finished.
  const requests = await db
    .select()
    .from(priceCheckRequests)
    .orderBy(desc(priceCheckRequests.requestedAt))
    .limit(10);

  const doneRunIds = requests.filter((r) => r.runId).map((r) => r.runId!) as string[];
  const doneRows =
    doneRunIds.length > 0
      ? await db.select().from(priceSnapshots).where(inArray(priceSnapshots.runId, doneRunIds))
      : [];

  const requestViews: ParityRequestView[] = requests.map((r) => ({
    id: r.id,
    checkIn: r.checkIn,
    nights: r.nights,
    status: r.status,
    requestedAt: r.requestedAt.toISOString(),
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    error: r.error,
    result: r.runId
      ? rowsToSlots(doneRows.filter((row) => row.runId === r.runId && row.checkIn === r.checkIn && row.nights === r.nights))
      : null,
  }));

  return { latestGrid, requests: requestViews };
}

export async function queueCheck(
  checkIn: string,
  nights: number,
  requestedBy: string | null,
): Promise<{ id: number } | { error: string }> {
  const pending = await db
    .select({ id: priceCheckRequests.id })
    .from(priceCheckRequests)
    .where(eq(priceCheckRequests.status, 'pending'));
  if (pending.length >= 5) {
    return { error: 'Five checks are already queued — the runner picks them up within a few minutes.' };
  }
  const [row] = await db
    .insert(priceCheckRequests)
    .values({ checkIn, nights, requestedBy })
    .returning({ id: priceCheckRequests.id });
  return { id: row.id };
}

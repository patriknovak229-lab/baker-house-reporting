/**
 * Parity monitor read layer — assembles snapshot rows back into the per-stay,
 * per-unit view the Pricing tab renders. Pure Postgres reads.
 */
import { and, desc, eq, gte, inArray, like, lte, notLike, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { priceCheckRequests, priceSnapshots } from '@/lib/db/schema';
import type { PriceSnapshotRow } from '@/lib/db/schema';
import { COMPETITORS, PARITY_SWEEP, PARITY_UNITS } from '@/data/parityConfig';
import { readParityRuleConfig } from '@/data-access/pricing/rules';
import { pragueToday } from '@/utils/periodUtils';
import type {
  BoardObservation,
  BoardRow,
  BoardUnitCell,
  CompetitorObservation,
  DiscountLine,
  ParityCell,
  ParityChannel,
  ParityOffer,
  ParityRequestView,
  ParityResponse,
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

function rowToBoardObservation(row: PriceSnapshotRow): BoardObservation {
  return { ...rowToOffer(row), capturedAt: row.capturedAt.toISOString() };
}

/**
 * Freshest observation per (unit, channel, check-in) for one stay length —
 * the boards deliberately mix vintages (web refreshes daily, far-zone scrapes
 * rotate), and each cell carries its own capture time so the UI can say so.
 */
async function readBoard(nights: number, todayIso: string, maxAgeDays: number): Promise<BoardRow[]> {
  const to = addDays(todayIso, PARITY_SWEEP.windowDays);
  const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000);

  const rows = (await db
    .selectDistinctOn([priceSnapshots.unitId, priceSnapshots.channel, priceSnapshots.checkIn])
    .from(priceSnapshots)
    .where(
      and(
        eq(priceSnapshots.nights, nights),
        gte(priceSnapshots.checkIn, todayIso),
        lte(priceSnapshots.checkIn, to),
        gte(priceSnapshots.capturedAt, cutoff),
        notLike(priceSnapshots.unitId, 'comp:%'),
      ),
    )
    .orderBy(
      priceSnapshots.unitId,
      priceSnapshots.channel,
      priceSnapshots.checkIn,
      // Prefer the freshest USABLE observation: a run whose lookup errored
      // must not shadow yesterday's real quote (a stay quoted on a channel
      // but "error" on web reads as nonsense to the operator).
      sql`(${priceSnapshots.availability} = 'error') asc`,
      desc(priceSnapshots.capturedAt),
    )) as PriceSnapshotRow[];

  const byDate = new Map<string, PriceSnapshotRow[]>();
  for (const row of rows) {
    const list = byDate.get(row.checkIn) ?? [];
    list.push(row);
    byDate.set(row.checkIn, list);
  }

  const out: BoardRow[] = [];
  for (const [checkIn, dateRows] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const units: BoardUnitCell[] = PARITY_UNITS.map((unit) => {
      const unitRows = dateRows.filter((r) => r.unitId === unit.id);
      const chan = (name: ParityChannel) => {
        const row = unitRows.find((r) => r.channel === name);
        return row ? rowToBoardObservation(row) : null;
      };
      const web = chan('web');
      return {
        unitId: unit.id,
        unitLabel: unit.label,
        sellable: web === null ? null : web.availability === 'available',
        web,
        airbnb: chan('airbnb'),
        booking: chan('booking'),
      };
    });
    out.push({ checkIn, checkOut: addDays(checkIn, nights), nights, units });
  }
  return out;
}

async function readCompetitors(todayIso: string): Promise<CompetitorObservation[]> {
  if (COMPETITORS.length === 0) return [];
  const cutoff = new Date(Date.now() - 14 * 86_400_000);
  const rows = (await db
    .selectDistinctOn([
      priceSnapshots.unitId,
      priceSnapshots.channel,
      priceSnapshots.checkIn,
      priceSnapshots.nights,
    ])
    .from(priceSnapshots)
    .where(
      and(
        like(priceSnapshots.unitId, 'comp:%'),
        gte(priceSnapshots.checkIn, todayIso),
        gte(priceSnapshots.capturedAt, cutoff),
      ),
    )
    .orderBy(
      priceSnapshots.unitId,
      priceSnapshots.channel,
      priceSnapshots.checkIn,
      priceSnapshots.nights,
      desc(priceSnapshots.capturedAt),
    )) as PriceSnapshotRow[];

  return rows.flatMap((row) => {
    const comp = COMPETITORS.find((c) => `comp:${c.id}` === row.unitId);
    if (!comp) return [];
    return [
      {
        compId: comp.id,
        label: comp.label,
        bedrooms: comp.bedrooms,
        channel: row.channel as ParityChannel,
        checkIn: row.checkIn,
        nights: row.nights,
        price: toNum(row.price),
        originalPrice: toNum(row.originalPrice),
        labels: Array.isArray(row.labels) ? (row.labels as string[]) : [],
        capturedAt: row.capturedAt.toISOString(),
      },
    ];
  });
}

export async function readParity(): Promise<ParityResponse> {
  const today = pragueToday();

  const [latestGrid] = await db
    .select({ capturedAt: sql<Date>`max(${priceSnapshots.capturedAt})` })
    .from(priceSnapshots)
    .where(eq(priceSnapshots.source, 'grid'));

  // 1-night sweeps daily (allow 3 days of runner outage); short stays rotate
  // weekly in the far zone and 7-night rotates weekly, so those allow 9.
  const [board1n, board2n, board3n, board7n, competitors] = await Promise.all([
    readBoard(1, today, 3),
    readBoard(2, today, 9),
    readBoard(3, today, 9),
    readBoard(7, today, 9),
    readCompetitors(today),
  ]);

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

  return {
    ruleConfig: await readParityRuleConfig(),
    board1n,
    board2n,
    board3n,
    board7n,
    competitors,
    requests: requestViews,
    latestGridAt: latestGrid?.capturedAt ? new Date(latestGrid.capturedAt).toISOString() : null,
  };
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

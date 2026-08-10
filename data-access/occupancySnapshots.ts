/**
 * Postgres repository for occupancy snapshots (Redis→Postgres migration).
 *
 * Row-level SQL — no whole-collection read/rewrite. Expiry is intentionally
 * NOT filtered here; the caller (utils/occupancySnapshotStore.ts) applies the
 * same lazy-prune semantics it uses for Redis so behaviour stays identical
 * across storage modes.
 */
import { desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { occupancySnapshots } from '@/lib/db/schema';
import type { OccupancySnapshot } from '@/types/occupancySnapshot';
import type { OccupancySnapshotRow } from '@/lib/db/schema/occupancySnapshots';

function toRow(s: OccupancySnapshot): OccupancySnapshotRow {
  return {
    token: s.token,
    createdAt: new Date(s.createdAt),
    createdBy: s.createdBy,
    expiresAt: s.expiresAt ? new Date(s.expiresAt) : null,
    data: s.data,
  };
}

function fromRow(r: OccupancySnapshotRow): OccupancySnapshot {
  return {
    token: r.token,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    data: r.data,
  };
}

export async function putSnapshotPg(snapshot: OccupancySnapshot): Promise<void> {
  const row = toRow(snapshot);
  const { token: _token, ...set } = row;
  await db
    .insert(occupancySnapshots)
    .values(row)
    .onConflictDoUpdate({ target: occupancySnapshots.token, set });
}

export async function getSnapshotPg(token: string): Promise<OccupancySnapshot | null> {
  const [row] = await db
    .select()
    .from(occupancySnapshots)
    .where(eq(occupancySnapshots.token, token))
    .limit(1);
  return row ? fromRow(row) : null;
}

export async function listSnapshotsPg(): Promise<OccupancySnapshot[]> {
  const rows = await db
    .select()
    .from(occupancySnapshots)
    .orderBy(desc(occupancySnapshots.createdAt));
  return rows.map(fromRow);
}

export async function deleteSnapshotPg(token: string): Promise<boolean> {
  const removed = await db
    .delete(occupancySnapshots)
    .where(eq(occupancySnapshots.token, token))
    .returning({ token: occupancySnapshots.token });
  return removed.length > 0;
}

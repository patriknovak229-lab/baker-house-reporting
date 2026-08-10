import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
// Type-only import (erased at build) — relative path so the drizzle-kit CLI
// bundler doesn't need tsconfig path-alias resolution.
import type { SnapshotData } from '../../../types/occupancySnapshot';

/**
 * Shareable occupancy snapshots — was Redis hash `baker:occupancy-snapshots`
 * (field = token). PII-free public share payloads. `expires_at` is a real
 * column so expiry can be a `WHERE expires_at > now()` query instead of the
 * lazy prune-on-read the Redis hash needed.
 */
export const occupancySnapshots = pgTable('occupancy_snapshots', {
  token: text('token').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  createdBy: text('created_by').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
  data: jsonb('data').$type<SnapshotData>().notNull(),
});

export type OccupancySnapshotRow = typeof occupancySnapshots.$inferSelect;
export type OccupancySnapshotInsert = typeof occupancySnapshots.$inferInsert;

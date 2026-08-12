/**
 * Postgres repository for the auto-reply audit logs (Redis→Postgres cutover).
 * Two independent append-only collections, each stored as full-entry jsonb so
 * the loosely-typed shapes survive verbatim:
 *   - auto_reply_log       PK = entry.id
 *   - auto_reply_edit_log  PK = sha256 content hash (source entries carry no id)
 *
 * `canonical`/`hashOf`/`toDate` are byte-identical to scripts/backfill+verify so
 * the edit-log content-hash PK matches on both the live write path and the
 * backfill. `fromRow` returns the stored jsonb blob unchanged (it IS the entry).
 *
 * listPg orders by the extracted timestamp ASC (oldest first). These logs are
 * capped at 500, and the writers evict by array position — the webhook does
 * `[...existing, new].slice(-500)` (keep last 500) and the draft does
 * `[new, ...log].slice(0, 500)`. A deterministic oldest-first read makes the
 * webhook's slice(-500) provably keep the newest 500 regardless of Postgres
 * physical page order (autovacuum can reshuffle heap order between the churny
 * delete-all+insert cycles), reproducing the dominant Redis array order. A bare
 * select (like emailSendLog) would be fine for an UNCAPPED log, but here the
 * eviction choice depends on order, so we pin it.
 */
import { asc } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db } from '@/lib/db';
import { autoReplyLog, autoReplyEditLog } from '@/lib/db/schema';

/** Canonical JSON with sorted object keys — MUST match backfill/verify so the
 *  edit-log hash is stable across write paths. */
function canonical(x: unknown): string {
  return JSON.stringify(x, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}
const hashOf = (x: unknown) => createHash('sha256').update(canonical(x)).digest('hex');
const toDate = (v: unknown): Date | null => (typeof v === 'string' && v ? new Date(v) : null);

// ── log (keyed by entry.id) ─────────────────────────────────────────────────
export async function listAutoReplyLogPg<T = Record<string, unknown>>(): Promise<T[]> {
  return (
    await db.select().from(autoReplyLog).orderBy(asc(autoReplyLog.decidedAt), asc(autoReplyLog.id))
  ).map((r) => r.entry as T);
}

export async function replaceAllAutoReplyLogPg(items: readonly { id: string }[]): Promise<void> {
  // Mirror the backfill: skip id-less entries, dedup by id last-wins.
  const byId = new Map<string, { id: string }>();
  for (const e of items) if (typeof e?.id === 'string' && e.id) byId.set(e.id, e);
  const rows = [...byId.values()].map((entry) => ({
    id: entry.id,
    decidedAt: toDate((entry as Record<string, unknown>).decidedAt),
    entry,
  }));
  if (rows.length === 0) {
    await db.delete(autoReplyLog);
    return;
  }
  await db.batch([db.delete(autoReplyLog), db.insert(autoReplyLog).values(rows)]);
}

// ── edit-log (keyed by content hash) ────────────────────────────────────────
export async function listAutoReplyEditLogPg<T = Record<string, unknown>>(): Promise<T[]> {
  return (
    await db
      .select()
      .from(autoReplyEditLog)
      .orderBy(asc(autoReplyEditLog.editedAt), asc(autoReplyEditLog.hash))
  ).map((r) => r.entry as T);
}

export async function replaceAllAutoReplyEditLogPg(items: readonly unknown[]): Promise<void> {
  // PK = content hash; dedup by hash last-wins (mirrors backfill/verify).
  const byHash = new Map<string, unknown>();
  for (const e of items) byHash.set(hashOf(e), e);
  const rows = [...byHash.entries()].map(([hash, entry]) => ({
    hash,
    editedAt: toDate((entry as Record<string, unknown>).editedAt),
    entry,
  }));
  if (rows.length === 0) {
    await db.delete(autoReplyEditLog);
    return;
  }
  await db.batch([db.delete(autoReplyEditLog), db.insert(autoReplyEditLog).values(rows)]);
}

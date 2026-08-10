/**
 * Persistence for occupancy snapshots.
 *
 * One Redis hash `baker:occupancy-snapshots`, field = opaque token →
 * JSON-encoded OccupancySnapshot. Expiry is enforced lazily on read
 * (and the stale field is pruned), mirroring the pending-drafts hash
 * pattern — Upstash hash fields can't carry their own TTL.
 *
 * Shared by the authed CRUD route, the public read route, and the public
 * share page so there is a single reader/writer of the store.
 *
 * Redis→Postgres migration: because this is the single reader/writer, it is
 * also the flag boundary. `STORE_OCCUPANCY_SNAPSHOTS` (see @/lib/dataStore)
 * selects redis | dual | postgres. The Postgres repository is imported
 * lazily so the default 'redis' path never loads the DB client, and the
 * lazy-expiry semantics below are applied identically in either store.
 */

import { Redis } from '@upstash/redis';
import type { OccupancySnapshot } from '@/types/occupancySnapshot';
import {
  readsFromPostgres,
  writesToPostgres,
  writesToRedis,
} from '@/lib/dataStore';

const KEY = 'baker:occupancy-snapshots';
const DOMAIN = 'occupancySnapshots' as const;

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

// Lazy — only loads @/lib/db (Neon client) when a Postgres path is actually taken.
function pg() {
  return import('@/data-access/occupancySnapshots');
}

function parse(raw: unknown): OccupancySnapshot | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as OccupancySnapshot;
    } catch {
      return null;
    }
  }
  // Upstash sometimes auto-parses JSON values.
  return raw as OccupancySnapshot;
}

function isExpired(s: OccupancySnapshot): boolean {
  if (!s.expiresAt) return false;
  const t = new Date(s.expiresAt).getTime();
  return Number.isFinite(t) && t <= Date.now();
}

/** Create or overwrite (regenerate reuses the same token). */
export async function putSnapshot(snapshot: OccupancySnapshot): Promise<void> {
  if (writesToRedis(DOMAIN)) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis not configured');
    await redis.hset(KEY, { [snapshot.token]: JSON.stringify(snapshot) });
  }
  if (writesToPostgres(DOMAIN)) {
    await (await pg()).putSnapshotPg(snapshot);
  }
}

/** Returns null when missing, malformed, or expired (expired ⇒ pruned). */
export async function getSnapshot(token: string): Promise<OccupancySnapshot | null> {
  if (readsFromPostgres(DOMAIN)) {
    const snap = await (await pg()).getSnapshotPg(token);
    if (!snap) return null;
    if (isExpired(snap)) {
      await (await pg()).deleteSnapshotPg(token).catch(() => null);
      return null;
    }
    return snap;
  }

  const redis = getRedis();
  if (!redis) return null;
  const snap = parse(await redis.hget<unknown>(KEY, token));
  if (!snap) return null;
  if (isExpired(snap)) {
    await redis.hdel(KEY, token).catch(() => null);
    return null;
  }
  return snap;
}

/** All live snapshots, newest first. Prunes any expired/malformed fields. */
export async function listSnapshots(): Promise<OccupancySnapshot[]> {
  if (readsFromPostgres(DOMAIN)) {
    const all = await (await pg()).listSnapshotsPg(); // ordered by createdAt desc
    const live: OccupancySnapshot[] = [];
    const stale: string[] = [];
    for (const snap of all) {
      if (isExpired(snap)) stale.push(snap.token);
      else live.push(snap);
    }
    if (stale.length > 0) {
      const { deleteSnapshotPg } = await pg();
      await Promise.all(stale.map((t) => deleteSnapshotPg(t).catch(() => null)));
    }
    return live;
  }

  const redis = getRedis();
  if (!redis) return [];
  const raw = (await redis.hgetall<Record<string, unknown>>(KEY)) ?? {};

  const stale: string[] = [];
  const live: OccupancySnapshot[] = [];
  for (const [field, val] of Object.entries(raw)) {
    const snap = parse(val);
    if (!snap || isExpired(snap)) {
      stale.push(field);
      continue;
    }
    live.push(snap);
  }
  if (stale.length > 0) {
    await redis.hdel(KEY, ...stale).catch(() => null);
  }

  live.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return live;
}

export async function deleteSnapshot(token: string): Promise<boolean> {
  let removed = false;
  if (writesToRedis(DOMAIN)) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis not configured');
    removed = (await redis.hdel(KEY, token)) > 0;
  }
  if (writesToPostgres(DOMAIN)) {
    const pgRemoved = await (await pg()).deleteSnapshotPg(token);
    removed = removed || pgRemoved;
  }
  return removed;
}

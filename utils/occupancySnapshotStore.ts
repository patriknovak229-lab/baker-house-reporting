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
 */

import { Redis } from '@upstash/redis';
import type { OccupancySnapshot } from '@/types/occupancySnapshot';

const KEY = 'baker:occupancy-snapshots';

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
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
  const redis = getRedis();
  if (!redis) throw new Error('Redis not configured');
  await redis.hset(KEY, { [snapshot.token]: JSON.stringify(snapshot) });
}

/** Returns null when missing, malformed, or expired (expired ⇒ pruned). */
export async function getSnapshot(token: string): Promise<OccupancySnapshot | null> {
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
  const redis = getRedis();
  if (!redis) throw new Error('Redis not configured');
  const removed = await redis.hdel(KEY, token);
  return removed > 0;
}

/**
 * One run at a time per cron job.
 *
 * Vercel says a scheduled run can occasionally be delivered more than once, and
 * the daily catch-up can now start a job too. For most jobs a second, OVERLAPPING
 * run is only wasted work, but send-due-invoices emails first and saves "Sent"
 * at the end, so two overlapping runs could email the same invoice twice.
 * Sequential re-runs are safe everywhere (each job re-checks its own state);
 * overlap is what this lock prevents.
 *
 * Redis SET NX with a TTL just past the route's maxDuration, so a run Vercel
 * kills at its limit can never leave the job locked for long. Released by
 * compare-and-delete, so a run never frees a lock that has since passed to
 * another run.
 *
 * Fails OPEN: if Redis is unreachable the job runs unlocked. A dead lock store
 * must not become a dead cron, which is the failure this whole family keeps
 * guarding against.
 */
import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

export interface CronLockClient {
  set(key: string, value: string, opts: { nx: true; ex: number }): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

export interface CronLock {
  release(): Promise<void>;
}

const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export const cronLockKey = (job: string) => `baker:cron-lock:${job}`;

function defaultClient(): CronLockClient | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token }) as unknown as CronLockClient;
}

const NOOP: CronLock = { release: async () => {} };

/** The lock, or null when another run of this job holds it. */
export async function acquireCronLock(
  job: string,
  ttlSeconds: number,
  client: CronLockClient | null = defaultClient(),
): Promise<CronLock | null> {
  if (!client) {
    console.warn(`[cron/${job}] no Redis configured — running without the overlap lock`);
    return NOOP;
  }
  const key = cronLockKey(job);
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const res = await client.set(key, token, { nx: true, ex: Math.max(1, Math.ceil(ttlSeconds)) });
    if (res === null || res === undefined) return null; // held by another run
  } catch (err) {
    console.error(`[cron/${job}] lock unavailable, running unlocked:`, err);
    return NOOP;
  }
  return {
    release: async () => {
      try {
        await client.eval(RELEASE_SCRIPT, [key], [token]);
      } catch (err) {
        console.error(`[cron/${job}] lock release failed (expires on its own):`, err);
      }
    },
  };
}

/**
 * Run `fn` holding the job's lock. A concurrent second run answers 200 with
 * `skipped` — a duplicate delivery is not an error — and writes no heartbeat,
 * so the run that holds the lock is the one that reports.
 */
export async function withCronLock(
  job: string,
  ttlSeconds: number,
  fn: () => Promise<Response>,
  client?: CronLockClient | null,
): Promise<Response> {
  const lock = await acquireCronLock(job, ttlSeconds, client === undefined ? defaultClient() : client);
  if (!lock) {
    console.warn(`[cron/${job}] another run is in progress — skipping this one`);
    return NextResponse.json({ ok: true, skipped: 'already running' });
  }
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

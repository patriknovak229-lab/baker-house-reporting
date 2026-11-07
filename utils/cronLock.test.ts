import { describe, it, expect } from 'vitest';
import { acquireCronLock, withCronLock, cronLockKey, type CronLockClient } from './cronLock';

/** In-memory stand-in for Upstash: SET NX + compare-and-delete. */
function fakeRedis() {
  const store = new Map<string, string>();
  const client: CronLockClient = {
    async set(key, value, opts) {
      if (opts.nx && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async eval(_script, keys, args) {
      if (store.get(keys[0]) === args[0]) {
        store.delete(keys[0]);
        return 1;
      }
      return 0;
    },
  };
  return { client, store };
}

describe('cron overlap lock', () => {
  it('a second run cannot take the lock while the first holds it', async () => {
    const { client } = fakeRedis();
    const first = await acquireCronLock('send-due-invoices', 90, client);
    expect(first).not.toBeNull();
    expect(await acquireCronLock('send-due-invoices', 90, client)).toBeNull();
    await first!.release();
    expect(await acquireCronLock('send-due-invoices', 90, client)).not.toBeNull();
  });

  it('a run never frees a lock that has passed to another run', async () => {
    const { client, store } = fakeRedis();
    const stale = await acquireCronLock('job', 90, client);
    store.set(cronLockKey('job'), 'someone-else'); // TTL expired, another run took it
    await stale!.release();
    expect(store.get(cronLockKey('job'))).toBe('someone-else');
  });

  it('fails open: no Redis, or Redis down, still runs the job', async () => {
    expect(await acquireCronLock('job', 90, null)).not.toBeNull();
    const broken: CronLockClient = {
      set: async () => { throw new Error('down'); },
      eval: async () => 0,
    };
    expect(await acquireCronLock('job', 90, broken)).not.toBeNull();
  });

  it('withCronLock: the overlapping run answers "already running" and does not run', async () => {
    const { client } = fakeRedis();
    let runs = 0;
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const first = withCronLock('job', 90, async () => { runs++; await gate; return new Response('ok'); }, client);
    const second = await withCronLock('job', 90, async () => { runs++; return new Response('ok'); }, client);
    expect(await second.json()).toEqual({ ok: true, skipped: 'already running' });
    releaseFirst();
    await first;
    expect(runs).toBe(1);
    // and the lock is free again afterwards
    const third = await withCronLock('job', 90, async () => { runs++; return new Response('ok'); }, client);
    expect(third.status).toBe(200);
    expect(runs).toBe(2);
  });
});

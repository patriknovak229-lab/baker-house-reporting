import { describe, expect, it } from 'vitest';
import type { Redis } from '@upstash/redis';
import { isOperatorActive, markAutoSent, markOperatorActive } from './operatorActivity';

function fakeRedis(): Redis {
  const store = new Map<string, unknown>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: unknown) => {
      store.set(k, v);
      return 'OK';
    },
  } as unknown as Redis;
}

const now = new Date('2026-10-05T12:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

describe('isOperatorActive', () => {
  it('pauses after an in-app operator send', async () => {
    const r = fakeRedis();
    expect(await isOperatorActive(r, 1, [], now)).toBe(false);
    await markOperatorActive(r, 1);
    expect(await isOperatorActive(r, 1, [], now)).toBe(true);
  });

  it('a recent host message we did not auto-send counts as the operator', async () => {
    const r = fakeRedis();
    const history = [{ role: 'host' as const, text: 'Fixed it', time: hoursAgo(2), id: 10 }];
    expect(await isOperatorActive(r, 2, history, now)).toBe(true);
  });

  it('our own automatic replies do not count', async () => {
    const r = fakeRedis();
    await markAutoSent(r, 11);
    const history = [{ role: 'host' as const, text: 'Auto', time: hoursAgo(1), id: 11 }];
    expect(await isOperatorActive(r, 3, history, now)).toBe(false);
  });

  it('host messages older than 24 h do not count', async () => {
    const r = fakeRedis();
    const history = [{ role: 'host' as const, text: 'Old', time: hoursAgo(25), id: 12 }];
    expect(await isOperatorActive(r, 4, history, now)).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { healthcheckPingTarget } from './healthcheckPing';

describe('healthcheckPingTarget', () => {
  it('pings the check URL on success and <url>/fail on failure', () => {
    const base = 'https://hc-ping.com/1f2e3d4c-0000-4000-8000-123456789abc';
    expect(healthcheckPingTarget(base, false)).toBe(base);
    expect(healthcheckPingTarget(base, true)).toBe(`${base}/fail`);
  });

  it('tolerates a pasted URL with a trailing slash or spaces', () => {
    expect(healthcheckPingTarget(' https://hc-ping.com/abc/ ', true)).toBe('https://hc-ping.com/abc/fail');
  });
});

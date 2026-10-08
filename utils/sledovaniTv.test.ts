import { describe, expect, it } from 'vitest';
import { parseTvLogins, tvLoginFor } from './sledovaniTv';

describe('sledovaniTv', () => {
  const raw = JSON.stringify({
    'K.102, K.103,K.106': { user: 'urban@example.com', pass: 'u-pass' },
    'O.308': { user: 'ott@example.com', pass: 'o-pass' },
    'K.201': { user: 'missing-pass@example.com' },
  });
  const logins = parseTvLogins(raw);

  it('expands comma-separated keys to every apartment', () => {
    expect(tvLoginFor('K.102', logins)).toEqual({ user: 'urban@example.com', pass: 'u-pass' });
    expect(tvLoginFor('K.103', logins)?.user).toBe('urban@example.com');
    expect(tvLoginFor('K.106', logins)?.user).toBe('urban@example.com');
    expect(tvLoginFor('O.308', logins)?.pass).toBe('o-pass');
  });

  it('matches with or without the dot', () => {
    expect(tvLoginFor('K106', logins)?.user).toBe('urban@example.com');
    expect(tvLoginFor('o308', logins)?.user).toBe('ott@example.com');
  });

  it('skips incomplete entries and unknown rooms', () => {
    expect(tvLoginFor('K.201', logins)).toBeNull();
    expect(tvLoginFor('K.999', logins)).toBeNull();
  });

  it('returns no logins for a missing or malformed env value', () => {
    expect(parseTvLogins(undefined).size).toBe(0);
    expect(parseTvLogins('').size).toBe(0);
    expect(parseTvLogins('not json').size).toBe(0);
    expect(parseTvLogins('[1,2]').size).toBe(0);
  });
});

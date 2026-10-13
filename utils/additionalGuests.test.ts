import { describe, it, expect } from 'vitest';
import {
  cleanGuestName,
  formatAdditionalGuestsMarker,
  normalizeAdditionalGuests,
  parseAdditionalGuests,
  MAX_ADDITIONAL_GUESTS,
} from './additionalGuests';

describe('additional guests marker', () => {
  it('round-trips names through the Beds24 comment', () => {
    const marker = formatAdditionalGuestsMarker(['Jana Nováková', 'Petr Novák']);
    expect(marker).toBe('[ADDITIONAL GUESTS: Jana Nováková; Petr Novák]');
    const comments = `[Created via Reporting App — Phone]\n${marker}\nLate arrival`;
    expect(parseAdditionalGuests(comments)).toEqual(['Jana Nováková', 'Petr Novák']);
  });

  it('writes nothing when there is nobody to add', () => {
    expect(formatAdditionalGuestsMarker([])).toBeNull();
    expect(formatAdditionalGuestsMarker(['  ', ''])).toBeNull();
    expect(formatAdditionalGuestsMarker(undefined)).toBeNull();
  });

  it('keeps a comma inside a name — only ; separates guests', () => {
    const marker = formatAdditionalGuestsMarker(['Novák, Jr.']);
    expect(parseAdditionalGuests(marker)).toEqual(['Novák, Jr.']);
  });

  it('strips characters that would break the marker', () => {
    expect(cleanGuestName('Jana ]Nová;ková[\n')).toBe('Jana Nová ková');
    const marker = formatAdditionalGuestsMarker(['A]B', 'C;D']);
    expect(parseAdditionalGuests(marker)).toEqual(['A B', 'C D']);
  });

  it('ignores non-strings and caps the list', () => {
    expect(normalizeAdditionalGuests(['Ann', 3, null, { a: 1 }, 'Bob'])).toEqual(['Ann', 'Bob']);
    const many = Array.from({ length: 50 }, (_, i) => `Guest ${i}`);
    expect(normalizeAdditionalGuests(many)).toHaveLength(MAX_ADDITIONAL_GUESTS);
    expect(normalizeAdditionalGuests('Ann')).toEqual([]);
  });

  it('reads a marker a person edited by hand in Beds24', () => {
    expect(parseAdditionalGuests('[additional guests:Jana  Nováková ;; Petr]')).toEqual([
      'Jana Nováková',
      'Petr',
    ]);
  });

  it('returns nothing for comments without the marker', () => {
    expect(parseAdditionalGuests('')).toEqual([]);
    expect(parseAdditionalGuests(null)).toEqual([]);
    expect(parseAdditionalGuests('[GROUP:pkg-1] guests: Jana')).toEqual([]);
  });
});

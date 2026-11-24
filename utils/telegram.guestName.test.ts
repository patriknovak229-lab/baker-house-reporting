import { describe, expect, it } from 'vitest';
import { guestNameLine } from './telegram';

describe('guestNameLine', () => {
  it('escapes characters that break Telegram HTML parsing', () => {
    expect(guestNameLine('Smith & Partners', '<s.r.o.>')).toBe(
      '👤 Smith &amp; Partners &lt;s.r.o.&gt;',
    );
  });

  it('shows a dash when the booking has no name', () => {
    expect(guestNameLine('', '')).toBe('👤 —');
    expect(guestNameLine(undefined, null)).toBe('👤 —');
  });

  it('keeps a single name without stray spaces', () => {
    expect(guestNameLine('Jana', '')).toBe('👤 Jana');
  });
});

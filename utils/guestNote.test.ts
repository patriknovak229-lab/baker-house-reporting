import { describe, it, expect } from 'vitest';
import { parseGuestNote, shouldBlinkGuestNote, isGuestNoteDismissed } from './guestNote';

// Synthetic notes only — this repo is public, never paste real guest text.
describe('parseGuestNote', () => {
  it('keeps a plain web-booking note, blank line included', () => {
    const notes = 'Dobrý den, přijedeme s malým dítětem. Prosíme o dětskou postýlku. \n\nJana Nováková';
    expect(parseGuestNote(notes)).toBe(
      'Dobrý den, přijedeme s malým dítětem. Prosíme o dětskou postýlku.\n\nJana Nováková',
    );
  });

  it('strips the WEB-GROUP order marker of a multi-apartment web order', () => {
    expect(parseGuestNote('WEB-GROUP-1700000000000-abcd1234 | Parking place needed')).toBe('Parking place needed');
  });

  it('returns nothing when the marker is the whole note', () => {
    expect(parseGuestNote('WEB-GROUP-1700000000000-abcd1234')).toBeNull();
  });

  it('drops the lines Beds24 appends itself', () => {
    const notes = [
      'Early check in please',
      'Booked 1KK Urban Studios - 679714',
      'Transferred from 1KK Urban Studios to K.103 at 09:03 - 28 May 2026',
      'Total Cancel Fee CZK',
      'Note: price less than room min price 3000.00',
      'Copy of Booking Id 12345678',
    ].join('\n');
    expect(parseGuestNote(notes)).toBe('Early check in please');
  });

  it('drops a line of several room moves written back to back', () => {
    const notes =
      'Transferred from K.203 to K.202 at 21:00 - 04 Apr 2026 Transferred from K.202 to K.203 at 21:05 - 04 Apr 2026';
    expect(parseGuestNote(notes)).toBeNull();
  });

  it('keeps a guest line that only mentions booking', () => {
    expect(parseGuestNote('Booked for my parents, they arrive late')).toBe('Booked for my parents, they arrive late');
  });

  it('handles empty input', () => {
    expect(parseGuestNote('')).toBeNull();
    expect(parseGuestNote(null)).toBeNull();
    expect(parseGuestNote(undefined)).toBeNull();
    expect(parseGuestNote('  \n \n')).toBeNull();
  });
});

describe('shouldBlinkGuestNote', () => {
  const today = '2026-11-12';
  const stay = (checkInDate: string, checkOutDate: string, isCancelled = false) => ({ checkInDate, checkOutDate, isCancelled });

  it('blinks for upcoming and in-house stays, check-out day included', () => {
    expect(shouldBlinkGuestNote(stay('2026-12-01', '2026-12-03'), today)).toBe(true);
    expect(shouldBlinkGuestNote(stay('2026-11-12', '2026-11-14'), today)).toBe(true);
    expect(shouldBlinkGuestNote(stay('2026-11-10', '2026-11-12'), today)).toBe(true);
  });

  it('stops for past stays and cancelled bookings', () => {
    expect(shouldBlinkGuestNote(stay('2026-11-09', '2026-11-11'), today)).toBe(false);
    expect(shouldBlinkGuestNote(stay('2026-12-01', '2026-12-03', true), today)).toBe(false);
  });
});

describe('isGuestNoteDismissed', () => {
  const dismissal = { text: 'Parking place needed', at: '2026-11-12T10:00:00Z' };

  it('is dismissed for the same text only', () => {
    expect(isGuestNoteDismissed({ guestNote: 'Parking place needed', guestNoteDismissed: dismissal })).toBe(true);
    expect(isGuestNoteDismissed({ guestNote: 'Parking for 2 cars please', guestNoteDismissed: dismissal })).toBe(false);
  });

  it('is not dismissed without a dismissal or a note', () => {
    expect(isGuestNoteDismissed({ guestNote: 'Parking place needed', guestNoteDismissed: null })).toBe(false);
    expect(isGuestNoteDismissed({ guestNote: 'Parking place needed' })).toBe(false);
    expect(isGuestNoteDismissed({ guestNote: undefined, guestNoteDismissed: dismissal })).toBe(false);
  });
});

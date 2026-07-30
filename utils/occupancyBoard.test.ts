import { describe, it, expect } from 'vitest';
import { horizonRange, resolveRange, computeBoard, rangeLabel, type OccupancyCache } from './occupancyBoard';

const HORIZON = horizonRange(new Date('2026-07-15T12:00:00Z'));

describe('horizonRange', () => {
  it('spans first-of-current-month → last day of +12 months', () => {
    expect(HORIZON).toEqual({ start: '2026-07-01', end: '2027-07-31' });
  });
});

describe('resolveRange', () => {
  it('passes a valid in-window range through', () => {
    expect(resolveRange('2026-08-01', '2026-08-31', HORIZON)).toEqual({ start: '2026-08-01', end: '2026-08-31' });
  });
  it('defaults to the current month when params are missing', () => {
    expect(resolveRange(null, null, HORIZON, new Date('2026-07-15T00:00:00Z'))).toEqual({
      start: '2026-07-01',
      end: '2026-07-31',
    });
  });
  it('clamps a past start up to the horizon start (no past periods)', () => {
    expect(resolveRange('2020-01-01', '2026-08-31', HORIZON)).toEqual({ start: '2026-07-01', end: '2026-08-31' });
  });
  it('rejects malformed dates', () => {
    expect(resolveRange('nope', '2026-08-31', HORIZON)).toHaveProperty('error');
  });
  it('rejects start after end', () => {
    expect(resolveRange('2026-09-01', '2026-08-01', HORIZON)).toHaveProperty('error');
  });
  it('rejects an over-long range (> 186 days)', () => {
    expect(resolveRange('2026-07-01', '2027-03-01', HORIZON)).toHaveProperty('error');
  });
});

describe('computeBoard', () => {
  const cache: OccupancyCache = {
    syncedAt: '2026-07-15T10:00:00Z',
    rooms: ['A', 'B'],
    dates: ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05'],
    perRoom: [
      { room: 'A', occupied: [true, true, false, false, false] },
      { room: 'B', occupied: [false, false, false, true, true] },
    ],
  };

  it('slices to the requested range and derives occupancy from the booleans', () => {
    const board = computeBoard(cache, '2026-08-02', '2026-08-04');
    expect(board.calendar.dates).toEqual(['2026-08-02', '2026-08-03', '2026-08-04']);
    expect(board.calendar.perRoom).toEqual([
      { room: 'A', occupied: [true, false, false] },
      { room: 'B', occupied: [false, false, true] },
    ]);
    // A: 1/3, B: 1/3
    expect(board.perRoom).toEqual([
      { room: 'A', soldNights: 1, availableNights: 3, occupancyPct: 33 },
      { room: 'B', soldNights: 1, availableNights: 3, occupancyPct: 33 },
    ]);
    // overall: 2 sold / (2 rooms * 3 nights) = 33%
    expect(board.overall).toEqual({ soldNights: 2, availableNights: 6, occupancyPct: 33 });
    expect(board.syncedAt).toBe('2026-07-15T10:00:00Z');
  });

  it('handles a single fully-occupied day', () => {
    const board = computeBoard(cache, '2026-08-04', '2026-08-04');
    expect(board.overall).toEqual({ soldNights: 1, availableNights: 2, occupancyPct: 50 });
  });
});

describe('rangeLabel', () => {
  it('names a full calendar month', () => {
    expect(rangeLabel('2026-08-01', '2026-08-31')).toBe('August 2026');
  });
  it('shows a date span for an arbitrary range', () => {
    expect(rangeLabel('2026-08-05', '2026-09-10')).toBe('5 Aug 2026 – 10 Sep 2026');
  });
});

import { describe, expect, it } from 'vitest';
import { isOtaSupplier, NOT_OTA_SENDERS_QUERY, OTA_SENDERS_QUERY } from './otaSupplier';

describe('isOtaSupplier', () => {
  it('recognises Booking.com and Airbnb by name or Booking VAT id', () => {
    expect(isOtaSupplier('Booking.com B.V.')).toBe(true);
    expect(isOtaSupplier('BOOKING COM')).toBe(true);
    expect(isOtaSupplier('Airbnb Ireland UC')).toBe(true);
    expect(isOtaSupplier('Unknown', 'NL 805734958 B01')).toBe(true);
  });
  it('leaves other suppliers alone', () => {
    expect(isOtaSupplier('Alza.cz a.s.', '27082440')).toBe(false);
    expect(isOtaSupplier(null, null)).toBe(false);
  });
});

describe('Gmail sender queries', () => {
  it('match and exclude both OTA domains', () => {
    expect(OTA_SENDERS_QUERY).toBe('{from:booking.com from:airbnb.com}');
    expect(NOT_OTA_SENDERS_QUERY).toBe('-from:booking.com -from:airbnb.com');
  });
});

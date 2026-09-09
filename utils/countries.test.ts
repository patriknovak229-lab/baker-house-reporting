import { describe, it, expect } from 'vitest';
import { COUNTRY_OPTIONS, isValidCountryCode, countryToLang, languageNameForCountry } from './countries';

describe('country list', () => {
  it('has unique, well-formed ISO alpha-2 codes', () => {
    const codes = COUNTRY_OPTIONS.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((c) => /^[A-Z]{2}$/.test(c))).toBe(true);
    expect(COUNTRY_OPTIONS.every((c) => c.name.length > 0)).toBe(true);
  });

  it('is sorted by display name, so the dropdown reads alphabetically', () => {
    const names = COUNTRY_OPTIONS.map((c) => c.name);
    expect([...names].sort((a, b) => a.localeCompare(b, 'en'))).toEqual(names);
  });

  it('validates codes case-insensitively and rejects junk', () => {
    expect(isValidCountryCode('cz')).toBe(true);
    expect(isValidCountryCode(' DE ')).toBe(true);
    expect(isValidCountryCode('XX')).toBe(false);
    expect(isValidCountryCode('')).toBe(false);
    expect(isValidCountryCode('CZE')).toBe(false);
  });
});

describe('countryToLang', () => {
  // These four are the property's real source markets — a wrong mapping here
  // sends the Beds24 auto-action out in the wrong language.
  it('maps the core markets', () => {
    expect(countryToLang('CZ')).toBe('cs');
    expect(countryToLang('SK')).toBe('sk');
    expect(countryToLang('DE')).toBe('de');
    expect(countryToLang('AT')).toBe('de');
  });

  it('falls back to English for unmapped or unknown countries', () => {
    expect(countryToLang('JP')).toBe('en');
    expect(countryToLang('XX')).toBe('en');
  });

  it('accepts lowercase and padded input', () => {
    expect(countryToLang(' pl ')).toBe('pl');
  });

  it('names the language for the operator-facing hint', () => {
    expect(languageNameForCountry('CZ')).toBe('Czech');
    expect(languageNameForCountry('US')).toBe('English');
  });
});

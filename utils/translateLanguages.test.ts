import { describe, it, expect } from 'vitest';
import {
  COMMON_LANGUAGES,
  OTHER_LANGUAGES,
  canonicalLanguageCode,
  translateLanguageName,
} from './translateLanguages';

describe('translate language lists', () => {
  it('never lists a language twice, across both groups', () => {
    const codes = [...COMMON_LANGUAGES, ...OTHER_LANGUAGES].map((l) => l.code.toLowerCase());
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('sorts the "other" group by name, so the dropdown reads alphabetically', () => {
    const names = OTHER_LANGUAGES.map((l) => l.name);
    expect([...names].sort((a, b) => a.localeCompare(b, 'en'))).toEqual(names);
  });

  it('offers both languages the operator writes in', () => {
    const common = COMMON_LANGUAGES.map((l) => l.code);
    expect(common).toContain('cs');
    expect(common).toContain('en');
  });
});

describe('canonicalLanguageCode', () => {
  // Google still reports some legacy codes as detectedSourceLanguage; without
  // the alias a Hebrew message typed into a Hebrew target would not be
  // recognised as "already in the target language".
  it("maps Google's legacy and regional codes onto the list's code", () => {
    expect(canonicalLanguageCode('iw')).toBe('he');
    expect(canonicalLanguageCode('zh')).toBe('zh-CN');
    expect(canonicalLanguageCode('fil')).toBe('tl');
    expect(canonicalLanguageCode('pt-BR')).toBe('pt');
  });

  it('matches case-insensitively and leaves known codes alone', () => {
    expect(canonicalLanguageCode('zh-cn')).toBe('zh-CN');
    expect(canonicalLanguageCode(' CS ')).toBe('cs');
    expect(canonicalLanguageCode('de')).toBe('de');
  });

  it('lower-cases unknown codes so two unknowns still compare equal', () => {
    expect(canonicalLanguageCode('XH')).toBe('xh');
  });
});

describe('translateLanguageName', () => {
  it('names listed languages, including through an alias', () => {
    expect(translateLanguageName('cs')).toBe('Czech');
    expect(translateLanguageName('zh-TW')).toBe('Chinese (Traditional)');
    expect(translateLanguageName('iw')).toBe('Hebrew');
  });

  it('falls back to the upper-cased code for anything unlisted', () => {
    expect(translateLanguageName('xh')).toBe('XH');
  });
});

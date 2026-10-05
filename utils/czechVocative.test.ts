import { describe, expect, it } from 'vitest';
import { czechGreetingLine, czechVocative, repliesInCzech } from './czechVocative';

describe('czechVocative', () => {
  it.each([
    ['Ivan', 'Ivane'],
    ['Zuzana', 'Zuzano'],
    ['Jana', 'Jano'],
    ['Andrea', 'Andreo'],
    ['Petr', 'Petře'],
    ['Pavel', 'Pavle'],
    ['Karel', 'Karle'],
    ['Daniel', 'Danieli'],
    ['Michael', 'Michaeli'],
    ['Michal', 'Michale'],
    ['Marek', 'Marku'],
    ['Radek', 'Radku'],
    ['Zdeněk', 'Zdeňku'],
    ['Zdenek', 'Zdenku'],
    ['Patrik', 'Patriku'],
    ['Vojtěch', 'Vojtěchu'],
    ['Tomáš', 'Tomáši'],
    ['Tomas', 'Tomasi'],
    ['Lukáš', 'Lukáši'],
    ['Ondřej', 'Ondřeji'],
    ['Jan', 'Jane'],
    ['Martin', 'Martine'],
    ['Josef', 'Josefe'],
    ['Jakub', 'Jakube'],
    ['Igor', 'Igore'],
    ['Libor', 'Libore'],
    ['Jiří', 'Jiří'],
    ['Jiri', 'Jiri'],
    ['Marie', 'Marie'],
    ['Lucie', 'Lucie'],
    ['Ivo', 'Ivo'],
    ['Dagmar', 'Dagmar'],
    ['Ingrid', 'Ingrid'],
    ['IVAN', 'IVANE'],
    ['Jan Pavel', 'Jane Pavle'],
    ['Anna-Marie', 'Anno-Marie'],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(czechVocative(input)).toBe(expected);
  });

  it('a feminine surname stops a consonant-ending first name inflecting', () => {
    expect(czechVocative('Rachel', 'Nováková')).toBe('Rachel');
    expect(czechVocative('Karin', 'Novakova')).toBe('Karin');
    expect(czechVocative('Ivan', 'Teply')).toBe('Ivane');
  });
});

describe('czechGreetingLine', () => {
  it('is formal and uses the vocative', () => {
    expect(czechGreetingLine('Ivan', 'Teply')).toBe('Dobrý den Ivane,');
    expect(czechGreetingLine('Zuzana', 'Novakova')).toBe('Dobrý den Zuzano,');
    expect(czechGreetingLine('')).toBe('Dobrý den,');
  });
});

describe('repliesInCzech', () => {
  it('follows the reply language first, nationality only as fallback', () => {
    expect(repliesInCzech('cs', 'DE')).toBe(true);
    expect(repliesInCzech('en', 'CZ')).toBe(false);
    expect(repliesInCzech('sk', 'SK')).toBe(false);
    expect(repliesInCzech('', 'CZ')).toBe(true);
    expect(repliesInCzech(undefined, 'GB')).toBe(false);
  });
});

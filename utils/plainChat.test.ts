import { describe, it, expect } from 'vitest';
import { toPlainChat } from './plainChat';

describe('toPlainChat', () => {
  it('strips bold and headings, keeps bullets', () => {
    expect(toPlainChat('místo č. **153**, od **13:00**')).toBe('místo č. 153, od 13:00');
    expect(toPlainChat('## Parkování\n- čip na recepci')).toBe('Parkování\n- čip na recepci');
    expect(toPlainChat('__pozor__ brána')).toBe('pozor brána');
  });

  it('leaves normal text alone', () => {
    expect(toPlainChat('hotel 4* a 5 % sleva, SPZ 1B1 234')).toBe('hotel 4* a 5 % sleva, SPZ 1B1 234');
    expect(toPlainChat('Telefon: #1 recepce')).toBe('Telefon: #1 recepce');
  });
});

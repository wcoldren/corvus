import { describe, expect, it } from 'vitest';
import { ERRORS_KEY, MAX_ERRORS, readErrors, recordError } from './errors.ts';

function memoryStore(): Pick<Storage, 'getItem' | 'setItem'> {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

describe('error log', () => {
  it('keeps the newest errors first, at most MAX_ERRORS', () => {
    const s = memoryStore();
    for (let i = 0; i < MAX_ERRORS + 5; i++) recordError(new Error(`e${i}`), i, s);
    const list = readErrors(s);
    expect(list).toHaveLength(MAX_ERRORS);
    expect(list[0]!.message).toBe(`Error: e${MAX_ERRORS + 4}`);
    expect(list[0]!.ts).toBe(MAX_ERRORS + 4);
  });

  it('records non-Error values and survives a corrupt or missing store', () => {
    const s = memoryStore();
    s.setItem(ERRORS_KEY, '{not json');
    expect(readErrors(s)).toEqual([]);
    recordError('plain text', 1, s);
    expect(readErrors(s)).toEqual([{ ts: 1, message: 'plain text', stack: null }]);
    expect(() => recordError(new Error('x'), 1, null)).not.toThrow();
    const full = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(() => recordError(new Error('x'), 1, full)).not.toThrow();
  });
});

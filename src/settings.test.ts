import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, withDefaults } from './settings.ts';

describe('withDefaults', () => {
  it('gives the defaults when nothing is stored', () => {
    expect(withDefaults(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(withDefaults(null)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({ rolloverHour: 4, goalMin: 20, maxNew: 25, learnAheadMin: 20 });
  });

  it('keeps stored values in range and drops the rest', () => {
    expect(withDefaults({ maxNew: 10, rolloverHour: 30, goalMin: '15', learnAheadMin: 2.5, other: 1 })).toEqual({
      ...DEFAULT_SETTINGS,
      maxNew: 10,
    });
    expect(withDefaults({ rolloverHour: 0, maxNew: 0 })).toMatchObject({ rolloverHour: 0, maxNew: 0 });
  });
});

import { describe, expect, it } from 'vitest';
import { dateDiffInDays, default_w, fsrs } from 'ts-fsrs';
import {
  DEFAULT_PARAMS,
  elapsedDays,
  fsrsParameters,
  makeParams,
  review,
  type CardState,
  type Rating,
} from './scheduler.ts';
import { shiftMin } from './day.ts';
import { wall, zone } from './testing/zones.ts';

const MIN = 60_000;
const DAY = 86_400_000;
const R = 4;
const ny = zone('America/New_York');
const kolkata = zone('Asia/Kolkata');

/** Review at a wall-clock time in a zone, with that instant's shift. */
function at(z: typeof ny, text: string, before: CardState | null, rating: Rating, params = DEFAULT_PARAMS) {
  const ts = wall(z, text);
  return review(params, before, rating, ts, shiftMin(ts, R, z));
}

describe('the pinned config', () => {
  // SPEC.md, The scheduler: this table, and nothing left to library defaults.
  it('matches the spec table', () => {
    const { id, w, ...rest } = DEFAULT_PARAMS;
    expect(rest).toEqual({
      lib: 'ts-fsrs@5.4.2',
      model: 'FSRS-6',
      retention: 0.9,
      fuzz: true,
      shortTerm: true,
      learningSteps: ['10m'],
      relearningSteps: ['10m'],
      maxInterval: 36500,
    });
    expect(w).toEqual([...default_w]);
    expect(w).toHaveLength(21);
    expect(id).toMatch(/^p-[0-9a-f]{14}$/);
  });

  it('is what ts-fsrs actually runs with', () => {
    const p = fsrs(fsrsParameters(DEFAULT_PARAMS)).parameters;
    expect(p.request_retention).toBe(0.9);
    expect(p.maximum_interval).toBe(36500);
    expect(p.enable_fuzz).toBe(true);
    expect(p.enable_short_term).toBe(true);
    expect([...p.learning_steps]).toEqual(['10m']);
    expect([...p.relearning_steps]).toEqual(['10m']);
    expect([...p.w]).toEqual([...default_w]);
  });

  it('gives an identical config the same id, and a changed one a new id', () => {
    expect(makeParams().id).toBe(DEFAULT_PARAMS.id);
    expect(makeParams({ retention: 0.9 }).id).toBe(DEFAULT_PARAMS.id);
    expect(makeParams({ retention: 0.85 }).id).not.toBe(DEFAULT_PARAMS.id);
  });

  it('allows desired retention from 0.80 to 0.95 only', () => {
    expect(makeParams({ retention: 0.8 }).retention).toBe(0.8);
    expect(makeParams({ retention: 0.95 }).retention).toBe(0.95);
    expect(() => makeParams({ retention: 0.79 })).toThrow(RangeError);
    expect(() => makeParams({ retention: 0.96 })).toThrow(RangeError);
    expect(() => makeParams({ retention: NaN })).toThrow(RangeError);
  });
});

describe('single-step graduation', () => {
  const t0 = Date.parse('2026-06-10T14:00:00Z');
  const s0 = shiftMin(t0, R, ny);

  it('graduates a new card on Good, straight to review', () => {
    const s = review(DEFAULT_PARAMS, null, 3, t0, s0);
    expect(s.phase).toBe('review');
    expect(s.scheduledDays).toBeGreaterThanOrEqual(1);
    expect(s.due).toBe(t0 + s.scheduledDays * DAY);
    expect(s.lastReview).toBe(t0);
    expect(s.reps).toBe(1);
  });

  it('graduates a new card on Easy too', () => {
    expect(review(DEFAULT_PARAMS, null, 4, t0, s0).phase).toBe('review');
  });

  it('brings a new card back in 10 minutes on Again, and graduates it on Good then', () => {
    const failed = review(DEFAULT_PARAMS, null, 1, t0, s0);
    expect(failed.phase).toBe('learning');
    expect(failed.due).toBe(t0 + 10 * MIN);
    const passed = review(DEFAULT_PARAMS, failed, 3, failed.due, s0);
    expect(passed.phase).toBe('review');
    expect(passed.reps).toBe(2);
  });

  it('relearns a lapsed card in one 10-minute step', () => {
    const learned = review(DEFAULT_PARAMS, null, 3, t0, s0);
    const t1 = learned.due;
    const lapsed = review(DEFAULT_PARAMS, learned, 1, t1, shiftMin(t1, R, ny));
    expect(lapsed.phase).toBe('relearning');
    expect(lapsed.lapses).toBe(1);
    expect(lapsed.due).toBe(t1 + 10 * MIN);
    expect(review(DEFAULT_PARAMS, lapsed, 3, lapsed.due, shiftMin(t1, R, ny)).phase).toBe('review');
  });

  it('keeps stored times real whatever the shift', () => {
    for (const shift of [-480, -240, 0, 90, 330]) {
      const s = review(DEFAULT_PARAMS, null, 1, t0, shift);
      expect(s.due).toBe(t0 + 10 * MIN);
      expect(s.lastReview).toBe(t0);
    }
  });
});

describe('the day boundary', () => {
  it('counts a 21:00 review checked at 08:00 the next day as one day', () => {
    const t1 = wall(ny, '2026-06-10T21:00');
    const t2 = wall(ny, '2026-06-11T08:00');
    expect(elapsedDays(t1, t2, shiftMin(t2, R, ny))).toBe(1);
    // ts-fsrs alone would see the same UTC date (01:00 and 12:00 UTC).
    expect(dateDiffInDays(new Date(t1), new Date(t2))).toBe(0);
  });

  it('counts a session across 04:00 as two days', () => {
    const t1 = wall(ny, '2026-06-11T03:50');
    const t2 = wall(ny, '2026-06-11T04:10');
    expect(elapsedDays(t1, t2, shiftMin(t2, R, ny))).toBe(1);
  });

  it('counts reviews either side of UTC midnight on one study day as the same day', () => {
    // New York 19:30 and 20:30 are 23:30 and 00:30 UTC.
    const a = wall(ny, '2026-06-10T19:30');
    const b = wall(ny, '2026-06-10T20:30');
    expect(elapsedDays(a, b, shiftMin(b, R, ny))).toBe(0);
    expect(dateDiffInDays(new Date(a), new Date(b))).toBe(1);
    // Kolkata's UTC midnight is 05:30, after the rollover.
    const c = wall(kolkata, '2026-06-10T05:00');
    const d = wall(kolkata, '2026-06-10T06:00');
    expect(elapsedDays(c, d, shiftMin(d, R, kolkata))).toBe(0);
    expect(dateDiffInDays(new Date(c), new Date(d))).toBe(1);
  });

  it('counts one day across a DST change, spring and fall', () => {
    for (const [from, to] of [
      ['2026-03-07T21:00', '2026-03-08T08:00'],
      ['2026-10-31T21:00', '2026-11-01T08:00'],
      ['2026-03-07T12:00', '2026-03-08T12:00'],
      ['2026-10-31T12:00', '2026-11-01T12:00'],
    ] as const) {
      const t2 = wall(ny, to);
      expect(elapsedDays(wall(ny, from), t2, shiftMin(t2, R, ny))).toBe(1);
    }
  });

  it('feeds the shifted day count to ts-fsrs', () => {
    // The same two reviews, 21:00 and 08:00 the next morning: with the shift
    // the second is a next-day review, without it a same-day one, and FSRS
    // treats those differently.
    const first = at(ny, '2026-06-10T21:00', null, 3);
    const t2 = wall(ny, '2026-06-11T08:00');
    const shifted = review(DEFAULT_PARAMS, first, 3, t2, shiftMin(t2, R, ny));
    const unshifted = review(DEFAULT_PARAMS, first, 3, t2, 0);
    expect(shifted.stability).not.toBe(unshifted.stability);
  });
});

describe('replay', () => {
  it('gives the same state for the same arguments, fuzz included', () => {
    const t0 = wall(ny, '2026-06-10T09:00');
    const s0 = shiftMin(t0, R, ny);
    const run = () => {
      let s = review(DEFAULT_PARAMS, null, 3, t0, s0);
      for (const rating of [3, 3, 2, 1, 3, 4] as Rating[]) s = review(DEFAULT_PARAMS, s, rating, s.due, s0);
      return s;
    };
    expect(run()).toEqual(run());
  });

  it('fuzzes intervals', () => {
    // A mature card reviewed Good at different times gets more than one interval.
    const mature: CardState = {
      phase: 'review',
      due: Date.parse('2026-06-10T12:00:00Z'),
      lastReview: Date.parse('2026-05-11T12:00:00Z'),
      stability: 30,
      difficulty: 5,
      scheduledDays: 30,
      learningSteps: 0,
      reps: 5,
      lapses: 0,
    };
    const intervals = new Set<number>();
    for (let i = 0; i < 20; i++) intervals.add(review(DEFAULT_PARAMS, mature, 3, mature.due + i * MIN, -240).scheduledDays);
    expect(intervals.size).toBeGreaterThan(1);
  });
});

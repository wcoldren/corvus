import { describe, expect, it } from 'vitest';
import { cards, packs } from '../cards/bundle.ts';
import type { Card } from '../cards/types.ts';
import { buildFormIndex } from '../check/answer.ts';
import { DEFAULT_PARAMS, review } from '../scheduler.ts';
import { formatInterval, previewIntervals } from './intervals.ts';
import { Stopwatch, Turn } from './turn.ts';

const la = packs['la']!;
const opts = { ignoreWords: la.learner.ignoreWords, forms: buildFormIndex(cards) };
const card = (id: string): Card => cards.find((c) => c.id === id)!;
const T0 = 1_780_000_000_000;

describe('Stopwatch', () => {
  it('stops counting while paused, and ignores a repeated pause or resume', () => {
    const w = new Stopwatch(T0);
    w.pause(T0 + 1000);
    w.pause(T0 + 5000);
    expect(w.elapsed(T0 + 60_000)).toBe(1000);
    w.resume(T0 + 61_000);
    w.resume(T0 + 70_000);
    expect(w.elapsed(T0 + 63_000)).toBe(3000);
  });
});

describe('Turn', () => {
  it('grades a typed answer and suggests from the verdict', () => {
    const t = new Turn(card('la-02-e-aqua-abl-sg'), T0);
    expect(t.submit('aqua', opts, T0 + 4000).kind).toBe('wrongForm');
    expect(t.suggested).toBe(1);
    expect(t.answer(1, T0 + 9000)).toEqual({
      rating: 1,
      suggested: 1,
      mode: 'typed',
      response: 'aqua',
      outcome: 'wrongForm',
      hintShown: false,
      answerMs: 4000,
      totalMs: 9000,
    });
  });

  it('suggests Good for a slip, and caps it at Hard after the hint', () => {
    const slip = new Turn(card('la-02-e-anima-gen-pl'), T0);
    expect(slip.submit('animarum', opts, T0).kind).toBe('slip');
    expect(slip.suggested).toBe(3);
    const hinted = new Turn(card('la-02-e-anima-gen-pl'), T0);
    hinted.showHint();
    hinted.submit('animārum', opts, T0);
    expect(hinted.suggested).toBe(2);
    expect(hinted.answer(2, T0).hintShown).toBe(true);
  });

  it('logs an empty answer as wrong', () => {
    const t = new Turn(card('la-02-e-aqua-abl-sg'), T0);
    t.submit('  ', opts, T0);
    expect(t.outcome).toBe('wrong');
    expect(t.suggested).toBe(1);
  });

  it('reveals a self-graded card with no suggestion and no response', () => {
    const t = new Turn(card('la-02-v-aqua'), T0);
    t.reveal(T0 + 2000);
    expect(t.answer(3, T0 + 5000)).toMatchObject({
      suggested: null,
      response: null,
      outcome: 'revealed',
      mode: 'reveal',
      answerMs: 2000,
      totalMs: 5000,
    });
  });

  it('refuses to answer twice or rate before answering, and ignores a hint after answering', () => {
    const t = new Turn(card('la-02-v-aqua'), T0);
    expect(() => t.answer(3, T0)).toThrow();
    t.reveal(T0);
    expect(() => t.reveal(T0)).toThrow();
    t.showHint();
    expect(t.hintShown).toBe(false);
  });

  it('leaves time spent hidden out of both times', () => {
    const t = new Turn(card('la-02-v-aqua'), T0);
    t.watch.pause(T0 + 1000);
    t.watch.resume(T0 + 600_000);
    t.reveal(T0 + 601_000);
    expect(t.answer(3, T0 + 602_000)).toMatchObject({ answerMs: 2000, totalMs: 3000 });
  });
});

describe('intervals', () => {
  it('previews exactly what rating gives', () => {
    const shift = -480;
    const preview = previewIntervals(DEFAULT_PARAMS, null, T0, shift);
    expect(preview[1]).toBe(10 * 60_000);
    for (const r of [1, 2, 3, 4] as const) expect(preview[r]).toBe(review(DEFAULT_PARAMS, null, r, T0, shift).due - T0);
    // From a review state, too, where the clamp and the fuzz come into play.
    const before = review(DEFAULT_PARAMS, null, 3, T0, shift);
    const later = T0 + 3 * 86_400_000;
    const p2 = previewIntervals(DEFAULT_PARAMS, before, later, shift);
    expect(p2[3]).toBe(review(DEFAULT_PARAMS, before, 3, later, shift).due - later);
    expect(p2[1]).toBeLessThan(p2[2]);
    expect(p2[3]).toBeLessThan(p2[4]);
  });

  it('formats intervals briefly', () => {
    expect(formatInterval(10 * 60_000)).toBe('10 min');
    expect(formatInterval(20_000)).toBe('1 min');
    expect(formatInterval(5 * 3_600_000)).toBe('5 h');
    expect(formatInterval(3 * 86_400_000)).toBe('3 d');
    expect(formatInterval(120 * 86_400_000)).toBe('4 mo');
    expect(formatInterval(548 * 86_400_000)).toBe('1.5 y');
  });
});

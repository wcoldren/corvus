import { describe, expect, it } from 'vitest';
import { loadCards } from './cards/load.ts';
import type { CardFile, CardJson } from './cards/types.ts';
import { shiftMin } from './day.ts';
import type { DailyCounts } from './log.ts';
import { buildQueue, NEW_EVERY, REVIEW_CAP, Session, type QueueInput } from './queue.ts';
import { DEFAULT_PARAMS, review, type CardState, type Phase } from './scheduler.ts';
import { DEFAULT_SETTINGS } from './settings.ts';
import { wall, zone } from './testing/zones.ts';

const ny = zone('America/New_York');
const MIN = 60_000;
const DAY = 86_400_000;
const at = (text: string) => wall(ny, text);

const vocab = (id: string, extra: Partial<CardJson> = {}): CardJson => ({
  id,
  type: 'vocab',
  lemma: 'lemma-' + id,
  prompt: 'prompt-' + id,
  answer: 'answer-' + id,
  ...extra,
});
const file = (lesson: number, cards: CardJson[]): CardFile => ({ language: 'xx', lesson, unit: 1, title: `L${lesson}`, cards });
/** `n` plain vocab cards in lesson `lesson`, with ids `<prefix>0`, `<prefix>1`, ... */
const many = (lesson: number, prefix: string, n: number) =>
  file(lesson, Array.from({ length: n }, (_, i) => vocab(prefix + i)));

function state(phase: Phase, due: number, lastReview = due - DAY): CardState {
  return { phase, due, lastReview, stability: 3, difficulty: 5, scheduledDays: 1, learningSteps: 0, reps: 1, lapses: 0 };
}

const NOW = at('2026-06-10T09:00');
const zero: DailyCounts = { reviews: 0, newCards: 0, steps: 0, totalMs: 0 };

function input(over: Partial<QueueInput> & Pick<QueueInput, 'cards'>): QueueInput {
  return {
    states: new Map(),
    today: zero,
    unlocked: { xx: 99 },
    settings: DEFAULT_SETTINGS,
    now: NOW,
    zone: ny,
    ...over,
  };
}

describe('buildQueue: new cards', () => {
  it('takes new cards only from unlocked lessons, in lesson order then file order', () => {
    const cards = loadCards([file(2, [vocab('c')]), file(1, [vocab('a'), vocab('b')]), file(3, [vocab('d')])]);
    const plan = buildQueue(input({ cards, unlocked: { xx: 2 } }));
    expect(plan.entries).toEqual([
      { id: 'a', due: null },
      { id: 'b', due: null },
      { id: 'c', due: null },
    ]);
    expect(plan.newCards).toBe(3);
  });

  it('introduces nothing before the first unlock, or for another language', () => {
    const cards = loadCards([file(1, [vocab('a')])]);
    expect(buildQueue(input({ cards, unlocked: {} })).entries).toEqual([]);
    expect(buildQueue(input({ cards, unlocked: { la: 5 } })).entries).toEqual([]);
  });

  it('holds out parse cards, reverse cards and retired cards', () => {
    const cards = loadCards([
      file(1, [
        vocab('a', { reverse: true }),
        { id: 'p', type: 'parse', lemma: 'x', prompt: 'x', answer: ['nom.sg'] },
        vocab('r', { retired: true }),
        vocab('b'),
      ]),
    ]);
    expect(buildQueue(input({ cards })).entries.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('stops at maxNew, counting new cards already introduced today', () => {
    const cards = loadCards([many(1, 'n', 40)]);
    expect(buildQueue(input({ cards })).newCards).toBe(DEFAULT_SETTINGS.maxNew);
    const plan = buildQueue(input({ cards, today: { ...zero, newCards: 20 } }));
    expect(plan.entries.map((e) => e.id)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
    expect(buildQueue(input({ cards, today: { ...zero, newCards: 30 } })).newCards).toBe(0);
    expect(buildQueue(input({ cards, settings: { ...DEFAULT_SETTINGS, maxNew: 0 } })).newCards).toBe(0);
  });
});

describe('buildQueue: reviews', () => {
  const cards = loadCards([file(1, [vocab('a'), vocab('b'), vocab('c'), vocab('d'), vocab('e')])]);

  it('takes review cards due before the next 04:00 rollover, in due order', () => {
    const states = new Map([
      ['a', state('review', at('2026-06-10T00:00'))],
      ['b', state('review', at('2026-06-09T00:00'))],
      // Later today, but before the rollover: due today.
      ['c', state('review', at('2026-06-11T03:59'))],
      // At the rollover: tomorrow's.
      ['d', state('review', at('2026-06-11T04:00'))],
    ]);
    const plan = buildQueue(input({ cards, states }));
    expect(plan.entries.filter((e) => e.due !== null).map((e) => e.id)).toEqual(['b', 'a', 'c']);
    expect(plan.reviews).toBe(3);
    expect(plan.studyDay).toBe('2026-06-10');
  });

  it('breaks due-time ties by introduction order', () => {
    const due = at('2026-06-10T00:00');
    const states = new Map(['e', 'c', 'a'].map((id) => [id, state('review', due)]));
    expect(buildQueue(input({ cards, states })).entries.map((e) => e.id).slice(0, 3)).toEqual(['a', 'c', 'e']);
  });

  it('counts the day from the rollover: at 03:30 it is still yesterday', () => {
    const now = at('2026-06-11T03:30');
    const states = new Map([['a', state('review', at('2026-06-11T03:59'))], ['b', state('review', at('2026-06-11T05:00'))]]);
    const plan = buildQueue(input({ cards, states, now }));
    expect(plan.studyDay).toBe('2026-06-10');
    expect(plan.entries.filter((e) => e.due !== null).map((e) => e.id)).toEqual(['a']);
  });

  it('leaves out retired cards with history, and states for cards no longer deployed', () => {
    const withRetired = loadCards([file(1, [vocab('a', { retired: true }), vocab('b')])]);
    const states = new Map([
      ['a', state('review', at('2026-06-10T00:00'))],
      ['b', state('review', at('2026-06-10T00:00'))],
      ['gone', state('review', at('2026-06-10T00:00'))],
    ]);
    expect(buildQueue(input({ cards: withRetired, states })).entries.map((e) => e.id)).toEqual(['b']);
  });

  it('leaves learning cards to the session, which shows them by due time', () => {
    const states = new Map([['a', state('learning', NOW - 5 * MIN, NOW - 15 * MIN)]]);
    const plan = buildQueue(input({ cards, states, unlocked: {} }));
    expect(plan.entries).toEqual([]);
    expect(plan.learningDue).toBe(1);
  });
});

describe('buildQueue: the daily cap', () => {
  const cards = loadCards([many(1, 'r', REVIEW_CAP + 10)]);
  const due = at('2026-06-10T00:00');
  const allDue = new Map(cards.map((c) => [c.id, state('review', due)]));

  it(`keeps ${REVIEW_CAP} reviews and carries the rest`, () => {
    const plan = buildQueue(input({ cards, states: allDue }));
    expect(plan.reviews).toBe(REVIEW_CAP);
    expect(plan.overCap).toBe(10);
    // The ones kept are the first by due order, so tomorrow takes the rest.
    expect(plan.entries.at(-1)!.id).toBe(`r${REVIEW_CAP - 1}`);
  });

  it('counts reviews already done today, and never goes below zero', () => {
    expect(buildQueue(input({ cards, states: allDue, today: { ...zero, reviews: 115 } })).reviews).toBe(5);
    expect(buildQueue(input({ cards, states: allDue, today: { ...zero, reviews: 500 } })).reviews).toBe(0);
  });

  it('does not count new cards or same-day steps', () => {
    const plan = buildQueue(input({ cards, states: allDue, today: { ...zero, newCards: 20, steps: 40 } }));
    expect(plan.reviews).toBe(REVIEW_CAP);
  });

  it('gives a place to a learning card carried over from yesterday, which is never held back', () => {
    const extra = loadCards([many(1, 'r', REVIEW_CAP + 10), file(2, [vocab('L')])]);
    const states = new Map(allDue);
    // Failed last night at 22:00, its 10-minute step missed.
    states.set('L', state('relearning', at('2026-06-09T22:10'), at('2026-06-09T22:00')));
    const plan = buildQueue(input({ cards: extra, states }));
    expect(plan.reviews).toBe(REVIEW_CAP - 1);
    expect(plan.learningDue).toBe(1);
  });

  it('gives no place to a learning card first seen today', () => {
    const extra = loadCards([many(1, 'r', REVIEW_CAP + 10), file(2, [vocab('L')])]);
    const states = new Map(allDue);
    states.set('L', state('learning', NOW + 10 * MIN, NOW));
    expect(buildQueue(input({ cards: extra, states })).reviews).toBe(REVIEW_CAP);
  });
});

describe('buildQueue: interleaving', () => {
  const kinds = (q: QueueInput) => buildQueue(q).entries.map((e) => (e.due === null ? 'n' : 'r')).join('');

  it(`puts one new card after every ${NEW_EVERY} reviews`, () => {
    const cards = loadCards([many(1, 'r', 9), many(2, 'n', 3)]);
    const states = new Map(cards.filter((c) => c.id.startsWith('r')).map((c) => [c.id, state('review', NOW - DAY)]));
    expect(kinds(input({ cards, states }))).toBe('rrrrnrrrrnrn');
  });

  it('puts leftover new cards at the end, and only new cards on a day with no reviews', () => {
    const cards = loadCards([many(1, 'r', 2), many(2, 'n', 3)]);
    const states = new Map(['r0', 'r1'].map((id) => [id, state('review', NOW - DAY)]));
    expect(kinds(input({ cards, states }))).toBe('rrnnn');
    expect(kinds(input({ cards: loadCards([many(1, 'n', 3)]) }))).toBe('nnn');
  });
});

describe('Session', () => {
  const cards = loadCards([file(1, [vocab('a'), vocab('b'), vocab('c')])]);
  const settings = DEFAULT_SETTINGS;
  const start = (states: Map<string, CardState>, now = NOW) =>
    new Session(buildQueue(input({ cards, states, now })), cards, settings);

  it('walks the plan, and ends when it is done', () => {
    const states = new Map<string, CardState>();
    const s = start(states);
    const seen: string[] = [];
    for (let id = s.next(states, NOW); id; id = s.next(states, NOW)) {
      seen.push(id);
      states.set(id, state('review', NOW + 3 * DAY, NOW));
      s.answered(id);
    }
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(s.remaining).toBe(0);
  });

  it('brings a failed card back when its 10-minute step is due, ahead of the plan', () => {
    const states = new Map<string, CardState>();
    const s = start(states);
    const shift = shiftMin(NOW, 4, ny);
    expect(s.next(states, NOW)).toBe('a');
    states.set('a', review(DEFAULT_PARAMS, null, 1, NOW, shift));
    s.answered('a');
    expect(states.get('a')!.due).toBe(NOW + 10 * MIN);
    expect(s.next(states, NOW + MIN)).toBe('b');
    s.answered('b');
    states.set('b', review(DEFAULT_PARAMS, null, 3, NOW + MIN, shift));
    // Due now: before the rest of the plan.
    expect(s.next(states, NOW + 10 * MIN)).toBe('a');
  });

  it('shows a learning card early only once nothing else is left, within the window', () => {
    const states = new Map<string, CardState>([['a', state('learning', NOW + 15 * MIN, NOW - 5 * MIN)]]);
    const s = start(states);
    expect(s.next(states, NOW)).toBe('b');
    s.answered('b');
    states.set('b', state('review', NOW + 3 * DAY, NOW));
    expect(s.next(states, NOW)).toBe('c');
    s.answered('c');
    states.set('c', state('review', NOW + 3 * DAY, NOW));
    // 15 minutes off, inside the 20-minute window.
    expect(s.next(states, NOW)).toBe('a');
    // With a 10-minute window it waits, and the session is over for now.
    const narrow = new Session(buildQueue(input({ cards, states })), cards, { ...settings, learnAheadMin: 10 });
    expect(narrow.next(states, NOW)).toBeNull();
  });

  it('shows learning cards carried over from the last session first', () => {
    const states = new Map<string, CardState>([['c', state('relearning', NOW - 60 * MIN, NOW - 70 * MIN)]]);
    expect(start(states).next(states, NOW)).toBe('c');
  });

  it('puts an undone card back at the front, even a new one', () => {
    const states = new Map<string, CardState>();
    const s = start(states);
    s.answered('a');
    states.set('a', state('review', NOW + 3 * DAY, NOW));
    s.answered('b');
    states.set('b', state('review', NOW + 3 * DAY, NOW));
    // Undo b, then a: a comes back first, then b, then the plan.
    states.delete('b');
    s.undone('b');
    states.delete('a');
    s.undone('a');
    expect(s.next(states, NOW)).toBe('a');
    s.answered('a');
    expect(s.next(states, NOW)).toBe('b');
    s.answered('b');
    expect(s.next(states, NOW)).toBe('c');
  });

  it('drops a planned card that was answered elsewhere since the plan was made', () => {
    const states = new Map<string, CardState>();
    const s = start(states);
    // Another tab answered a.
    states.set('a', state('review', NOW + 3 * DAY, NOW));
    expect(s.next(states, NOW)).toBe('b');
  });

  it('never shows a retired learning card', () => {
    const retired = loadCards([file(1, [vocab('a', { retired: true }), vocab('b')])]);
    const states = new Map<string, CardState>([['a', state('learning', NOW - MIN, NOW - 11 * MIN)]]);
    const s = new Session(buildQueue(input({ cards: retired, states })), retired, settings);
    expect(s.next(states, NOW)).toBe('b');
    s.answered('b');
    states.set('b', state('review', NOW + 3 * DAY, NOW));
    expect(s.next(states, NOW)).toBeNull();
  });
});

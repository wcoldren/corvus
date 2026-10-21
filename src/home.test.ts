import 'fake-indexeddb/auto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadCards } from './cards/load.ts';
import type { CardFile } from './cards/types.ts';
import { Db } from './db/db.ts';
import { DEFAULT_SEC_PER_REVIEW, homeModel, loadHomeData, RECENT_REVIEWS, secPerReview, type HomeData } from './home.ts';
import { answerRow, buildDaily, byLogOrder, emptyDaily, replay, undoneIds, undoRow, type LogRow, type ReviewRow } from './log.ts';
import { DEFAULT_PARAMS, type CardState, type Rating } from './scheduler.ts';
import { DEFAULT_SETTINGS } from './settings.ts';
import { wall, zone } from './testing/zones.ts';

// Count what Home reads from the database. Patched before anything opens a
// cursor, because idb keeps its own reference to IDBCursor.prototype.continue
// from its first use.
const reads = { continues: 0, bulk: [] as string[] };
const BULK = ['getAll', 'getAllKeys', 'count'] as const;
const original = {
  continue: IDBCursor.prototype.continue,
  store: Object.fromEntries(BULK.map((m) => [m, IDBObjectStore.prototype[m]])),
  index: Object.fromEntries(BULK.map((m) => [m, IDBIndex.prototype[m]])),
};
IDBCursor.prototype.continue = function (this: IDBCursor, key?: IDBValidKey) {
  reads.continues++;
  return original.continue.call(this, key);
};
for (const m of BULK) {
  (IDBObjectStore.prototype as unknown as Record<string, unknown>)[m] = function (this: IDBObjectStore, ...args: unknown[]) {
    reads.bulk.push(`${this.name}.${m}`);
    return (original.store[m] as (...a: unknown[]) => unknown).apply(this, args);
  };
  (IDBIndex.prototype as unknown as Record<string, unknown>)[m] = function (this: IDBIndex, ...args: unknown[]) {
    reads.bulk.push(`${this.objectStore.name}.${this.name}.${m}`);
    return (original.index[m] as (...a: unknown[]) => unknown).apply(this, args);
  };
}
afterAll(() => {
  IDBCursor.prototype.continue = original.continue;
  for (const m of BULK) {
    Object.assign(IDBObjectStore.prototype, { [m]: original.store[m] });
    Object.assign(IDBIndex.prototype, { [m]: original.index[m] });
  }
});
beforeEach(() => {
  reads.continues = 0;
  reads.bulk = [];
});

const ny = zone('America/New_York');
const MIN = 60_000;
const DAY = 86_400_000;
const NOW = wall(ny, '2026-06-10T09:00');

let n = 0;
const fresh = () => new Db({ name: `home-test-${++n}` });

/** `lessons` lessons of `perLesson` concept cards each, ids `L<lesson>-<i>`. */
function corpus(lessons: number, perLesson: number): CardFile[] {
  return Array.from({ length: lessons }, (_, l) => ({
    language: 'xx',
    lesson: l + 1,
    unit: 1,
    title: '',
    cards: Array.from({ length: perLesson }, (_, i) => ({
      id: `L${l + 1}-${i}`,
      type: 'concept' as const,
      prompt: 'p',
      answer: 'a',
    })),
  }));
}

function data(over: Partial<HomeData> = {}): HomeData {
  return {
    settings: DEFAULT_SETTINGS,
    unlocked: {},
    states: new Map(),
    today: { reviews: 0, newCards: 0, steps: 0, totalMs: 0 },
    recentMs: [],
    newestTs: null,
    oldestTs: null,
    lastExport: null,
    ...over,
  };
}

const reviewState = (due: number): CardState => ({
  phase: 'review',
  due,
  lastReview: due - 3 * DAY,
  stability: 3,
  difficulty: 5,
  scheduledDays: 3,
  learningSteps: 0,
  reps: 2,
  lapses: 0,
});

describe('homeModel', () => {
  const cards = loadCards(corpus(4, 20));

  it('offers the first unlock on a fresh install, and nothing else', () => {
    expect(homeModel(cards, data(), 'xx', NOW, ny)).toEqual({
      studyDay: '2026-06-10',
      dueToday: 0,
      dueMin: 0,
      overCap: 0,
      newToday: 0,
      waiting: null,
      unlock: 1,
      secPerReview: DEFAULT_SEC_PER_REVIEW,
      exportReminder: false,
      clockBehind: false,
    });
  });

  it("splits unlocked new cards into today's and the ones waiting", () => {
    const m = homeModel(cards, data({ unlocked: { xx: 3 } }), 'xx', NOW, ny);
    expect(m.newToday).toBe(25);
    // 60 unlocked, 25 today: 35 left, from the 6th card of lesson 2 to lesson 3.
    expect(m.waiting).toEqual({ cards: 35, fromLesson: 2, toLesson: 3, days: 2 });
    expect(m.unlock).toBe(4);
    const none = homeModel(cards, data({ unlocked: { xx: 3 }, settings: { ...DEFAULT_SETTINGS, maxNew: 0 } }), 'xx', NOW, ny);
    expect(none.waiting).toEqual({ cards: 60, fromLesson: 1, toLesson: 3, days: null });
    expect(homeModel(cards, data({ unlocked: { xx: 4 } }), 'xx', NOW, ny).unlock).toBeNull();
  });

  it('leaves parse, reverse and retired cards out of the waiting count', () => {
    const mixed = loadCards([
      {
        language: 'xx',
        lesson: 1,
        unit: 1,
        title: '',
        cards: [
          { id: 'v', type: 'vocab', lemma: 'v', prompt: 'p', answer: 'a', reverse: true },
          { id: 'p', type: 'parse', lemma: 'p', prompt: 'p', answer: ['nom.sg'] },
          { id: 'r', type: 'concept', prompt: 'p', answer: 'a', retired: true },
          ...Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, type: 'concept' as const, prompt: 'p', answer: 'a' })),
        ],
      },
    ]);
    const m = homeModel(mixed, data({ unlocked: { xx: 1 } }), 'xx', NOW, ny);
    // v and c0..c29 are the 31 that can be introduced.
    expect(m.newToday).toBe(25);
    expect(m.waiting).toMatchObject({ cards: 6 });
  });

  it('estimates minutes from the mean of recent reviews, each capped at a minute', () => {
    expect(secPerReview([120_000, 6_000])).toBe(33);
    const states = new Map(cards.slice(0, 30).map((c) => [c.id, reviewState(NOW - DAY)]));
    // 30 due at the 12-second default: 6 minutes.
    expect(homeModel(cards, data({ states }), 'xx', NOW, ny)).toMatchObject({ dueToday: 30, dueMin: 6 });
    expect(homeModel(cards, data({ states, recentMs: [20_000] }), 'xx', NOW, ny).dueMin).toBe(10);
  });

  it('counts learning cards due today, and reports what the cap holds back', () => {
    const many = loadCards(corpus(7, 20));
    const states = new Map(many.map((c) => [c.id, reviewState(NOW - DAY)]));
    states.set('L1-0', { ...reviewState(NOW + 30 * MIN), phase: 'learning', lastReview: NOW - 10 * MIN });
    const m = homeModel(many, data({ states }), 'xx', NOW, ny);
    expect(m).toMatchObject({ dueToday: 121, overCap: 19 });
  });

  it('reminds about exporting after 7 days, counting from the first review until there is an export', () => {
    const remind = (over: Partial<HomeData>) => homeModel(cards, data(over), 'xx', NOW, ny).exportReminder;
    expect(remind({ lastExport: NOW - 7 * DAY })).toBe(true);
    expect(remind({ lastExport: NOW - 6 * DAY, oldestTs: NOW - 90 * DAY })).toBe(false);
    expect(remind({ oldestTs: NOW - 8 * DAY })).toBe(true);
    expect(remind({ oldestTs: NOW - DAY })).toBe(false);
  });

  it('warns when the clock reads more than 5 minutes behind the newest row', () => {
    expect(homeModel(cards, data({ newestTs: NOW + 6 * MIN }), 'xx', NOW, ny).clockBehind).toBe(true);
    expect(homeModel(cards, data({ newestTs: NOW + 4 * MIN }), 'xx', NOW, ny).clockBehind).toBe(false);
  });
});

/**
 * 50,000 answers over 500 days: 100 a day, each of 2,500 cards seen every
 * 25 days, about one in nine failed, and about one in a hundred undone. The
 * times vary so the one-minute cap matters.
 */
function history(): { rows: LogRow[]; now: number } {
  const start = wall(ny, '2025-01-27T09:00');
  const states = new Map<string, CardState>();
  const rows: LogRow[] = [];
  let ts = start;
  for (let d = 0; d < 500; d++) {
    for (let j = 0; j < 100; j++) {
      const i = (d * 100 + j) % 2500;
      const id = `L${Math.floor(i / 25) + 1}-${i % 25}`;
      ts = start + d * DAY + j * 20_000;
      const rating: Rating = (d + j) % 9 === 0 ? 1 : 3;
      const ctx = { now: ts, rolloverHour: 4, zone: ny, sessionId: `s${d}`, buildId: 'test', id: `r${d}-${j}` };
      const { row, after } = answerRow(
        { id, prompt: 'p', answer: 'a', accept: [] },
        states.get(id) ?? null,
        { rating, suggested: rating, mode: 'reveal', response: null, outcome: rating === 1 ? 'wrong' : 'correct', hintShown: false, answerMs: 3000, totalMs: 2000 + ((j * 1777) % 70_000) },
        DEFAULT_PARAMS,
        ctx,
      );
      rows.push(row);
      if ((d * 100 + j) % 97 === 50) rows.push(undoRow(row, { ...ctx, now: ts + 5000, id: `u${d}-${j}` }));
      else states.set(id, after);
    }
  }
  return { rows, now: ts + 30 * MIN };
}

describe('Home with a long history', () => {
  it('reads aggregates and a bounded walk, never the whole log, and agrees with the full log', async () => {
    const files = corpus(110, 25);
    const cards = loadCards(files);
    const { rows, now } = history();
    expect(rows.filter((r) => r.kind === 'review')).toHaveLength(50_000);

    const params = new Map([[DEFAULT_PARAMS.id, DEFAULT_PARAMS]]);
    const states = replay(rows, params);
    const daily = buildDaily(rows);
    const db = fresh();
    await db.write(async (conn) => {
      const tx = conn.transaction(['reviewLog', 'cardState', 'params', 'daily', 'meta'], 'readwrite');
      for (const r of rows) void tx.objectStore('reviewLog').put(r);
      for (const [id, s] of states) void tx.objectStore('cardState').put(s, id);
      for (const d of daily) void tx.objectStore('daily').put(d);
      void tx.objectStore('params').put(DEFAULT_PARAMS);
      void tx.objectStore('meta').put({ xx: 104 }, 'unlockedThrough');
      await tx.done;
    });

    reads.continues = 0;
    reads.bulk = [];
    const loaded = await loadHomeData(db, now, ny);
    expect(reads.bulk.filter((r) => r.startsWith('reviewLog'))).toEqual([]);
    const undoneNearEnd = rows.slice(-(RECENT_REVIEWS + 20)).filter((r) => r.kind === 'undo').length;
    expect(reads.continues).toBeLessThanOrEqual(RECENT_REVIEWS + 2 * undoneNearEnd);

    // What the same numbers are when worked out from every row.
    const undone = undoneIds(rows);
    const sorted = [...rows].sort(byLogOrder);
    const kept = sorted.filter((r): r is ReviewRow => r.kind === 'review' && !undone.has(r.id));
    const day = '2026-06-10';
    const { day: _d, ...today } = daily.find((d) => d.day === day) ?? emptyDaily(day);
    const expected: HomeData = {
      settings: DEFAULT_SETTINGS,
      unlocked: { xx: 104 },
      states,
      today,
      recentMs: kept.slice(-RECENT_REVIEWS).reverse().map((r) => r.totalMs),
      newestTs: sorted.at(-1)!.ts,
      oldestTs: sorted[0]!.ts,
      lastExport: null,
    };
    expect(loaded).toEqual(expected);
    expect(today.reviews + today.newCards + today.steps).toBeGreaterThan(90);

    const model = homeModel(cards, loaded, 'xx', now, ny);
    expect(model).toEqual(homeModel(cards, expected, 'xx', now, ny));
    expect(model).toMatchObject({
      studyDay: day,
      newToday: 25,
      waiting: { cards: 75, fromLesson: 102, toLesson: 104, days: 3 },
      unlock: 105,
      exportReminder: true,
      clockBehind: false,
    });
    expect(model.dueToday).toBeGreaterThan(0);
    db.close();
  }, 120_000);
});

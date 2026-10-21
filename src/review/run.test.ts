import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { Bus, type Events } from '../bus.ts';
import { loadCards } from '../cards/load.ts';
import type { CardFile, CardJson } from '../cards/types.ts';
import { Db } from '../db/db.ts';
import { CardChangedError, getState } from '../db/history.ts';
import { unlockLesson } from '../db/meta.ts';
import { DEFAULT_PARAMS, review } from '../scheduler.ts';
import { wall, zone } from '../testing/zones.ts';
import { ReviewRun } from './run.ts';

const ny = zone('America/New_York');
const MIN = 60_000;

const vocab = (id: string): CardJson => ({ id, type: 'vocab', lemma: `l-${id}`, prompt: `p-${id}`, answer: `a-${id}` });
const ending = (id: string): CardJson => ({ id, type: 'ending', lemma: `l-${id}`, prompt: `p-${id}`, answer: `a${id}` });
const file: CardFile = { language: 'xx', lesson: 1, unit: 1, title: 'L1', cards: [vocab('a'), ending('b'), vocab('c')] };
const cards = loadCards([file]);

let n = 0;
async function setup(start = wall(ny, '2026-06-10T09:00')) {
  const events: { name: keyof Events; payload: unknown }[] = [];
  const bus = new Bus();
  bus.on('session:completed', (p) => events.push({ name: 'session:completed', payload: p }));
  const db = new Db({ name: `run-test-${++n}`, bus });
  await unlockLesson(db, 'xx', 1);
  const clock = { now: start };
  const run = await ReviewRun.open({ db, cards, buildId: 'test', zone: ny, now: () => clock.now });
  return { db, run, clock, events };
}

/** The log in the order rows were written (keys are random UUIDs). */
const logRows = (db: Db) => db.read((c) => c.getAllFromIndex('reviewLog', 'byTs'));

describe('ReviewRun', () => {
  it('shows each planned card, saves each rating, and ends', async () => {
    const { db, run, clock, events } = await setup();
    expect(run.remaining).toBe(3);
    const seen: string[] = [];
    for (let t = run.next(); t; t = run.next()) {
      seen.push(t.card.id);
      clock.now += 3000;
      if (t.card.mode === 'typed') t.submit(t.card.answer as string, { ignoreWords: [], forms: new Map() }, clock.now);
      else t.reveal(clock.now);
      clock.now += 2000;
      void run.rate(3);
    }
    expect(seen).toEqual(['a', 'b', 'c']);
    await run.saved();
    const rows = await logRows(db);
    expect(rows.map((r) => [r.cardId, r.kind, r.rating, r.sessionId])).toEqual([
      ['a', 'review', 3, run.sessionId],
      ['b', 'review', 3, run.sessionId],
      ['c', 'review', 3, run.sessionId],
    ]);
    expect(rows.find((r) => r.cardId === 'b')).toMatchObject({ outcome: 'correct', suggested: 3, answerMs: 3000, totalMs: 5000 });
    expect(await getState(db, 'a')).toMatchObject({ phase: 'review' });
    expect(run.usedMs).toBe(15_000);
    // Emitted once, after the last save committed.
    await Promise.resolve();
    expect(events).toEqual([
      { name: 'session:completed', payload: { studyDay: '2026-06-10', reviews: 0, newCards: 3, ms: 15_000 } },
    ]);
    run.next();
    await run.saved();
    expect(events).toHaveLength(1);
  });

  it('brings a failed card back after its step, in the same session', async () => {
    const { run, clock } = await setup();
    const a = run.next()!;
    a.reveal(clock.now);
    void run.rate(1);
    for (const id of ['b', 'c']) {
      const t = run.next()!;
      expect(t.card.id).toBe(id);
      t.reveal(clock.now);
      void run.rate(3);
    }
    // a is due in 10 minutes, inside the learn-ahead window, so it comes now.
    expect(run.next()?.card.id).toBe('a');
    await run.saved();
  });

  it('undoes the latest answer: state restored, card back at the front', async () => {
    const { db, run, clock } = await setup();
    const a = run.next()!;
    a.reveal(clock.now);
    void run.rate(3);
    clock.now += MIN;
    const b = run.next()!;
    b.submit('ab', { ignoreWords: [], forms: new Map() }, clock.now);
    void run.rate(3);
    expect(run.canUndo).toBe(true);
    expect((await run.undo())?.id).toBe('b');
    expect(await getState(db, 'b')).toBeUndefined();
    expect(run.next()?.card.id).toBe('b');
    expect((await run.undo())?.id).toBe('a');
    expect(run.canUndo).toBe(false);
    expect(await run.undo()).toBeNull();
    expect(run.next()?.card.id).toBe('a');
    expect(run.usedMs).toBe(0);
    const rows = await logRows(db);
    expect(rows.filter((r) => r.kind === 'undo')).toHaveLength(2);
  });

  it('reports a card changed elsewhere, and reloads from the database', async () => {
    const { db, run, clock } = await setup();
    const t = run.next()!;
    // Another tab answers a first.
    const other = review(DEFAULT_PARAMS, null, 3, clock.now, -480);
    await db.write((c) => c.put('cardState', other, 'a'));
    t.reveal(clock.now);
    await expect(run.rate(3)).rejects.toBeInstanceOf(CardChangedError);
    await expect(run.saved()).rejects.toThrow();
    await run.reload();
    await run.saved();
    // a is no longer new, and not due, so the plan starts at b.
    expect(run.next()?.card.id).toBe('b');
  });

  it('saves every rating, even when ratings come faster than they save', async () => {
    const { db, run, clock } = await setup();
    const saves: Promise<void>[] = [];
    for (let t = run.next(); t; t = run.next()) {
      t.reveal(clock.now);
      clock.now += 1000;
      saves.push(run.rate(3));
    }
    await Promise.all(saves);
    const rows = await logRows(db);
    expect(rows.map((r) => r.cardId)).toEqual(['a', 'b', 'c']);
  });

  it('counts time already logged today toward the goal, and notices the rollover', async () => {
    const { db, clock } = await setup();
    const first = await ReviewRun.open({ db, cards, buildId: 'test', zone: ny, now: () => clock.now });
    const t = first.next()!;
    clock.now += 7000;
    t.reveal(clock.now);
    await first.rate(3);
    const second = await ReviewRun.open({ db, cards, buildId: 'test', zone: ny, now: () => clock.now });
    expect(second.usedMs).toBe(7000);
    expect(second.goalMs).toBe(20 * MIN);
    expect(second.isStale()).toBe(false);
    clock.now = wall(ny, '2026-06-11T04:01');
    expect(second.isStale()).toBe(true);
  });

  it('skips a card for the rest of the session without logging it', async () => {
    const { db, run } = await setup();
    run.next();
    run.skip();
    expect(run.next()?.card.id).toBe('b');
    expect(await logRows(db)).toEqual([]);
  });

  it('previews the intervals the current card would get', async () => {
    const { run } = await setup();
    run.next();
    expect(run.previews()?.[1]).toBe(10 * MIN);
  });
});

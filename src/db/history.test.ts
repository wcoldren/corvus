import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { Bus } from '../bus.ts';
import { answerRow, buildDaily, replay, type Answer, type LogRow } from '../log.ts';
import { DEFAULT_PARAMS, type Rating } from '../scheduler.ts';
import { wall, zone } from '../testing/zones.ts';
import { Db } from './db.ts';
import { CardChangedError, getState, recordReview, recordUndo } from './history.ts';

const ny = zone('America/New_York');
const MIN = 60_000;

let n = 0;
const fresh = (bus = new Bus()) => new Db({ name: `history-test-${++n}`, bus });

const card = (id: string) => ({ id, prompt: `prompt ${id}`, answer: `answer ${id}`, accept: [] });
const ans = (rating: Rating): Answer => ({
  rating,
  suggested: rating === 1 ? 1 : 3,
  mode: 'typed',
  response: 'x',
  outcome: rating === 1 ? 'wrong' : 'correct',
  hintShown: false,
  answerMs: 2000,
  totalMs: 4000,
});
const ctx = (now: number, sessionId = 's1', id?: string) => ({
  now,
  rolloverHour: 4,
  zone: ny,
  sessionId,
  buildId: 'test',
  ...(id ? { id } : {}),
});

/** Answer a card the way the review screen will: read its state, build the row, save. */
async function answer(db: Db, cardId: string, rating: Rating, now: number, sessionId = 's1') {
  const before = (await getState(db, cardId)) ?? null;
  const built = answerRow(card(cardId), before, ans(rating), DEFAULT_PARAMS, ctx(now, sessionId));
  await recordReview(db, built.row, built.after, DEFAULT_PARAMS);
  return built;
}

async function dump(db: Db) {
  return db.read(async (conn) => ({
    reviewLog: await conn.getAll('reviewLog'),
    states: Object.fromEntries(
      await Promise.all((await conn.getAllKeys('cardState')).map(async (k) => [k, await conn.get('cardState', k)])),
    ),
    params: await conn.getAll('params'),
    daily: await conn.getAll('daily'),
  }));
}

describe('recordReview', () => {
  it('writes the row, the state, the config and the day in one go', async () => {
    const db = fresh();
    const { row, after } = await answer(db, 'a', 3, wall(ny, '2026-06-10T09:00'));
    const d = await dump(db);
    expect(d.reviewLog).toEqual([row]);
    expect(d.states).toEqual({ a: after });
    expect(d.params).toEqual([DEFAULT_PARAMS]);
    expect(d.daily).toEqual([{ day: '2026-06-10', reviews: 0, newCards: 1, steps: 0, totalMs: 4000 }]);
    db.close();
  });

  it('tells the bus only once the answer is readable', async () => {
    const bus = new Bus();
    const db = fresh(bus);
    const seen: Promise<unknown>[] = [];
    bus.on('review:answered', (p) => {
      seen.push(getState(db, p.cardId));
      expect(p).toMatchObject({ cardId: 'a', outcome: 'correct', suggested: 3, rating: 3 });
    });
    const { after } = await answer(db, 'a', 3, wall(ny, '2026-06-10T09:00'));
    expect(seen).toHaveLength(1);
    expect(await seen[0]).toEqual(after);
    db.close();
  });

  it('writes nothing more when a committed answer is saved again', async () => {
    const db = fresh();
    const { row, after } = await answer(db, 'a', 3, wall(ny, '2026-06-10T09:00'));
    await recordReview(db, row, after, DEFAULT_PARAMS);
    const d = await dump(db);
    expect(d.reviewLog).toHaveLength(1);
    expect(d.daily[0]?.newCards).toBe(1);
    db.close();
  });

  it('keeps going when a listener throws', async () => {
    const onError = vi.fn();
    const bus = new Bus(onError);
    bus.on('review:answered', () => {
      throw new Error('game bug');
    });
    const db = fresh(bus);
    await answer(db, 'a', 3, wall(ny, '2026-06-10T09:00'));
    expect(onError).toHaveBeenCalledOnce();
    db.close();
  });
});

describe('recordUndo', () => {
  const t0 = wall(ny, '2026-06-10T09:00');

  it('restores the exact previous state, back to the start of the session', async () => {
    const bus = new Bus();
    const undone: string[] = [];
    bus.on('review:undone', (p) => undone.push(p.logId));
    const db = fresh(bus);
    const first = await answer(db, 'a', 3, t0, 'yesterday');
    const t1 = first.after.due; // the next day
    const s = (k: number) => t1 + k * MIN;
    const one = await answer(db, 'a', 1, s(0), 's2');
    const two = await answer(db, 'b', 3, s(1), 's2');
    const three = await answer(db, 'a', 3, s(12), 's2');

    expect(await recordUndo(db, 's2', one.row.studyDay, ctx(s(13)))).toEqual(three.row);
    expect(await getState(db, 'a')).toEqual(one.after);
    expect(await recordUndo(db, 's2', one.row.studyDay, ctx(s(14)))).toEqual(two.row);
    expect(await getState(db, 'b')).toBeUndefined(); // new again
    expect(await recordUndo(db, 's2', one.row.studyDay, ctx(s(15)))).toEqual(one.row);
    expect(await getState(db, 'a')).toEqual(first.after);
    // The previous session's answer is out of reach.
    expect(await recordUndo(db, 's2', one.row.studyDay, ctx(s(16)))).toBeNull();
    expect(await getState(db, 'a')).toEqual(first.after);

    expect(undone).toEqual([three.row.id, two.row.id, one.row.id]);
    const d = await dump(db);
    expect(d.reviewLog.filter((r) => r.kind === 'undo')).toHaveLength(3);
    expect(d.daily.find((x) => x.day === one.row.studyDay)).toEqual({
      day: one.row.studyDay,
      reviews: 0,
      newCards: 0,
      steps: 0,
      totalMs: 0,
    });
    db.close();
  });

  it('undoes only once when retried after a commit', async () => {
    const db = fresh();
    await answer(db, 'a', 3, t0);
    const second = await answer(db, 'b', 3, t0 + MIN);
    const c = ctx(t0 + 2 * MIN, 's1', 'undo-1');
    expect(await recordUndo(db, 's1', second.row.studyDay, c)).toEqual(second.row);
    expect(await recordUndo(db, 's1', second.row.studyDay, c)).toEqual(second.row);
    expect((await dump(db)).reviewLog.filter((r) => r.kind === 'undo')).toHaveLength(1);
    expect(await getState(db, 'a')).toBeDefined();
    db.close();
  });

  it('refuses when the card has moved on since the answer', async () => {
    const db = fresh();
    const mine = await answer(db, 'a', 1, t0, 's1');
    await answer(db, 'a', 3, t0 + 11 * MIN, 'other-tab');
    await expect(recordUndo(db, 's1', mine.row.studyDay, ctx(t0 + 12 * MIN))).rejects.toThrow(CardChangedError);
    expect((await dump(db)).reviewLog).toHaveLength(2);
    db.close();
  });
});

describe('stored state against replay', () => {
  it('agree after days of answers and undos across a DST change', async () => {
    const db = fresh();
    const days = ['2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-12'];
    const cards = ['a', 'b', 'c', 'd'];
    const ratings: Rating[] = [3, 1, 3, 2, 4, 3, 1, 3];
    let k = 0;
    for (const [i, day] of days.entries()) {
      const session = `s-${day}`;
      let now = wall(ny, `${day}T21:30`);
      for (const id of cards) {
        await answer(db, id, ratings[k++ % ratings.length]!, now, session);
        now += 2 * MIN;
      }
      // Some failed cards come back after their 10-minute step.
      await answer(db, cards[i % cards.length]!, 3, now + 11 * MIN, session);
      if (i % 2 === 0) await recordUndo(db, session, (await dump(db)).reviewLog.at(-1)!.studyDay, ctx(now + 12 * MIN, session));
    }
    const d = await dump(db);
    const replayed = replay(d.reviewLog as LogRow[], new Map(d.params.map((p) => [p.id, p])));
    expect(Object.fromEntries(replayed)).toEqual(d.states);
    expect(d.daily).toEqual(buildDaily(d.reviewLog));
    db.close();
  });
});

describe('code review findings (2026-10-20)', () => {
  it('refuses a second answer built from the same before state', async () => {
    const db = fresh();
    const t = wall(ny, '2026-06-10T09:00');
    const first = answerRow(card('a'), null, ans(3), DEFAULT_PARAMS, ctx(t));
    const double = answerRow(card('a'), null, ans(3), DEFAULT_PARAMS, ctx(t + 500));
    await recordReview(db, first.row, first.after, DEFAULT_PARAMS);
    await expect(recordReview(db, double.row, double.after, DEFAULT_PARAMS)).rejects.toThrow(CardChangedError);
    expect((await dump(db)).reviewLog).toHaveLength(1);
    db.close();
  });

  it('undoes the last answer given, even after the clock went backwards', async () => {
    const db = fresh();
    const ten = wall(ny, '2026-06-10T10:00');
    await answer(db, 'a', 1, ten, 'earlier');
    const nine = wall(ny, '2026-06-10T09:00');
    await answer(db, 'a', 3, nine, 's1'); // clamped to 10:00:01
    const b = await answer(db, 'b', 3, nine + 30_000, 's1'); // 09:00:30
    expect(await recordUndo(db, 's1', b.row.studyDay, ctx(nine + 60_000))).toEqual(b.row);
    db.close();
  });

  it('keeps walking back when the undos fall after the rollover', async () => {
    const db = fresh();
    const t = wall(ny, '2026-06-11T03:50');
    const one = await answer(db, 'a', 3, t);
    const two = await answer(db, 'b', 3, t + 5 * MIN);
    const day = one.row.studyDay;
    expect(await recordUndo(db, 's1', day, ctx(wall(ny, '2026-06-11T04:01')))).toEqual(two.row);
    expect(await recordUndo(db, 's1', day, ctx(wall(ny, '2026-06-11T04:02')))).toEqual(one.row);
    db.close();
  });
});

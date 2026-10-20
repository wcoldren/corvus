import { describe, expect, it } from 'vitest';
import {
  LOG_FIELDS,
  answerRow,
  buildDaily,
  cardHash,
  manualRow,
  replay,
  undoRow,
  type Answer,
  type LogRow,
  type ReviewRow,
} from './log.ts';
import { DEFAULT_PARAMS, makeParams, type CardState, type Params, type Rating } from './scheduler.ts';
import { wall, zone } from './testing/zones.ts';
import type { Zone } from './day.ts';

const R = 4;
const MIN = 60_000;
const ny = zone('America/New_York');
const kolkata = zone('Asia/Kolkata');
const PARAMS = new Map([[DEFAULT_PARAMS.id, DEFAULT_PARAMS]]);

const card = (id: string) => ({ id, prompt: `prompt ${id}`, answer: `answer ${id}`, accept: [] });

function answer(rating: Rating): Answer {
  return {
    rating,
    suggested: null,
    mode: 'reveal',
    response: null,
    outcome: rating === 1 ? 'wrong' : 'correct',
    hintShown: false,
    answerMs: 3000,
    totalMs: 5000,
  };
}

let seq = 0;
const ctx = (now: number, z: Zone, extra: { sessionId?: string } = {}) => ({
  now,
  rolloverHour: R,
  zone: z,
  sessionId: extra.sessionId ?? 's1',
  buildId: 'test',
  id: `row-${String(++seq).padStart(4, '0')}`,
});

/**
 * Review one card at each wall time in turn, the way the app would: each
 * answer starts from the state the last one produced. Returns the rows and
 * the state after each.
 */
function history(cardId: string, z: Zone, steps: [string, Rating][], params: Params = DEFAULT_PARAMS) {
  let state: CardState | null = null;
  const rows: ReviewRow[] = [];
  const states: CardState[] = [];
  for (const [time, rating] of steps) {
    const { row, after } = answerRow(card(cardId), state, answer(rating), params, ctx(wall(z, time), z));
    rows.push(row);
    states.push(after);
    state = after;
  }
  return { rows, states, final: state };
}

// Daily study around New York's spring change (2026-03-08) and fall change
// (2026-11-01), some late at night so the rollover hour matters.
const SPRING: [string, Rating][] = [
  ['2026-03-05T21:30', 3],
  ['2026-03-06T08:00', 3],
  ['2026-03-07T23:50', 1],
  ['2026-03-08T00:05', 3],
  ['2026-03-08T21:00', 3],
  ['2026-03-10T07:00', 2],
  ['2026-03-14T20:00', 3],
];
const FALL: [string, Rating][] = [
  ['2026-10-29T22:00', 3],
  ['2026-10-31T03:30', 3],
  ['2026-11-01T01:30', 1],
  ['2026-11-01T01:45', 3],
  ['2026-11-01T09:00', 4],
  ['2026-11-04T19:00', 3],
];

describe('log rows', () => {
  it('carry every field, null where it does not apply', () => {
    const t = wall(ny, '2026-06-10T09:00');
    const { row } = answerRow(card('la-01-v-aqua'), null, answer(3), DEFAULT_PARAMS, ctx(t, ny));
    const undo = undoRow(row, ctx(t + MIN, ny));
    const flag = manualRow('la-01-v-aqua', 'flag', 'odd prompt', ctx(t + 2 * MIN, ny));
    for (const r of [row, undo, flag]) expect(Object.keys(r).sort()).toEqual([...LOG_FIELDS].sort());
    expect(undo).toMatchObject({ kind: 'undo', undoes: row.id, rating: null, before: null, paramsId: null });
    expect(flag).toMatchObject({ kind: 'manual', action: 'flag', note: 'odd prompt', rating: null });
    expect(manualRow('x', 'suspend', 'ignored', ctx(t, ny)).note).toBeNull();
  });

  it('record the day, the shift and the offset used', () => {
    const t = wall(ny, '2026-06-11T02:00');
    const { row } = answerRow(card('a'), null, answer(3), DEFAULT_PARAMS, ctx(t, ny));
    expect(row).toMatchObject({ ts: t, wallTs: null, studyDay: '2026-06-10', shiftMin: -240 - 240, tzOffsetMin: -240 });
    expect(row.paramsId).toBe(DEFAULT_PARAMS.id);
    expect(row.v).toBe(1);
  });

  it('clamp the review time after the last review, and keep the clock reading', () => {
    const t = wall(ny, '2026-06-10T09:00');
    const first = answerRow(card('a'), null, answer(1), DEFAULT_PARAMS, ctx(t, ny));
    const behind = t - 30 * MIN;
    const { row } = answerRow(card('a'), first.after, answer(3), DEFAULT_PARAMS, ctx(behind, ny));
    expect(row.ts).toBe(t + 1000);
    expect(row.wallTs).toBe(behind);
  });

  it('hash what the card asked, so an edited card can be told apart', () => {
    expect(cardHash(card('a'))).toBe(cardHash(card('a')));
    expect(cardHash({ ...card('a'), prompt: 'changed' })).not.toBe(cardHash(card('a')));
    expect(cardHash({ ...card('a'), accept: ['more'] })).not.toBe(cardHash(card('a')));
  });
});

describe('replay', () => {
  it('rebuilds the state recorded at every step, across DST, in two zones', () => {
    for (const [z, steps] of [
      [ny, SPRING],
      [ny, FALL],
      [kolkata, SPRING],
      [kolkata, FALL],
    ] as const) {
      const { rows, states } = history('a', z, steps);
      for (let i = 0; i < rows.length; i++) {
        expect(replay(rows.slice(0, i + 1), PARAMS).get('a')).toEqual(states[i]);
      }
    }
  });

  it('uses the config each row was written with', () => {
    const strict = makeParams({ retention: 0.95 });
    const a = history('a', ny, SPRING.slice(0, 3));
    const b = history('b', ny, SPRING.slice(0, 3), strict);
    const all = new Map([...PARAMS, [strict.id, strict]]);
    const states = replay([...a.rows, ...b.rows], all);
    expect(states.get('a')).toEqual(a.final);
    expect(states.get('b')).toEqual(b.final);
    expect(() => replay(b.rows, PARAMS)).toThrow(/missing/);
  });

  it('gives the same result whatever order merged rows arrive in', () => {
    const a = history('a', ny, SPRING);
    const b = history('b', kolkata, FALL);
    const rows = [...a.rows, ...b.rows];
    const expected = new Map([
      ['a', a.final],
      ['b', b.final],
    ]);
    expect(replay(rows, PARAMS)).toEqual(expected);
    expect(replay([...rows].reverse(), PARAMS)).toEqual(expected);
    expect(replay([...b.rows, ...a.rows], PARAMS)).toEqual(expected);
  });

  it('leaves out undone reviews', () => {
    // Good, then Again undone, then Good from the restored state.
    const t0 = wall(ny, '2026-06-10T09:00');
    const first = answerRow(card('a'), null, answer(3), DEFAULT_PARAMS, ctx(t0, ny));
    const t1 = first.after.due;
    const slip = answerRow(card('a'), first.after, answer(1), DEFAULT_PARAMS, ctx(t1, ny));
    const undo = undoRow(slip.row, ctx(t1 + MIN, ny));
    const redo = answerRow(card('a'), slip.row.before, answer(3), DEFAULT_PARAMS, ctx(t1 + 2 * MIN, ny));
    expect(replay([first.row, slip.row, undo, redo.row], PARAMS).get('a')).toEqual(redo.after);
    // Undoing a card's only review leaves it new.
    expect(replay([first.row, undoRow(first.row, ctx(t0 + MIN, ny))], PARAMS).has('a')).toBe(false);
  });

  it('returns a forgotten card to new, and suspend leaves the schedule alone', () => {
    const a = history('a', ny, SPRING.slice(0, 2));
    const after = wall(ny, '2026-03-07T10:00');
    const suspend = manualRow('a', 'suspend', null, ctx(after, ny));
    expect(replay([...a.rows, suspend], PARAMS).get('a')).toEqual(a.final);
    const forget = manualRow('a', 'forget', null, ctx(after, ny));
    expect(replay([...a.rows, forget], PARAMS).has('a')).toBe(false);
    const again = answerRow(card('a'), null, answer(3), DEFAULT_PARAMS, ctx(after + MIN, ny));
    expect(replay([...a.rows, forget, again.row], PARAMS).get('a')).toEqual(again.after);
  });
});

describe('daily totals', () => {
  it('count new cards, earlier-day reviews and same-day steps apart', () => {
    const { rows } = history('a', ny, [
      ['2026-06-10T09:00', 1], // new
      ['2026-06-10T09:12', 3], // same-day step
      ['2026-06-11T02:00', 3], // still 2026-06-10's study day: a step
      ['2026-06-12T09:00', 3], // a review from an earlier day
    ]);
    expect(buildDaily(rows)).toEqual([
      { day: '2026-06-10', reviews: 0, newCards: 1, steps: 2, totalMs: 15000 },
      { day: '2026-06-12', reviews: 1, newCards: 0, steps: 0, totalMs: 5000 },
    ]);
  });

  it('leave out undone reviews', () => {
    const { rows } = history('a', ny, [['2026-06-10T09:00', 3]]);
    const undo = undoRow(rows[0]!, ctx(wall(ny, '2026-06-10T09:01'), ny));
    expect(buildDaily([...rows, undo] as LogRow[])).toEqual([]);
  });
});

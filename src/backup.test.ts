import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  BackupError,
  backupFileName,
  buildExport,
  importBackup,
  reset,
  summarizeImport,
  validateBackup,
  type Backup,
} from './backup.ts';
import { Db } from './db/db.ts';
import { getState, recordReview, recordUndo } from './db/history.ts';
import { LOG_FIELDS, answerRow, buildDaily, replay, type Answer } from './log.ts';
import { DEFAULT_PARAMS, makeParams, type Params, type Rating } from './scheduler.ts';
import { wall, zone } from './testing/zones.ts';

const ny = zone('America/New_York');
const MIN = 60_000;

let n = 0;
const fresh = () => new Db({ name: `backup-test-${++n}` });

const ans = (rating: Rating): Answer => ({
  rating,
  suggested: null,
  mode: 'reveal',
  response: null,
  outcome: rating === 1 ? 'wrong' : 'correct',
  hintShown: false,
  answerMs: 1500,
  totalMs: 3000,
});
const ctx = (now: number, sessionId: string) => ({ now, rolloverHour: 4, zone: ny, sessionId, buildId: 'test' });

async function answer(db: Db, cardId: string, rating: Rating, now: number, session: string, params: Params = DEFAULT_PARAMS) {
  const before = (await getState(db, cardId)) ?? null;
  const card = { id: cardId, prompt: cardId, answer: cardId, accept: [] };
  const { row, after } = answerRow(card, before, ans(rating), params, ctx(now, session));
  await recordReview(db, row, after, params);
  return row;
}

/** A few days of study on one device, with an undo. */
async function study(db: Db, cards: string[], firstDay: string, params: Params = DEFAULT_PARAMS) {
  const start = wall(ny, `${firstDay}T20:00`);
  for (let d = 0; d < 3; d++) {
    const session = `${firstDay}-${d}`;
    let now = start + d * 86_400_000;
    for (const id of cards) {
      await answer(db, id, d === 1 && id === cards[0] ? 1 : 3, now, session, params);
      now += MIN;
    }
    if (d === 2) {
      const last = await answer(db, cards[0]!, 2, now + 15 * MIN, session, params);
      await recordUndo(db, session, last.studyDay, ctx(now + 16 * MIN, session));
    }
  }
}

async function setMeta(db: Db, key: string, value: unknown) {
  await db.write((conn) => conn.put('meta', value, key));
}

/** Everything in the database, in a comparable form. */
async function dump(db: Db) {
  return db.read(async (conn) => {
    const keys = await conn.getAllKeys('cardState');
    const values = await conn.getAll('cardState');
    const metaKeys = await conn.getAllKeys('meta');
    const metaValues = await conn.getAll('meta');
    return {
      reviewLog: (await conn.getAll('reviewLog')).sort((a, b) => (a.id < b.id ? -1 : 1)),
      cardState: Object.fromEntries(keys.map((k, i) => [k, values[i]])),
      params: await conn.getAll('params'),
      daily: await conn.getAll('daily'),
      meta: Object.fromEntries(metaKeys.map((k, i) => [k, metaValues[i]])),
    };
  });
}

/** An export as it comes back from a file. */
const roundTrip = (b: Backup) => validateBackup(JSON.parse(JSON.stringify(b)));

describe('export', () => {
  it('holds the whole database, every row with every field', async () => {
    const db = fresh();
    await study(db, ['a', 'b', 'c'], '2026-06-10');
    await setMeta(db, 'settings', { goalMin: 20 });
    await setMeta(db, 'unlockedThrough', { la: 3 });
    const b = await buildExport(db, { now: 1_800_000_000_000, buildId: 'build-1' });
    const d = await dump(db);

    expect(b).toMatchObject({ format: 'corvus-backup', formatVersion: 1, buildId: 'build-1', dbVersion: 1 });
    expect(b.settings).toEqual({ goalMin: 20 });
    expect(b.unlockedThrough).toEqual({ la: 3 });
    expect(b.cardStates).toEqual(d.cardState);
    expect(b.params).toEqual([DEFAULT_PARAMS]);
    expect(b.reviewLog).toHaveLength(d.reviewLog.length);
    for (const row of b.reviewLog) expect(Object.keys(row).sort()).toEqual([...LOG_FIELDS].sort());
    expect(b.counts).toEqual({
      reviewLog: d.reviewLog.length,
      cardStates: 3,
      params: 1,
      newestTs: Math.max(...d.reviewLog.map((r) => r.ts)),
    });
    expect(roundTrip(b)).toEqual(b);
    db.close();
  });

  it('is named by the local date', () => {
    expect(backupFileName(wall(ny, '2026-11-02T23:30'), ny)).toBe('corvus-backup-2026-11-02.json');
  });
});

describe('validateBackup', () => {
  async function sample() {
    const db = fresh();
    await study(db, ['a'], '2026-06-10');
    const b = JSON.parse(JSON.stringify(await buildExport(db, { now: 0, buildId: 'x' })));
    db.close();
    return b;
  }

  it('rejects files it cannot read, saying why', async () => {
    const cases: [string, (b: any) => unknown, RegExp][] = [
      ['not an object', () => 'hello', /format marker/],
      ['another format', (b) => ({ ...b, format: 'anki' }), /format marker/],
      ['a newer format', (b) => ({ ...b, formatVersion: 2 }), /newer version/],
      ['a short log', (b) => ({ ...b, reviewLog: b.reviewLog.slice(1) }), /count/],
      ['a row missing a field', (b) => (delete b.reviewLog[0].hintShown, b), /lacks hintShown/],
      ['a row of a newer version', (b) => ((b.reviewLog[0].v = 2), b), /row version 2/],
      ['an unknown kind', (b) => ((b.reviewLog[0].kind = 'skip'), b), /unknown kind/],
      ['a missing config', (b) => ({ ...b, params: [] }), /config the file lacks/],
      ['a bad lesson number', (b) => ({ ...b, unlockedThrough: { la: 'three' } }), /lesson number/],
    ];
    for (const [what, mutate, why] of cases) {
      const bad = mutate(await sample());
      expect(() => validateBackup(bad), what).toThrow(BackupError);
      expect(() => validateBackup(bad), what).toThrow(why);
    }
  });
});

describe('import', () => {
  it('restores everything onto an empty device', async () => {
    const old = fresh();
    await study(old, ['a', 'b', 'c'], '2026-06-10');
    await setMeta(old, 'unlockedThrough', { la: 3 });
    const file = roundTrip(await buildExport(old, { now: 0, buildId: 'x' }));

    const fresh2 = fresh();
    expect(await summarizeImport(fresh2, file)).toEqual({
      fileRows: file.reviewLog.length,
      newestTs: file.counts.newestTs,
      notOnDevice: file.reviewLog.length,
    });
    const result = await importBackup(fresh2, file);
    expect(result).toEqual({ added: file.reviewLog.length, differs: [] });
    const [a, b] = [await dump(old), await dump(fresh2)];
    expect(b.reviewLog).toEqual(a.reviewLog);
    expect(b.cardState).toEqual(a.cardState);
    expect(b.daily).toEqual(a.daily);
    expect(b.params).toEqual(a.params);
    expect(b.meta.unlockedThrough).toEqual({ la: 3 });
    old.close();
    fresh2.close();
  });

  it('changes nothing when the same file is imported twice', async () => {
    const src = fresh();
    await study(src, ['a', 'b'], '2026-06-10');
    const file = roundTrip(await buildExport(src, { now: 0, buildId: 'x' }));
    const db = fresh();
    await study(db, ['c'], '2026-06-12');
    await importBackup(db, file);
    const once = await dump(db);
    expect(await importBackup(db, file)).toEqual({ added: 0, differs: [] });
    expect(await dump(db)).toEqual(once);
    src.close();
    db.close();
  });

  it('merges two devices into the union of their histories, in either order', async () => {
    const strict = makeParams({ retention: 0.95 });
    const ipad = fresh();
    const mac = fresh();
    await study(ipad, ['a', 'b'], '2026-06-10');
    await study(mac, ['b', 'c'], '2026-06-20', strict);
    await setMeta(ipad, 'unlockedThrough', { la: 3, el: 1 });
    await setMeta(mac, 'unlockedThrough', { la: 5 });
    await setMeta(ipad, 'settings', { goalMin: 20 });
    await setMeta(mac, 'settings', { goalMin: 30 });
    const fromIpad = roundTrip(await buildExport(ipad, { now: 0, buildId: 'x' }));
    const fromMac = roundTrip(await buildExport(mac, { now: 0, buildId: 'x' }));

    expect((await summarizeImport(ipad, fromMac)).notOnDevice).toBe(fromMac.reviewLog.length);
    await importBackup(ipad, fromMac);
    await importBackup(mac, fromIpad);
    const [i, m] = [await dump(ipad), await dump(mac)];
    expect(i.reviewLog).toEqual(m.reviewLog);
    expect(i.reviewLog).toHaveLength(fromIpad.reviewLog.length + fromMac.reviewLog.length);
    expect(i.cardState).toEqual(m.cardState);
    expect(i.daily).toEqual(m.daily);
    expect(i.daily).toEqual(buildDaily(i.reviewLog));
    expect(new Set(i.params.map((p) => p.id))).toEqual(new Set([DEFAULT_PARAMS.id, strict.id]));
    expect(Object.fromEntries(replay(i.reviewLog, new Map(i.params.map((p) => [p.id, p]))))).toEqual(i.cardState);
    expect(i.meta.unlockedThrough).toEqual({ la: 5, el: 1 });
    expect(m.meta.unlockedThrough).toEqual({ la: 5, el: 1 });
    // Each device keeps its own settings on a merge.
    expect(i.meta.settings).toEqual({ goalMin: 20 });
    expect(m.meta.settings).toEqual({ goalMin: 30 });
    ipad.close();
    mac.close();
  });

  it('warns about cards whose rebuilt state differs from the file', async () => {
    const src = fresh();
    await study(src, ['a', 'b'], '2026-06-10');
    const file = roundTrip(await buildExport(src, { now: 0, buildId: 'x' }));
    file.cardStates.b = { ...file.cardStates.b!, stability: 999 };
    const db = fresh();
    const result = await importBackup(db, file);
    expect(result.differs).toEqual(['b']);
    expect((await getState(db, 'b'))?.stability).not.toBe(999);
    src.close();
    db.close();
  });

  it('replaces everything when asked to', async () => {
    const src = fresh();
    await study(src, ['a'], '2026-06-10');
    await setMeta(src, 'settings', { goalMin: 15 });
    await setMeta(src, 'unlockedThrough', { la: 2 });
    const file = roundTrip(await buildExport(src, { now: 0, buildId: 'x' }));
    const db = fresh();
    await study(db, ['z'], '2026-06-12');
    await setMeta(db, 'settings', { goalMin: 30 });
    await setMeta(db, 'unlockedThrough', { la: 4 });
    await importBackup(db, file, 'replace');
    const [a, b] = [await dump(src), await dump(db)];
    expect(b.reviewLog).toEqual(a.reviewLog);
    expect(b.cardState).toEqual(a.cardState);
    expect(b.daily).toEqual(a.daily);
    expect(b.meta).toEqual(a.meta);
    src.close();
    db.close();
  });
});

describe('reset', () => {
  it('empties every store and every corvus: key, and nothing else', async () => {
    const db = fresh();
    await study(db, ['a', 'b'], '2026-06-10');
    await setMeta(db, 'unlockedThrough', { la: 3 });
    const items = new Map([
      ['corvus:errors', '[]'],
      ['corvus:tab', 'home'],
      ['other-app', 'keep'],
    ]);
    const storage = {
      get length() {
        return items.size;
      },
      key: (i: number) => [...items.keys()][i] ?? null,
      removeItem: (k: string) => void items.delete(k),
    };
    await reset(db, storage);
    expect(await dump(db)).toEqual({ reviewLog: [], cardState: {}, params: [], daily: [], meta: { dbVersion: 1 } });
    expect([...items.keys()]).toEqual(['other-app']);
    db.close();
  });
});

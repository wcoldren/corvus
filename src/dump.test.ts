import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { buildExport, validateBackup } from './backup.ts';
import { Db } from './db/db.ts';
import { getState, recordReview } from './db/history.ts';
import { unlockLesson } from './db/meta.ts';
import { dumpDatabase, openExisting } from './dump.ts';
import { answerRow } from './log.ts';
import { DEFAULT_PARAMS } from './scheduler.ts';
import { zone } from './testing/zones.ts';

const ny = zone('America/New_York');
let n = 0;
const freshName = () => `dump-test-${++n}`;

async function databaseNames(): Promise<string[]> {
  return (await indexedDB.databases()).map((d) => d.name!);
}

async function withOneReview(name: string): Promise<Db> {
  const db = new Db({ name });
  await unlockLesson(db, 'la', 1);
  const card = { id: 'la-01-v-deus', prompt: 'deus', answer: 'god', accept: [] };
  const before = (await getState(db, card.id)) ?? null;
  const { row, after } = answerRow(
    card,
    before,
    { rating: 3, suggested: null, mode: 'reveal', response: null, outcome: 'correct', hintShown: false, answerMs: 1000, totalMs: 2000 },
    DEFAULT_PARAMS,
    { now: Date.UTC(2026, 9, 21, 15), rolloverHour: 4, zone: ny, sessionId: 's1', buildId: 'test' },
  );
  await recordReview(db, row, after, DEFAULT_PARAMS);
  return db;
}

describe('openExisting', () => {
  it('resolves null for a database that does not exist, and does not create one', async () => {
    const name = freshName();
    expect(await openExisting(name)).toBeNull();
    expect(await databaseNames()).not.toContain(name);
    // The app can still create it from scratch afterwards, with every store.
    const db = new Db({ name });
    expect([...(await db.conn()).objectStoreNames]).toContain('reviewLog');
    db.close();
  });

  it('opens an existing database at its own version without upgrading it', async () => {
    const name = freshName();
    const db = await withOneReview(name);
    const version = (await db.conn()).version;
    db.close();
    const conn = await openExisting(name);
    expect(conn?.version).toBe(version);
    conn?.close();
  });
});

describe('dumpDatabase through openExisting', () => {
  it('makes the same backup as Settings, and it validates', async () => {
    const name = freshName();
    const db = await withOneReview(name);
    const fromSettings = await buildExport(db, { now: 1, buildId: 'b' });
    db.close();
    const conn = (await openExisting(name))!;
    const fromRecovery = await dumpDatabase(conn, { now: 1, buildId: 'b' });
    conn.close();
    expect(fromRecovery).toEqual(fromSettings);
    expect(fromRecovery.counts.reviewLog).toBe(1);
    expect(() => validateBackup(JSON.parse(JSON.stringify(fromRecovery)))).not.toThrow();
  });
});

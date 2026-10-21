import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import { DB_VERSION, Db, NotSavedError, STORES, transact } from './db.ts';

let n = 0;
const fresh = (opts: ConstructorParameters<typeof Db>[0] = {}) => new Db({ name: `db-test-${++n}`, ...opts });

describe('migration 0 -> 1', () => {
  it('creates the v1 stores and indexes', async () => {
    const db = fresh();
    const conn = await db.conn();
    expect(conn.version).toBe(1);
    expect(DB_VERSION).toBe(1);
    expect([...conn.objectStoreNames].sort()).toEqual([...STORES].sort());
    const tx = conn.transaction(STORES);
    const log = tx.objectStore('reviewLog');
    expect(log.keyPath).toBe('id');
    expect([...log.indexNames].sort()).toEqual(['byCard', 'byDay', 'byTs']);
    expect(log.index('byCard').keyPath).toBe('cardId');
    expect(log.index('byDay').keyPath).toBe('studyDay');
    expect(log.index('byTs').keyPath).toBe('ts');
    expect(tx.objectStore('cardState').keyPath).toBeNull();
    expect(tx.objectStore('params').keyPath).toBe('id');
    expect(tx.objectStore('daily').keyPath).toBe('day');
    expect(await tx.objectStore('meta').get('dbVersion')).toBe(1);
    db.close();
  });
});

describe('the connection', () => {
  it('reopens and retries a write when the connection has closed underneath it', async () => {
    const db = fresh();
    (await db.conn()).close(); // as iPadOS might, without telling the app
    const fn = vi.fn(async (conn: Awaited<ReturnType<Db['conn']>>) => conn.put('meta', 'x', 'probe'));
    await db.write(fn);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(await db.read((conn) => conn.get('meta', 'probe'))).toBe('x');
    db.close();
  });

  it('gives up after one retry with NotSavedError', async () => {
    const db = fresh();
    const lost = new DOMException('Connection to Indexed Database server lost', 'UnknownError');
    const fn = vi.fn(async () => {
      throw lost;
    });
    const err = await db.write(fn).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotSavedError);
    expect((err as NotSavedError).cause).toBe(lost);
    expect(fn).toHaveBeenCalledTimes(2);
    db.close();
  });

  it('does not retry an error a fresh connection would not fix', async () => {
    const db = fresh();
    const full = vi.fn(async () => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(await db.write(full).catch((e: unknown) => e)).toBeInstanceOf(NotSavedError);
    expect(full).toHaveBeenCalledOnce();
    // Our own errors are not database failures: no retry, no "Not saved".
    const bug = vi.fn(async () => {
      throw new TypeError('bug');
    });
    await expect(db.write(bug)).rejects.toThrow(TypeError);
    expect(bug).toHaveBeenCalledOnce();
    db.close();
  });

  it('rolls back a transaction whose body throws between requests', async () => {
    const db = fresh();
    await db.write((conn) => conn.put('meta', 'kept', 'probe'));
    const failing = db.write((conn) =>
      transact(conn, ['meta'], 'readwrite', async (tx) => {
        await tx.objectStore('meta').clear();
        throw new Error('replay rejected a row');
      }),
    );
    await expect(failing).rejects.toThrow('replay rejected a row');
    expect(await db.read((conn) => conn.get('meta', 'probe'))).toBe('kept');
    db.close();
  });

  it('steps aside for a newer version and asks for a reload', async () => {
    const onBlocking = vi.fn();
    const db = fresh({ onBlocking });
    await db.conn();
    // A newer build opening version 2 would wait forever if this connection held on.
    const newer = await openDB(db.name, DB_VERSION + 1, { upgrade() {} });
    expect(onBlocking).toHaveBeenCalledOnce();
    newer.close();
  });
});

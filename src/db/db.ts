// The IndexedDB database (SPEC.md, Storage and Versioning): its schema, one
// migration per version step, and a connection that reopens once and retries
// when a write fails. iPadOS can close a backgrounded app's connection, so
// the first write after a resume may find it gone.

import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb';
import { Bus } from '../bus.ts';
import { DB_NAME } from '../dump.ts';
import type { DailyRow, LogRow } from '../log.ts';
import type { CardState, Params } from '../scheduler.ts';

export interface CorvusSchema extends DBSchema {
  /** The record of truth, appended to and never changed. */
  reviewLog: {
    key: string;
    value: LogRow;
    indexes: { byCard: string; byDay: string; byTs: number };
  };
  /** A cache of replaying the log, keyed by card id. */
  cardState: { key: string; value: CardState };
  params: { key: string; value: Params };
  daily: { key: string; value: DailyRow };
  /** Settings, `unlockedThrough`, the last export date and `dbVersion`, keyed by name. */
  meta: { key: string; value: unknown };
}

export type Conn = IDBPDatabase<CorvusSchema>;
type UpgradeTx = IDBPTransaction<CorvusSchema, StoreNames<CorvusSchema>[], 'versionchange'>;

export const STORES = ['reviewLog', 'cardState', 'params', 'daily', 'meta'] as const satisfies StoreNames<CorvusSchema>[];

/**
 * MIGRATIONS[n] upgrades version n to n + 1. Versions only go up, and each
 * step gets its own test.
 */
const MIGRATIONS: ((db: Conn, tx: UpgradeTx) => void)[] = [
  // 0 -> 1: the v1 stores.
  (db) => {
    const log = db.createObjectStore('reviewLog', { keyPath: 'id' });
    log.createIndex('byCard', 'cardId');
    log.createIndex('byDay', 'studyDay');
    log.createIndex('byTs', 'ts');
    db.createObjectStore('cardState');
    db.createObjectStore('params', { keyPath: 'id' });
    db.createObjectStore('daily', { keyPath: 'day' });
    db.createObjectStore('meta');
  },
];

export const DB_VERSION = MIGRATIONS.length;

export type Tx<Mode extends IDBTransactionMode> = IDBPTransaction<CorvusSchema, StoreNames<CorvusSchema>[], Mode>;

/**
 * Run `body` in one transaction and wait for it to commit. If `body` throws,
 * the transaction is aborted, so nothing it wrote commits. Without this, an
 * error thrown by our own code between requests (a replay that rejects a
 * row, say) leaves the transaction to commit whatever it had already done.
 */
export async function transact<T, Mode extends IDBTransactionMode>(
  conn: Conn,
  stores: readonly StoreNames<CorvusSchema>[],
  mode: Mode,
  body: (tx: Tx<Mode>) => Promise<T>,
): Promise<T> {
  const tx = conn.transaction([...stores], mode) as Tx<Mode>;
  try {
    const result = await body(tx);
    await tx.done;
    return result;
  } catch (e) {
    try {
      tx.abort();
    } catch {
      // Already finished or aborted.
    }
    await tx.done.catch(() => {});
    throw e;
  }
}

/** Empty every store, leaving the database as a fresh one would be. */
export async function clearAll(tx: Tx<'readwrite'>): Promise<void> {
  await Promise.all(STORES.map((s) => tx.objectStore(s).clear()));
  await tx.objectStore('meta').put(DB_VERSION, 'dbVersion');
}

/**
 * Errors that mean the connection went away (iPadOS closing a backgrounded
 * app's connection shows up as one of these), so a fresh one may succeed.
 */
const CONNECTION_LOST = new Set(['InvalidStateError', 'UnknownError', 'AbortError']);
const isDbError = (e: unknown): e is DOMException => e instanceof DOMException;
const isConnectionLost = (e: unknown) => isDbError(e) && CONNECTION_LOST.has(e.name);

/** Thrown when the database refused a write, or a lost connection failed again on a fresh one. */
export class NotSavedError extends Error {
  constructor(cause: unknown) {
    super('Not saved. Reload.', { cause });
    this.name = 'NotSavedError';
  }
}

export interface DbOptions {
  /** Tests pass their own name, so each gets a fresh database. */
  name?: string;
  bus?: Bus;
  /**
   * Called when a newer version of the app wants to upgrade the database and
   * this connection is in the way. The connection is already closed; the app
   * should ask for a reload.
   */
  onBlocking?: () => void;
}

export class Db {
  readonly name: string;
  readonly bus: Bus;
  #onBlocking: () => void;
  #conn: Promise<Conn> | null = null;

  constructor(opts: DbOptions = {}) {
    this.name = opts.name ?? DB_NAME;
    this.bus = opts.bus ?? new Bus();
    this.#onBlocking = opts.onBlocking ?? (() => {});
  }

  /** The open connection, opening (and upgrading) the database if need be. */
  conn(): Promise<Conn> {
    this.#conn ??= openDB<CorvusSchema>(this.name, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        for (let v = oldVersion; v < DB_VERSION; v++) MIGRATIONS[v]!(db, tx);
        void tx.objectStore('meta').put(DB_VERSION, 'dbVersion');
      },
      blocking: () => {
        this.close();
        this.#onBlocking();
      },
      // The browser closed the connection (iPadOS may, in the background).
      terminated: () => {
        this.#conn = null;
      },
    }).catch((e: unknown) => {
      this.#conn = null;
      throw e;
    });
    return this.#conn;
  }

  close(): void {
    const conn = this.#conn;
    this.#conn = null;
    void conn?.then((c) => c.close(), () => {});
  }

  /** Run `fn`, and once more on a fresh connection if the first one was lost. */
  async #withReopen<T>(fn: (db: Conn) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.conn());
    } catch (e) {
      if (!isConnectionLost(e)) throw e;
      this.close();
      return fn(await this.conn());
    }
  }

  read<T>(fn: (db: Conn) => Promise<T>): Promise<T> {
    return this.#withReopen(fn);
  }

  /**
   * Run a write. A lost connection is reopened and the write run once more
   * with the same arguments, so `fn` must be safe to repeat. Any database
   * error left after that becomes NotSavedError, for the "Not saved. Reload."
   * banner. Errors from our own code (a bug, a deliberate refusal) are not
   * retried and pass through unchanged, since retrying or reloading can't
   * fix them.
   */
  async write<T>(fn: (db: Conn) => Promise<T>): Promise<T> {
    try {
      return await this.#withReopen(fn);
    } catch (e) {
      throw isDbError(e) ? new NotSavedError(e) : e;
    }
  }
}

// The IndexedDB database (SPEC.md, Storage and Versioning): its schema, one
// migration per version step, and a connection that reopens once and retries
// when a write fails. iPadOS can close a backgrounded app's connection, so
// the first write after a resume may find it gone.

import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb';
import { Bus } from '../bus.ts';
import type { DailyRow, LogRow } from '../log.ts';
import type { CardState, Params } from '../scheduler.ts';

export const DB_NAME = 'corvus';

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

/** Thrown when a write failed, was retried on a fresh connection, and failed again. */
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

  /** Run a read, reopening once if the connection has gone. */
  async read<T>(fn: (db: Conn) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.conn());
    } catch {
      this.close();
      return fn(await this.conn());
    }
  }

  /**
   * Run a write. If it fails, drop the connection, reopen, and run it once
   * more with the same arguments, so `fn` must be safe to repeat. If that
   * fails too, throw NotSavedError for the "Not saved. Reload." banner.
   */
  async write<T>(fn: (db: Conn) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.conn());
    } catch {
      this.close();
      try {
        return await fn(await this.conn());
      } catch (e) {
        throw new NotSavedError(e);
      }
    }
  }
}

// Reading the database into a backup file (SPEC.md, Export). This is kept
// apart from backup.ts, and depends at run time only on idb and day.ts, so
// the recovery screen can export even when the rest of the app fails to
// load (SPEC.md, Recovery). Settings exports through the same function.

import { openDB } from 'idb';
import type { Conn } from './db/db.ts';
import { localZone, studyDay, type Zone } from './day.ts';
import type { LogRow } from './log.ts';
import type { Unlocked } from './queue.ts';
import type { CardState, Params } from './scheduler.ts';

export const DB_NAME = 'corvus';
export const BACKUP_FORMAT = 'corvus-backup';
export const BACKUP_VERSION = 1;

export interface Backup {
  format: typeof BACKUP_FORMAT;
  formatVersion: typeof BACKUP_VERSION;
  exportedAt: number;
  buildId: string;
  dbVersion: number;
  settings: Record<string, unknown> | null;
  unlockedThrough: Unlocked;
  params: Params[];
  /** The content. Everything else in the file can be rebuilt from it or is small. */
  reviewLog: LogRow[];
  /** For checking an import against; never imported as such. */
  cardStates: Record<string, CardState>;
  counts: { reviewLog: number; cardStates: number; params: number; newestTs: number | null };
}

/** The whole database as a backup, read in one transaction so it is consistent. */
export async function dumpDatabase(conn: Conn, opts: { now: number; buildId: string }): Promise<Backup> {
  const tx = conn.transaction(['reviewLog', 'params', 'cardState', 'meta'], 'readonly');
  const states = tx.objectStore('cardState');
  const [reviewLog, params, stateKeys, stateValues, settings, unlocked] = await Promise.all([
    tx.objectStore('reviewLog').index('byTs').getAll(),
    tx.objectStore('params').getAll(),
    states.getAllKeys(),
    states.getAll(),
    tx.objectStore('meta').get('settings'),
    tx.objectStore('meta').get('unlockedThrough'),
  ]);
  await tx.done;
  const cardStates = Object.fromEntries(stateKeys.map((k, i) => [k, stateValues[i]!]));
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_VERSION,
    exportedAt: opts.now,
    buildId: opts.buildId,
    dbVersion: conn.version,
    settings: (settings as Backup['settings'] | undefined) ?? null,
    unlockedThrough: (unlocked as Unlocked | undefined) ?? {},
    params,
    reviewLog,
    cardStates,
    counts: {
      reviewLog: reviewLog.length,
      cardStates: stateKeys.length,
      params: params.length,
      newestTs: reviewLog.at(-1)?.ts ?? null,
    },
  };
}

/**
 * Open the database as it is, for the recovery screen: no version, so no
 * migration runs, and a database that doesn't exist yet is not created
 * (an empty one at version 1 would make the app skip its first migration).
 * Resolves null when there is no database.
 */
export async function openExisting(name: string = DB_NAME): Promise<Conn | null> {
  let created = false;
  try {
    return await openDB(name, undefined, {
      upgrade(_db, _old, _new, tx) {
        created = true;
        // The abort is the intended outcome; openDB reports it below.
        tx.done.catch(() => {});
        tx.abort();
      },
    }) as unknown as Conn;
  } catch (e) {
    if (created) return null;
    throw e;
  }
}

/** `corvus-backup-YYYY-MM-DD.json`, by the local calendar date. */
export function backupFileName(now: number, zone: Zone = localZone): string {
  return `corvus-backup-${studyDay(now, 0, zone)}.json`;
}

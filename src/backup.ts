// Export, import and Reset (SPEC.md, Export, and Import and reset). The
// screens that drive these (Prepare backup, Share, the import summary, the
// typed confirmations) come later; this module is what they call.
//
// An export is the whole log plus the little that can't be rebuilt from it
// (settings, unlocked lessons, scheduler configs). Importing merges by row
// id, so the same file imported twice changes nothing, and two devices'
// files can be merged in either order. Card state and daily totals are then
// rebuilt by replaying the merged log, never copied from the file.

import { STORES, clearAll, transact, type Db, type Tx } from './db/db.ts';
import { BACKUP_FORMAT, BACKUP_VERSION, dumpDatabase, type Backup } from './dump.ts';
import { LOG_FIELDS, LOG_KINDS, LOG_V, MANUAL_ACTIONS, buildDaily, replay, type LogRow } from './log.ts';
import type { Unlocked } from './queue.ts';
import type { CardState, Params } from './scheduler.ts';

export { BACKUP_FORMAT, BACKUP_VERSION, backupFileName, type Backup } from './dump.ts';

/** The whole database as a backup (dump.ts, shared with the recovery screen). */
export function buildExport(db: Db, opts: { now: number; buildId: string }): Promise<Backup> {
  return db.read((conn) => dumpDatabase(conn, opts));
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

const KINDS = new Set<string>(LOG_KINDS);
const ACTIONS = new Set<string>(MANUAL_ACTIONS);
const PHASES = new Set(['learning', 'review', 'relearning']);
const STATE_NUMBERS = ['due', 'lastReview', 'stability', 'difficulty', 'scheduledDays', 'learningSteps', 'reps', 'lapses'];
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function isCardState(x: unknown): x is CardState {
  return isObject(x) && PHASES.has(x.phase as string) && STATE_NUMBERS.every((k) => isNumber(x[k]));
}

/**
 * Check a parsed file before anything is written, so a bad file is refused
 * with a reason instead of failing halfway through the import. It checks the
 * format and version, every log field on every row, that no row appears
 * twice, the values replay depends on (ratings, times, shifts, states), and
 * a config for every review.
 */
export function validateBackup(data: unknown): Backup {
  const fail = (why: string): never => {
    throw new BackupError(`Not a Corvus backup this version can read: ${why}.`);
  };
  if (!isObject(data) || data.format !== BACKUP_FORMAT) fail('the format marker is missing');
  const d = data as Record<string, unknown>;
  if (typeof d.formatVersion !== 'number') fail('no format version');
  if ((d.formatVersion as number) > BACKUP_VERSION) fail(`it was made by a newer version (format ${d.formatVersion})`);
  if (d.formatVersion !== BACKUP_VERSION) fail(`unknown format version ${d.formatVersion}`);
  if (!Array.isArray(d.reviewLog) || !Array.isArray(d.params)) fail('the log or the configs are missing');
  if (!isObject(d.cardStates) || !isObject(d.unlockedThrough) || !isObject(d.counts)) fail('a section is missing');
  if (d.settings !== null && !isObject(d.settings)) fail('settings are not an object');
  const log = d.reviewLog as unknown[];
  if ((d.counts as Record<string, unknown>).reviewLog !== log.length) fail('the log is shorter or longer than its count');
  for (const [lang, n] of Object.entries(d.unlockedThrough as object)) {
    if (!Number.isInteger(n)) fail(`unlockedThrough.${lang} is not a lesson number`);
  }

  for (const [id, s] of Object.entries(d.cardStates as object)) {
    if (!isCardState(s)) fail(`the state of card ${id} is malformed`);
  }

  const paramIds = new Set<string>();
  for (const p of d.params as unknown[]) {
    if (!isObject(p) || typeof p.id !== 'string' || !Array.isArray(p.w) || !p.w.every(isNumber) || !isNumber(p.retention)) {
      fail('a scheduler config is malformed');
    }
    paramIds.add((p as Params).id);
  }
  const ids = new Set<string>();
  for (const [i, r] of log.entries()) {
    if (!isObject(r)) fail(`log row ${i} is not an object`);
    const row = r as Record<string, unknown>;
    const missing = LOG_FIELDS.filter((f) => !(f in row));
    if (missing.length) fail(`log row ${i} lacks ${missing.join(', ')}`);
    if (row.v !== LOG_V) fail(`log row ${i} has row version ${String(row.v)}`);
    if (typeof row.id !== 'string' || typeof row.cardId !== 'string' || typeof row.studyDay !== 'string') {
      fail(`log row ${i} has a malformed id, card or day`);
    }
    if (ids.has(row.id as string)) fail(`log row ${String(row.id)} appears twice`);
    ids.add(row.id as string);
    if (!isNumber(row.ts) || !isNumber(row.shiftMin)) fail(`log row ${i} has a malformed time or shift`);
    if (!KINDS.has(row.kind as string)) fail(`log row ${i} has unknown kind ${String(row.kind)}`);
    if (row.kind === 'review') {
      if (![1, 2, 3, 4].includes(row.rating as number)) fail(`log row ${i} has rating ${String(row.rating)}`);
      if (!isNumber(row.totalMs)) fail(`log row ${i} has a malformed time taken`);
      if (row.before !== null && !isCardState(row.before)) fail(`log row ${i} has a malformed before state`);
      if (!paramIds.has(row.paramsId as string)) fail(`log row ${i} uses a config the file lacks`);
    }
    if (row.kind === 'undo' && typeof row.undoes !== 'string') fail(`undo row ${i} names no row`);
    if (row.kind === 'manual' && !ACTIONS.has(row.action as string)) fail(`manual row ${i} has unknown action`);
  }
  return d as unknown as Backup;
}

export interface ImportSummary {
  fileRows: number;
  newestTs: number | null;
  /** Rows in the file that this device doesn't have. */
  notOnDevice: number;
}

/** What an import would bring in, for the confirm screen. Writes nothing. */
export async function summarizeImport(db: Db, backup: Backup): Promise<ImportSummary> {
  const have = new Set(await db.read((conn) => conn.getAllKeys('reviewLog')));
  return {
    fileRows: backup.reviewLog.length,
    newestTs: backup.counts.newestTs,
    notOnDevice: backup.reviewLog.filter((r) => !have.has(r.id)).length,
  };
}

export interface ImportResult {
  added: number;
  /** Cards whose state rebuilt from the merged log differs from the file's. */
  differs: string[];
}

function sameState(a: CardState, b: CardState): boolean {
  return (Object.keys(a) as (keyof CardState)[]).every((k) => a[k] === b[k]) && Object.keys(a).length === Object.keys(b).length;
}

/**
 * Bring a validated backup in. The app forces an export of the current data
 * before calling this.
 *
 * `merge` (the default) keeps everything on the device and adds the file's
 * rows and configs it lacks, takes the higher unlocked lesson per language,
 * and keeps the device's settings. `replace` (behind a second, typed
 * confirmation) makes the database exactly the file. Either way, card state
 * and daily totals are rebuilt from the resulting log, all in one transaction.
 */
export async function importBackup(db: Db, backup: Backup, mode: 'merge' | 'replace' = 'merge'): Promise<ImportResult> {
  const { added, states } = await db.write((conn) => transact(conn, STORES, 'readwrite', async (tx) => {
    const logStore = tx.objectStore('reviewLog');
    const paramStore = tx.objectStore('params');
    const meta = tx.objectStore('meta');

    // If anything below throws (replay rejecting a row, say), transact
    // aborts, and the wipe is rolled back with the rest.
    if (mode === 'replace') await clearAll(tx);
    const [deviceRows, deviceParams, deviceUnlocked] = await Promise.all([
      logStore.getAll(),
      paramStore.getAll(),
      meta.get('unlockedThrough') as Promise<Unlocked | undefined>,
    ]);

    const have = new Set(deviceRows.map((r) => r.id));
    const newRows = backup.reviewLog.filter((r) => !have.has(r.id));
    const params = new Map([...deviceParams, ...backup.params].map((p) => [p.id, p]));
    const unlocked: Unlocked = { ...deviceUnlocked };
    for (const [lang, n] of Object.entries(backup.unlockedThrough)) unlocked[lang] = Math.max(unlocked[lang] ?? 0, n);

    await Promise.all([
      ...newRows.map((r) => logStore.add(r)),
      ...backup.params.map((p) => paramStore.put(p)),
      meta.put(unlocked, 'unlockedThrough'),
      ...(mode === 'replace' && backup.settings ? [meta.put(backup.settings, 'settings')] : []),
    ]);
    const states = await rewriteCaches(tx, [...deviceRows, ...newRows], params);
    return { added: newRows.length, states };
  }));

  // Outside the write: the import has committed, and nothing here should
  // make it look as if it hadn't.
  const differs = Object.entries(backup.cardStates)
    .filter(([id, s]) => {
      const rebuilt = states.get(id);
      return !rebuilt || !sameState(rebuilt, s);
    })
    .map(([id]) => id);
  return { added, differs };
}

/**
 * Replace every card state and daily total with a replay of `rows`, inside
 * the caller's transaction. Replay is synchronous, so the transaction stays
 * open across it.
 */
async function rewriteCaches(tx: Tx<'readwrite'>, rows: LogRow[], params: ReadonlyMap<string, Params>): Promise<Map<string, CardState>> {
  const states = replay(rows, params);
  const daily = buildDaily(rows);
  const stateStore = tx.objectStore('cardState');
  const dailyStore = tx.objectStore('daily');
  await Promise.all([stateStore.clear(), dailyStore.clear()]);
  await Promise.all([...[...states].map(([id, s]) => stateStore.put(s, id)), ...daily.map((d) => dailyStore.put(d))]);
  return states;
}

export interface RebuildResult {
  /** Cards with state after the rebuild. */
  cards: number;
  /** Cards whose state the rebuild changed, added or removed. */
  changed: number;
}

/**
 * "Rebuild schedule" (SPEC.md, Storage): recompute every card's state and
 * every day's totals from the log, which is the record of truth. Normally
 * this changes nothing; a non-zero `changed` means the cache had drifted.
 */
export async function rebuildSchedule(db: Db): Promise<RebuildResult> {
  return db.write((conn) =>
    transact(conn, ['reviewLog', 'params', 'cardState', 'daily'], 'readwrite', async (tx) => {
      const [rows, params, keys, values] = await Promise.all([
        tx.objectStore('reviewLog').getAll(),
        tx.objectStore('params').getAll(),
        tx.objectStore('cardState').getAllKeys(),
        tx.objectStore('cardState').getAll(),
      ]);
      const before = new Map(keys.map((k, i) => [k, values[i]!]));
      const after = await rewriteCaches(tx, rows, new Map(params.map((p) => [p.id, p])));
      let changed = 0;
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        const a = before.get(id);
        const b = after.get(id);
        if (!a || !b || !sameState(a, b)) changed++;
      }
      return { cards: after.size, changed };
    }),
  );
}

/** localStorage, or null where it is missing or reading it throws. */
function localStore(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Delete all history: empty every store and remove every `corvus:` local
 * storage key. The app forces an export and a typed confirmation first.
 * Caches are left alone. The stores are emptied rather than the database
 * deleted, because deleting waits on every open connection (another tab, a
 * stale one) and would hang where emptying doesn't.
 */
export async function reset(db: Db, storage: Pick<Storage, 'length' | 'key' | 'removeItem'> | null = localStore()): Promise<void> {
  await db.write((conn) => transact(conn, STORES, 'readwrite', clearAll));
  if (!storage) return;
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k?.startsWith('corvus:')) keys.push(k);
  }
  for (const k of keys) storage.removeItem(k);
}

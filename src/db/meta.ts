// The small records in the `meta` store: settings, the unlocked lessons and
// the last export date (SPEC.md, Storage).

import type { Unlocked } from '../queue.ts';
import { withDefaults, type Settings } from '../settings.ts';
import { transact, type Db } from './db.ts';

export async function getSettings(db: Db): Promise<Settings> {
  return withDefaults(await db.read((conn) => conn.get('meta', 'settings')));
}

export async function getUnlocked(db: Db): Promise<Unlocked> {
  return ((await db.read((conn) => conn.get('meta', 'unlockedThrough'))) as Unlocked | undefined) ?? {};
}

/** When the last export was made, epoch ms, or null if there hasn't been one. */
export async function getLastExport(db: Db): Promise<number | null> {
  return ((await db.read((conn) => conn.get('meta', 'lastExport'))) as number | undefined) ?? null;
}

/** Record a backup that reached the learner (shared or downloaded), for the export reminder. */
export async function setLastExport(db: Db, ts: number): Promise<void> {
  await db.write((conn) => conn.put('meta', ts, 'lastExport'));
}

/**
 * Unlock a language's cards through `lesson` (SPEC.md, Unlock). The number
 * only ever goes up, so a repeated tap, a retry or a stale screen asking
 * for a lower lesson changes nothing; the UI offers no way back down.
 * Returns the lesson now unlocked through. The bus hears about it only
 * after the write commits, and only if something changed.
 */
export async function unlockLesson(db: Db, language: string, lesson: number): Promise<number> {
  const [before, after] = await db.write((conn) =>
    transact(conn, ['meta'], 'readwrite', async (tx) => {
      const meta = tx.objectStore('meta');
      const unlocked = ((await meta.get('unlockedThrough')) as Unlocked | undefined) ?? {};
      const was = unlocked[language] ?? 0;
      if (lesson > was) await meta.put({ ...unlocked, [language]: lesson }, 'unlockedThrough');
      return [was, Math.max(was, lesson)] as const;
    }),
  );
  if (after > before) db.bus.emit('lesson:unlocked', { language, lesson: after });
  return after;
}

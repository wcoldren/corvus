import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { Bus } from '../bus.ts';
import { loadCards } from '../cards/load.ts';
import { lessonToUnlock } from '../queue.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import { Db } from './db.ts';
import { getLastExport, getSettings, getUnlocked, unlockLesson } from './meta.ts';

let n = 0;
const fresh = (bus = new Bus()) => new Db({ name: `meta-test-${++n}`, bus });

describe('unlockLesson', () => {
  it('starts with nothing unlocked, and unlocks per language', async () => {
    const db = fresh();
    expect(await getUnlocked(db)).toEqual({});
    expect(await unlockLesson(db, 'la', 1)).toBe(1);
    expect(await unlockLesson(db, 'el', 2)).toBe(2);
    expect(await getUnlocked(db)).toEqual({ la: 1, el: 2 });
    db.close();
  });

  it('only goes up, and tells the bus only when it does, after the write', async () => {
    const bus = new Bus();
    const db = fresh(bus);
    const heard: unknown[] = [];
    bus.on('lesson:unlocked', (p) => heard.push({ ...p, stored: getUnlocked(db) }));
    await unlockLesson(db, 'la', 3);
    expect(await unlockLesson(db, 'la', 3)).toBe(3);
    expect(await unlockLesson(db, 'la', 2)).toBe(3);
    expect(await getUnlocked(db)).toEqual({ la: 3 });
    expect(heard).toHaveLength(1);
    const first = heard[0] as { language: string; lesson: number; stored: Promise<unknown> };
    expect(first).toMatchObject({ language: 'la', lesson: 3 });
    expect(await first.stored).toEqual({ la: 3 });
    db.close();
  });
});

describe('meta reads', () => {
  it('fills in default settings and reads the last export', async () => {
    const db = fresh();
    expect(await getSettings(db)).toEqual(DEFAULT_SETTINGS);
    expect(await getLastExport(db)).toBeNull();
    await db.write(async (conn) => {
      await conn.put('meta', { maxNew: 12 }, 'settings');
      await conn.put('meta', 1_700_000_000_000, 'lastExport');
    });
    expect(await getSettings(db)).toEqual({ ...DEFAULT_SETTINGS, maxNew: 12 });
    expect(await getLastExport(db)).toBe(1_700_000_000_000);
    db.close();
  });
});

describe('lessonToUnlock', () => {
  const file = (lesson: number, language = 'la') => ({
    language,
    lesson,
    unit: 1,
    title: '',
    cards: [{ id: `c${lesson}${language}`, type: 'concept' as const, prompt: 'p', answer: 'a' }],
  });
  const cards = loadCards([file(1), file(2), file(5), file(9, 'el')]);

  it('offers the lowest deployed lesson above the unlocked one, skipping gaps', () => {
    expect(lessonToUnlock(cards, {}, 'la')).toBe(1);
    expect(lessonToUnlock(cards, { la: 1 }, 'la')).toBe(2);
    expect(lessonToUnlock(cards, { la: 2 }, 'la')).toBe(5);
  });

  it('offers nothing once every deployed lesson is unlocked', () => {
    expect(lessonToUnlock(cards, { la: 5 }, 'la')).toBeNull();
    expect(lessonToUnlock(cards, { la: 7 }, 'la')).toBeNull();
    expect(lessonToUnlock(cards, {}, 'el')).toBe(9);
  });
});

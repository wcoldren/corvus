// What Home shows (SPEC.md, Screens: Home). The numbers come from aggregates:
// card states (one per card, not per review), today's row of the `daily`
// store, and a bounded walk back over the newest log rows. Nothing here reads
// the whole log, so Home stays quick after years of reviews.

import type { Card } from './cards/types.ts';
import { clockBehind, localZone, studyDay, type Zone } from './day.ts';
import { transact, type Db } from './db/db.ts';
import { emptyDaily, type DailyCounts } from './log.ts';
import { buildQueue, inSessions, lessonToUnlock, type Unlocked } from './queue.ts';
import type { CardState } from './scheduler.ts';
import { withDefaults, type Settings } from './settings.ts';

/** How many recent reviews the per-review time is averaged over. */
export const RECENT_REVIEWS = 500;
/** Each review's time is capped at this before averaging, so a card left open over lunch doesn't count. */
export const REVIEW_MS_CAP = 60_000;
/** The per-review time assumed before there is any history. */
export const DEFAULT_SEC_PER_REVIEW = 12;
/** Home reminds the learner to export after this long without one. */
export const EXPORT_REMIND_MS = 7 * 86_400_000;

/** What the database holds that Home needs, read in one transaction. */
export interface HomeData {
  settings: Settings;
  unlocked: Unlocked;
  states: Map<string, CardState>;
  today: DailyCounts;
  /** `totalMs` of the newest reviews (up to RECENT_REVIEWS), undone ones left out. */
  recentMs: number[];
  newestTs: number | null;
  oldestTs: number | null;
  lastExport: number | null;
}

export async function loadHomeData(db: Db, now: number, zone: Zone = localZone): Promise<HomeData> {
  return db.read((conn) =>
    transact(conn, ['meta', 'cardState', 'daily', 'reviewLog'], 'readonly', async (tx) => {
      const meta = tx.objectStore('meta');
      const [stored, unlocked, lastExport, keys, values] = await Promise.all([
        meta.get('settings'),
        meta.get('unlockedThrough') as Promise<Unlocked | undefined>,
        meta.get('lastExport') as Promise<number | undefined>,
        tx.objectStore('cardState').getAllKeys(),
        tx.objectStore('cardState').getAll(),
      ]);
      const settings = withDefaults(stored);
      const day = studyDay(now, settings.rolloverHour, zone);
      const today = (await tx.objectStore('daily').get(day)) ?? emptyDaily(day);
      const byTs = tx.objectStore('reviewLog').index('byTs');
      const oldest = await byTs.openCursor(null, 'next');

      // Walk back from the newest row until enough reviews are found. An undo
      // row comes after the answer it undoes, so it is met first and the
      // answer can be skipped when it turns up.
      const recentMs: number[] = [];
      const undone = new Set<string>();
      let newestTs: number | null = null;
      let cur = await byTs.openCursor(null, 'prev');
      while (cur && recentMs.length < RECENT_REVIEWS) {
        const r = cur.value;
        newestTs ??= r.ts;
        if (r.kind === 'undo') undone.add(r.undoes);
        else if (r.kind === 'review' && !undone.has(r.id)) recentMs.push(r.totalMs);
        if (recentMs.length < RECENT_REVIEWS) cur = await cur.continue();
      }

      const { day: _day, ...counts } = today;
      return {
        settings,
        unlocked: unlocked ?? {},
        states: new Map(keys.map((k, i) => [k, values[i]!])),
        today: counts,
        recentMs,
        newestTs,
        oldestTs: oldest?.value.ts ?? null,
        lastExport: lastExport ?? null,
      };
    }),
  );
}

/** Lessons A to B hold X new cards beyond today's, about D days' worth at this pace. */
export interface Waiting {
  cards: number;
  fromLesson: number;
  toLesson: number;
  /** Null when no new cards are introduced at all (maxNew 0). */
  days: number | null;
}

export interface HomeModel {
  studyDay: string;
  /** Reviews in today's session plus learning cards due before the rollover. */
  dueToday: number;
  /** About how long the due cards take, in whole minutes. */
  dueMin: number;
  /** Reviews due today that the daily cap holds back for tomorrow. */
  overCap: number;
  newToday: number;
  waiting: Waiting | null;
  /** The lesson to offer to unlock, or null when all are unlocked. */
  unlock: number | null;
  /** The mean seconds per review the estimates use. */
  secPerReview: number;
  exportReminder: boolean;
  clockBehind: boolean;
}

/** The mean seconds per review over the recent reviews, each capped; the default before there are any. */
export function secPerReview(recentMs: readonly number[]): number {
  if (!recentMs.length) return DEFAULT_SEC_PER_REVIEW;
  const total = recentMs.reduce((sum, ms) => sum + Math.min(ms, REVIEW_MS_CAP), 0);
  return total / recentMs.length / 1000;
}

export function homeModel(
  cards: readonly Card[],
  data: HomeData,
  language: string,
  now: number,
  zone: Zone = localZone,
): HomeModel {
  const { settings, unlocked, states, today } = data;
  const mine = cards.filter((c) => c.language === language);
  const plan = buildQueue({ cards: mine, states, today, unlocked, settings, now, zone });
  const perReview = secPerReview(data.recentMs);
  const dueToday = plan.reviews + plan.learningDue;

  // New cards in unlocked lessons, after the ones today's plan takes.
  const through = unlocked[language] ?? 0;
  const fresh = mine.filter((c) => c.lesson <= through && inSessions(c) && !states.has(c.id));
  const left = fresh.slice(plan.newCards);
  const waiting: Waiting | null = left.length
    ? {
        cards: left.length,
        fromLesson: left[0]!.lesson,
        toLesson: left.at(-1)!.lesson,
        days: settings.maxNew > 0 ? Math.ceil(left.length / settings.maxNew) : null,
      }
    : null;

  // Before the first export, the reminder counts from the first review.
  const exportFrom = data.lastExport ?? data.oldestTs;

  return {
    studyDay: plan.studyDay,
    dueToday,
    dueMin: Math.round((dueToday * perReview) / 60),
    overCap: plan.overCap,
    newToday: plan.newCards,
    waiting,
    unlock: lessonToUnlock(mine, unlocked, language),
    secPerReview: perReview,
    exportReminder: exportFrom !== null && now - exportFrom >= EXPORT_REMIND_MS,
    clockBehind: clockBehind(now, data.newestTs),
  };
}

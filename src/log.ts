// The review log (SPEC.md, The review log row). The log is the record of
// truth: rows are appended and never changed, and every card's state can be
// rebuilt by replaying them. The `cardState` store is only a cache of that
// replay, which is why undo appends a row instead of deleting one, and why
// exports from two devices merge by taking the union of their rows.

import type { Card, Mode } from './cards/types.ts';
import { localZone, reviewTime, shiftMin, studyDay, type Zone } from './day.ts';
import { shortHash } from './hash.ts';
import { elapsedDays, review, type CardState, type Params, type Rating } from './scheduler.ts';

export const LOG_V = 1;

export type Outcome = 'correct' | 'slip' | 'wrongForm' | 'wrong' | 'revealed';
export type ManualAction = 'suspend' | 'unsuspend' | 'flag' | 'unflag' | 'forget';

/** Fields every row has, whatever its kind. */
interface RowBase {
  id: string;
  v: typeof LOG_V;
  cardId: string;
  /** The time used, epoch ms: for a review, clamped after the card's last review. */
  ts: number;
  /** The raw clock reading, or null when it equals `ts`. */
  wallTs: number | null;
  studyDay: string;
  shiftMin: number;
  /** The local UTC offset at `ts`, minutes east of UTC (New York in summer is -240). */
  tzOffsetMin: number;
  sessionId: string | null;
  buildId: string;
}

/** The review fields, which are null on undo and manual rows. */
interface ReviewFields {
  rating: Rating;
  /** The app's suggested rating, or null for a self-graded card. */
  suggested: Rating | null;
  mode: Mode;
  /** The typed text, the tapped cells, or null. */
  response: string | string[] | null;
  outcome: Outcome;
  hintShown: boolean;
  /** Prompt to submit, and prompt to rating. */
  answerMs: number;
  totalMs: number;
  /** The card's state before this review, or null for a new card. */
  before: CardState | null;
  paramsId: string;
  cardHash: string;
}

type Nulled<T> = { [K in keyof T]: null };

/**
 * Every row carries every field, null where it doesn't apply, so an export
 * can be checked field by field (acceptance criterion 4).
 */
export interface ReviewRow extends RowBase, ReviewFields {
  kind: 'review';
  undoes: null;
  action: null;
  note: null;
}

export interface UndoRow extends RowBase, Nulled<ReviewFields> {
  kind: 'undo';
  /** The id of the review row this undoes. */
  undoes: string;
  action: null;
  note: null;
}

export interface ManualRow extends RowBase, Nulled<ReviewFields> {
  kind: 'manual';
  undoes: null;
  action: ManualAction;
  /** A note on a flag; otherwise null. */
  note: string | null;
}

export type LogRow = ReviewRow | UndoRow | ManualRow;

/** Every field of a v1 row, for checking imported and exported rows. */
export const LOG_FIELDS = [
  'id', 'v', 'cardId', 'kind', 'ts', 'wallTs', 'studyDay', 'shiftMin', 'tzOffsetMin',
  'rating', 'suggested', 'mode', 'response', 'outcome', 'hintShown', 'answerMs', 'totalMs',
  'before', 'paramsId', 'cardHash', 'sessionId', 'buildId', 'undoes', 'action', 'note',
] as const satisfies readonly (keyof ReviewRow)[];

const NO_REVIEW: Nulled<ReviewFields> = {
  rating: null,
  suggested: null,
  mode: null,
  response: null,
  outcome: null,
  hintShown: null,
  answerMs: null,
  totalMs: null,
  before: null,
  paramsId: null,
  cardHash: null,
};

/** Where and when a row is written. `id` is only passed by tests. */
export interface RowContext {
  now: number;
  rolloverHour: number;
  zone?: Zone;
  sessionId: string | null;
  buildId: string;
  id?: string;
}

/** What the review screen knows once the learner has rated a card. */
export interface Answer {
  rating: Rating;
  suggested: Rating | null;
  mode: Mode;
  response: string | string[] | null;
  outcome: Outcome;
  hintShown: boolean;
  answerMs: number;
  totalMs: number;
}

function base(cardId: string, ts: number, ctx: RowContext): RowBase {
  const zone = ctx.zone ?? localZone;
  return {
    id: ctx.id ?? crypto.randomUUID(),
    v: LOG_V,
    cardId,
    ts,
    wallTs: ts === ctx.now ? null : ctx.now,
    studyDay: studyDay(ts, ctx.rolloverHour, zone),
    shiftMin: shiftMin(ts, ctx.rolloverHour, zone),
    tzOffsetMin: zone(ts),
    sessionId: ctx.sessionId,
    buildId: ctx.buildId,
  };
}

/**
 * A short hash of what the card asked and accepted when it was reviewed, so
 * later analysis can tell which reviews saw an edited card's old text.
 */
export function cardHash(card: Pick<Card, 'prompt' | 'answer' | 'accept'>): string {
  return shortHash(JSON.stringify([card.prompt, card.answer, card.accept]));
}

/**
 * Apply an answer: the log row to write and the card's new state. Pure, so
 * the write path and the tests build rows the same way.
 */
export function answerRow(
  card: Pick<Card, 'id' | 'prompt' | 'answer' | 'accept'>,
  before: CardState | null,
  answer: Answer,
  params: Params,
  ctx: RowContext,
): { row: ReviewRow; after: CardState } {
  const ts = reviewTime(ctx.now, before?.lastReview);
  const row: ReviewRow = {
    ...base(card.id, ts, ctx),
    kind: 'review',
    ...answer,
    before,
    paramsId: params.id,
    cardHash: cardHash(card),
    undoes: null,
    action: null,
    note: null,
  };
  return { row, after: review(params, before, answer.rating, ts, row.shiftMin) };
}

/** The row that undoes a review. Its time is the clock's, unclamped. */
export function undoRow(target: ReviewRow, ctx: RowContext): UndoRow {
  return {
    ...base(target.cardId, ctx.now, ctx),
    kind: 'undo',
    ...NO_REVIEW,
    undoes: target.id,
    action: null,
    note: null,
  };
}

/** A suspend, flag or forget row. */
export function manualRow(cardId: string, action: ManualAction, note: string | null, ctx: RowContext): ManualRow {
  return {
    ...base(cardId, ctx.now, ctx),
    kind: 'manual',
    ...NO_REVIEW,
    undoes: null,
    action,
    note: action === 'flag' ? note : null,
  };
}

/** The ids of review rows that some undo row undoes. */
export function undoneIds(rows: Iterable<LogRow>): Set<string> {
  const ids = new Set<string>();
  for (const r of rows) if (r.kind === 'undo') ids.add(r.undoes);
  return ids;
}

/** Log order: by time, ties broken by id so every device sorts the same way. */
export function byLogOrder(a: LogRow, b: LogRow): number {
  return a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Rebuild every card's state from the log. Each review is run through the
 * scheduler with the config and shift logged with it, so the result is
 * exactly what was computed at the time. Undone reviews are skipped, and
 * `forget` returns a card to new. Suspend and flag rows don't change the
 * scheduler state. Cards that are new at the end are absent from the result.
 */
export function replay(rows: Iterable<LogRow>, params: ReadonlyMap<string, Params>): Map<string, CardState> {
  const all = [...rows].sort(byLogOrder);
  const undone = undoneIds(all);
  const states = new Map<string, CardState>();
  for (const r of all) {
    if (r.kind === 'review') {
      if (undone.has(r.id)) continue;
      const p = params.get(r.paramsId);
      if (!p) throw new Error(`log row ${r.id} uses scheduler config ${r.paramsId}, which is missing`);
      states.set(r.cardId, review(p, states.get(r.cardId) ?? null, r.rating, r.ts, r.shiftMin));
    } else if (r.kind === 'manual' && r.action === 'forget') {
      states.delete(r.cardId);
    }
  }
  return states;
}

/**
 * One study day's totals. `reviews` counts cards last seen on an earlier day,
 * which is what the daily cap limits; `steps` counts same-day repeats
 * (learning steps, a failed card coming back), which it doesn't.
 */
export interface DailyRow {
  day: string;
  reviews: number;
  newCards: number;
  steps: number;
  totalMs: number;
}

export type DailyCounts = Omit<DailyRow, 'day'>;

/** What one review adds to its day's totals. */
export function dailyDelta(row: ReviewRow): DailyCounts {
  const kind =
    row.before === null ? 'newCards'
    : elapsedDays(row.before.lastReview, row.ts, row.shiftMin) >= 1 ? 'reviews'
    : 'steps';
  return { reviews: 0, newCards: 0, steps: 0, [kind]: 1, totalMs: row.totalMs };
}

export function emptyDaily(day: string): DailyRow {
  return { day, reviews: 0, newCards: 0, steps: 0, totalMs: 0 };
}

/** Add a delta to a day's row, or subtract it (sign -1) when a review is undone. */
export function applyDelta(day: DailyRow, delta: DailyCounts, sign: 1 | -1 = 1): DailyRow {
  return {
    day: day.day,
    reviews: day.reviews + sign * delta.reviews,
    newCards: day.newCards + sign * delta.newCards,
    steps: day.steps + sign * delta.steps,
    totalMs: day.totalMs + sign * delta.totalMs,
  };
}

/** The `daily` store rebuilt from the log, undone reviews left out. */
export function buildDaily(rows: Iterable<LogRow>): DailyRow[] {
  const all = [...rows];
  const undone = undoneIds(all);
  const days = new Map<string, DailyRow>();
  for (const r of all) {
    if (r.kind !== 'review' || undone.has(r.id)) continue;
    days.set(r.studyDay, applyDelta(days.get(r.studyDay) ?? emptyDaily(r.studyDay), dailyDelta(r)));
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

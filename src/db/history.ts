// Writing answers and undoing them (SPEC.md, The review log row, and Undo).
// Each one changes the log, the card's cached state and the day's totals in a
// single transaction, so they can never disagree, and only then tells the bus.

import {
  applyDelta,
  byLogOrder,
  dailyDelta,
  emptyDaily,
  undoneIds,
  undoRow,
  type ReviewRow,
  type RowContext,
} from '../log.ts';
import type { CardState, Params } from '../scheduler.ts';
import type { Db } from './db.ts';

export function getState(db: Db, cardId: string): Promise<CardState | undefined> {
  return db.read((conn) => conn.get('cardState', cardId));
}

/**
 * Save an answer built by answerRow: the row, the card's new state, the day's
 * totals and the config it used. Safe to retry: if the row is already in the
 * log, an earlier attempt committed and nothing more is written.
 */
export async function recordReview(db: Db, row: ReviewRow, after: CardState, params: Params): Promise<void> {
  if (row.paramsId !== params.id) throw new Error(`row ${row.id} names config ${row.paramsId}, not ${params.id}`);
  await db.write(async (conn) => {
    const tx = conn.transaction(['reviewLog', 'cardState', 'params', 'daily'], 'readwrite');
    const log = tx.objectStore('reviewLog');
    const daily = tx.objectStore('daily');
    if ((await log.getKey(row.id)) === undefined) {
      const day = (await daily.get(row.studyDay)) ?? emptyDaily(row.studyDay);
      await Promise.all([
        log.add(row),
        tx.objectStore('cardState').put(after, row.cardId),
        // Content-addressed, so writing it again changes nothing.
        tx.objectStore('params').put(params),
        daily.put(applyDelta(day, dailyDelta(row))),
      ]);
    }
    await tx.done;
  });
  db.bus.emit('review:answered', {
    cardId: row.cardId,
    logId: row.id,
    outcome: row.outcome,
    suggested: row.suggested,
    rating: row.rating,
  });
}

/**
 * Undo the session's most recent answer that isn't undone yet: restore the
 * card's state from the row's `before` snapshot (or make it new again),
 * append an undo row, and take the answer off its day's totals. Repeating it
 * walks back through the session. Returns the undone row, so the caller can
 * put its card back at the front of the queue, or null when the session has
 * nothing left to undo.
 *
 * `sessionDay` is the session's study day. A session never crosses a
 * rollover, so its rows are all filed under that day.
 */
export async function recordUndo(
  db: Db,
  sessionId: string,
  sessionDay: string,
  ctx: Omit<RowContext, 'sessionId'>,
): Promise<ReviewRow | null> {
  // Fixed before the first attempt, so a retry can tell whether that attempt
  // committed; otherwise a retry would undo a second answer.
  const undoId = ctx.id ?? crypto.randomUUID();
  const result = await db.write(async (conn): Promise<{ undone: ReviewRow | null } | { stale: string }> => {
    const tx = conn.transaction(['reviewLog', 'cardState', 'daily'], 'readwrite');
    const log = tx.objectStore('reviewLog');
    const done = await log.get(undoId);
    if (done?.kind === 'undo') {
      const prior = await log.get(done.undoes);
      await tx.done;
      return { undone: prior?.kind === 'review' ? prior : null };
    }
    const dayRows = await log.index('byDay').getAll(sessionDay);
    const already = undoneIds(dayRows);
    const target = dayRows
      .filter((r): r is ReviewRow => r.kind === 'review' && r.sessionId === sessionId && !already.has(r.id))
      .sort(byLogOrder)
      .at(-1);
    if (!target) {
      await tx.done;
      return { undone: null };
    }
    // Restoring `before` is only right if the card still holds this answer's
    // result. Within one session it always does; if it doesn't, something
    // else wrote to the card, and the log should be replayed instead.
    const states = tx.objectStore('cardState');
    const current = await states.get(target.cardId);
    if (current?.lastReview !== target.ts) {
      await tx.done;
      return { stale: target.cardId };
    }
    const daily = tx.objectStore('daily');
    const day = (await daily.get(target.studyDay)) ?? emptyDaily(target.studyDay);
    await Promise.all([
      target.before ? states.put(target.before, target.cardId) : states.delete(target.cardId),
      log.add(undoRow(target, { ...ctx, sessionId, id: undoId })),
      daily.put(applyDelta(day, dailyDelta(target), -1)),
    ]);
    await tx.done;
    return { undone: target };
  });
  // Not a failed write, so it is thrown here rather than retried as one.
  if ('stale' in result) {
    throw new Error(`card ${result.stale} has changed since the answer being undone; rebuild the schedule`);
  }
  const { undone } = result;
  if (undone) db.bus.emit('review:undone', { cardId: undone.cardId, logId: undone.id });
  return undone;
}

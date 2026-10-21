// Building today's session (SPEC.md, Building today's session). M1a has
// steps 1, 3, 4 and 6: reviews due in due order, the daily cap, new cards at
// a fixed allowance, and learn-ahead. Ordering by retrievability (step 2),
// the time-budget limiter and the spacing rule (step 5) come in M2.
//
// The work is split in two. buildQueue fixes the session's plan once, at the
// start: which reviews and which new cards, in what order. A Session then
// picks each next card from that plan as answers come in, because learning
// cards come due during the session (a failed card returns in 10 minutes)
// and have to be slotted in by their exact due times.

import type { Card } from './cards/types.ts';
import { localZone, nextRollover, shiftMin, studyDay, type Zone } from './day.ts';
import type { DailyCounts } from './log.ts';
import { elapsedDays, type CardState } from './scheduler.ts';
import type { Settings } from './settings.ts';

/** At most this many reviews of cards last seen on an earlier day, per study day. */
export const REVIEW_CAP = 120;
/** One new card after every this many reviews. */
export const NEW_EVERY = 4;

/** Lessons unlocked so far, by language code: `{ la: 3 }`. */
export type Unlocked = Record<string, number>;

/**
 * The lesson Home offers to unlock: the lowest deployed lesson above the one
 * unlocked so far, or null when every deployed lesson is unlocked. Lesson
 * numbers can skip, so it is looked up rather than added to.
 */
export function lessonToUnlock(cards: readonly Card[], unlocked: Unlocked, language: string): number | null {
  const through = unlocked[language] ?? 0;
  let next: number | null = null;
  for (const c of cards) {
    if (c.language === language && c.lesson > through && (next === null || c.lesson < next)) next = c.lesson;
  }
  return next;
}

/**
 * Whether a card can be shown at all. Retired cards keep their history but
 * leave every queue. Parse cards and `~r` cards wait for M2 (grid answers,
 * the sibling rule), and until then never get review state.
 */
export function inSessions(card: Card): boolean {
  return !card.retired && card.type !== 'parse' && !card.reverse;
}

/** A card the plan expects to show, and the due time it had when planned (null if new). */
export interface PlanEntry {
  id: string;
  due: number | null;
}

export interface Plan {
  studyDay: string;
  /** Reviews and new cards in the order the session shows them. */
  entries: PlanEntry[];
  reviews: number;
  newCards: number;
  /** Learning cards due before the rollover. They aren't in `entries`: the session shows them by due time. */
  learningDue: number;
  /** Reviews due today that the cap held back; they stay due and come tomorrow. */
  overCap: number;
}

export interface QueueInput {
  /** Every loaded card, in introduction order (loadCards). */
  cards: readonly Card[];
  states: ReadonlyMap<string, CardState>;
  /** Today's totals from the `daily` store, so the cap and allowance count what is already done. */
  today: DailyCounts;
  unlocked: Unlocked;
  settings: Settings;
  now: number;
  zone?: Zone;
}

const isLearning = (s: CardState) => s.phase !== 'review';

/**
 * Plan a session. Pure, so it is tested on an injected clock. Today's totals
 * come from the `daily` store rather than the log, so building the plan never
 * reads the whole history.
 */
export function buildQueue(input: QueueInput): Plan {
  const { cards, states, today, unlocked, settings, now } = input;
  const zone = input.zone ?? localZone;
  const end = nextRollover(now, settings.rolloverHour, zone);
  const shift = shiftMin(now, settings.rolloverHour, zone);

  const reviews: { card: Card; state: CardState }[] = [];
  const fresh: Card[] = [];
  let learningDue = 0;
  let learningFromEarlierDays = 0;
  for (const card of cards) {
    if (!inSessions(card)) continue;
    const state = states.get(card.id);
    if (!state) {
      if (card.lesson <= (unlocked[card.language] ?? 0)) fresh.push(card);
    } else if (state.due < end) {
      if (!isLearning(state)) reviews.push({ card, state });
      else {
        learningDue++;
        // A learning card last seen yesterday counts as a review when it is
        // answered (log.ts dailyDelta), so it takes a place under the cap.
        // It is never held back, though: a card mid-step can't wait a day.
        if (elapsedDays(state.lastReview, now, shift) >= 1) learningFromEarlierDays++;
      }
    }
  }

  // Step 1: due order. Ties (common, since review cards fall due at the same
  // shifted midnight) go in introduction order until step 2 shuffles them.
  reviews.sort((a, b) => a.state.due - b.state.due || a.card.seq - b.card.seq);
  // Step 3: the cap. What it holds back stays due and comes first tomorrow.
  const room = Math.max(0, REVIEW_CAP - today.reviews - learningFromEarlierDays);
  const kept = reviews.slice(0, room);
  // Step 4: new cards, at a fixed allowance until the limiter arrives (M2).
  const allowance = Math.max(0, settings.maxNew - today.newCards);
  const added = fresh.slice(0, allowance);

  // One new card after every NEW_EVERY reviews, so a heavy review day still
  // introduces some. New cards left over when the reviews run out follow.
  const entries: PlanEntry[] = [];
  let r = 0;
  let n = 0;
  while (r < kept.length || n < added.length) {
    for (let i = 0; i < NEW_EVERY && r < kept.length; i++, r++) {
      const { card, state } = kept[r]!;
      entries.push({ id: card.id, due: state.due });
    }
    if (n < added.length) entries.push({ id: added[n++]!.id, due: null });
  }

  return {
    studyDay: studyDay(now, settings.rolloverHour, zone),
    entries,
    reviews: kept.length,
    newCards: added.length,
    learningDue,
    overCap: reviews.length - kept.length,
  };
}

/**
 * One session: the plan, worked through as answers come in. It keeps no
 * state of its own beyond what is left to show; card states are always read
 * fresh from the caller, which reads them from the database.
 */
export class Session {
  readonly plan: Plan;
  #pending: PlanEntry[];
  /** Undone cards, shown before anything else, most recently undone first. */
  #front: string[] = [];
  #cards: ReadonlyMap<string, Card>;
  #learnAheadMs: number;

  constructor(plan: Plan, cards: readonly Card[], settings: Settings) {
    this.plan = plan;
    this.#pending = [...plan.entries];
    this.#cards = new Map(cards.filter(inSessions).map((c) => [c.id, c]));
    this.#learnAheadMs = settings.learnAheadMin * 60_000;
  }

  /**
   * The id of the card to show next, or null when the session is over. In
   * order: a card just undone; a learning card whose step is due; the next
   * card in the plan; and, when nothing else is left, a learning card due
   * within the learn-ahead window (step 6), earliest first.
   */
  next(states: ReadonlyMap<string, CardState>, now: number): string | null {
    if (this.#front.length) return this.#front[0]!;
    const learning = this.#learningByDue(states);
    if (learning[0] && learning[0].due <= now) return learning[0].id;
    // A planned card whose state has changed since the plan was made was
    // answered some other way (another tab, or it is now mid-step and shown
    // by due time above), so it is dropped rather than shown twice.
    while (this.#pending.length) {
      const e = this.#pending[0]!;
      if ((states.get(e.id)?.due ?? null) === e.due) return e.id;
      this.#pending.shift();
    }
    if (learning[0] && learning[0].due <= now + this.#learnAheadMs) return learning[0].id;
    return null;
  }

  /** Call once an answer to `id` is saved. */
  answered(id: string): void {
    this.#front = this.#front.filter((f) => f !== id);
    this.#pending = this.#pending.filter((e) => e.id !== id);
  }

  /** Call once an undo of `id` is saved: the card goes back to the front (SPEC.md, Undo). */
  undone(id: string): void {
    this.#front = [id, ...this.#front.filter((f) => f !== id)];
  }

  /** Planned cards not yet shown, for "cards left". Learning steps come on top of these. */
  get remaining(): number {
    return this.#front.length + this.#pending.length;
  }

  #learningByDue(states: ReadonlyMap<string, CardState>): { id: string; due: number }[] {
    const out: { id: string; due: number }[] = [];
    for (const [id, s] of states) {
      if (isLearning(s) && this.#cards.has(id)) out.push({ id, due: s.due });
    }
    return out.sort((a, b) => a.due - b.due || (a.id < b.id ? -1 : 1));
  }
}

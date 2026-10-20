// The scheduler wrapper (SPEC.md, The scheduler). The only module that
// imports ts-fsrs: it holds the pinned config, converts between ts-fsrs cards
// and Corvus's own card state, and applies the study-day shift.

import {
  createEmptyCard,
  dateDiffInDays,
  default_w,
  fsrs,
  State,
  type Card as FsrsCard,
  type FSRS,
  type FSRSParameters,
  type Grade,
} from 'ts-fsrs';
import { shortHash } from './hash.ts';

export const LIB = 'ts-fsrs@5.4.2';
export const MODEL = 'FSRS-6';
export const RETENTION_RANGE = { min: 0.8, max: 0.95 } as const;

const MIN_MS = 60_000;

type Step = `${number}${'m' | 'h' | 'd'}`;

/** One scheduler config, as stored in the `params` store. */
export interface Params {
  /** Derived from the other fields, so an identical config has the same id everywhere. */
  id: string;
  lib: string;
  model: string;
  w: number[];
  retention: number;
  fuzz: boolean;
  shortTerm: boolean;
  learningSteps: Step[];
  relearningSteps: Step[];
  maxInterval: number;
}

/**
 * The full config, written out rather than left to library defaults (5.4.2
 * defaults fuzz to off, for one). Only the weights (M3) and the desired
 * retention (Settings) can change.
 */
export function makeParams(choice: { w?: readonly number[]; retention?: number } = {}): Params {
  const retention = choice.retention ?? 0.9;
  if (!(retention >= RETENTION_RANGE.min && retention <= RETENTION_RANGE.max)) {
    throw new RangeError(`desired retention ${retention} is outside ${RETENTION_RANGE.min}-${RETENTION_RANGE.max}`);
  }
  const body = {
    lib: LIB,
    model: MODEL,
    w: [...(choice.w ?? default_w)],
    retention,
    fuzz: true,
    shortTerm: true,
    learningSteps: ['10m'] as Step[],
    relearningSteps: ['10m'] as Step[],
    maxInterval: 36500,
  };
  return { id: 'p-' + shortHash(JSON.stringify(body)), ...body };
}

export const DEFAULT_PARAMS = makeParams();

/** The ts-fsrs parameters for a config. */
export function fsrsParameters(p: Params): FSRSParameters {
  return {
    w: p.w,
    request_retention: p.retention,
    maximum_interval: p.maxInterval,
    enable_fuzz: p.fuzz,
    enable_short_term: p.shortTerm,
    learning_steps: p.learningSteps,
    relearning_steps: p.relearningSteps,
  };
}

const instances = new Map<string, FSRS>();
function fsrsFor(p: Params): FSRS {
  let f = instances.get(p.id);
  if (!f) {
    f = fsrs(fsrsParameters(p));
    instances.set(p.id, f);
  }
  return f;
}

/** 1 Again, 2 Hard, 3 Good, 4 Easy. */
export type Rating = 1 | 2 | 3 | 4;

/** A card with no state is new; once reviewed, it is in one of these. */
export type Phase = 'learning' | 'review' | 'relearning';

/** The scheduler's state for one card, in real time (epoch ms). */
export interface CardState {
  phase: Phase;
  due: number;
  lastReview: number;
  stability: number;
  difficulty: number;
  scheduledDays: number;
  /** Which (re)learning step the card is on. */
  learningSteps: number;
  reps: number;
  lapses: number;
}

const TO_STATE: Record<Phase, State> = {
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};
const TO_PHASE: Partial<Record<State, Phase>> = {
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning',
};

/*
 * The shift. ts-fsrs counts elapsed days by UTC calendar date, so a review at
 * 21:00 in New York and another at 08:00 the next morning (both on the same
 * UTC date) would count as 0 days apart. Shifting every date by `shiftMin`
 * (day.ts) makes the UTC date the study day, so ts-fsrs counts study days.
 * Results are shifted back, so stored state is always real time.
 *
 * One shift, the one logged with the review, is applied to every date in the
 * call, which is what lets replay reproduce it exactly. The cost: when a DST
 * change falls between two reviews, a last review made in the hour before the
 * rollover (spring) counts one day fewer, and one made in the hour after it
 * (fall) one day more, than the study days say.
 */

function toFsrs(s: CardState, shiftMs: number): FsrsCard {
  return {
    due: new Date(s.due + shiftMs),
    last_review: new Date(s.lastReview + shiftMs),
    stability: s.stability,
    difficulty: s.difficulty,
    // Deprecated in ts-fsrs and recomputed from last_review on every call.
    elapsed_days: 0,
    scheduled_days: s.scheduledDays,
    learning_steps: s.learningSteps,
    reps: s.reps,
    lapses: s.lapses,
    state: TO_STATE[s.phase],
  };
}

function fromFsrs(c: FsrsCard, shiftMs: number): CardState {
  const phase = TO_PHASE[c.state];
  if (!phase || !c.last_review) throw new Error(`ts-fsrs returned an unreviewed card (state ${c.state})`);
  return {
    phase,
    due: c.due.getTime() - shiftMs,
    lastReview: c.last_review.getTime() - shiftMs,
    stability: c.stability,
    difficulty: c.difficulty,
    scheduledDays: c.scheduled_days,
    learningSteps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
  };
}

/**
 * Apply one rating. `before` is null for a new card. `ts` is the review time
 * already clamped (day.ts reviewTime), and `shiftMin` the shift for it; both
 * are logged, and replay passes the logged values back in. The result depends
 * only on the arguments: the fuzz is seeded from the (shifted) review time
 * and the card's state, so a replay gives the same intervals.
 */
export function review(params: Params, before: CardState | null, rating: Rating, ts: number, shiftMin: number): CardState {
  const shiftMs = shiftMin * MIN_MS;
  const now = new Date(ts + shiftMs);
  const card = before ? toFsrs(before, shiftMs) : createEmptyCard(now);
  return fromFsrs(fsrsFor(params).next(card, now, rating as Grade).card, shiftMs);
}

/** Study days between a card's last review and `ts`, as ts-fsrs counts them under this shift. */
export function elapsedDays(lastReview: number, ts: number, shiftMin: number): number {
  const shiftMs = shiftMin * MIN_MS;
  return dateDiffInDays(new Date(lastReview + shiftMs), new Date(ts + shiftMs));
}

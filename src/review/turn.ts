// One card being answered: from the prompt appearing to the rating. It
// grades a typed answer, records whether the hint was used, and times the
// answer, pausing while the app is hidden (SPEC.md, Input and display).
// No DOM and no database, so it is tested directly.

import type { Card } from '../cards/types.ts';
import { checkTyped, type CheckOptions, type Suggestion, type Verdict } from '../check/answer.ts';
import type { Answer, Outcome } from '../log.ts';
import type { Rating } from '../scheduler.ts';

/** Elapsed time that stops counting while paused. */
export class Stopwatch {
  #start: number;
  #pausedAt: number | null = null;
  #pausedMs = 0;

  constructor(now: number) {
    this.#start = now;
  }

  pause(now: number): void {
    this.#pausedAt ??= now;
  }

  resume(now: number): void {
    if (this.#pausedAt === null) return;
    this.#pausedMs += Math.max(0, now - this.#pausedAt);
    this.#pausedAt = null;
  }

  elapsed(now: number): number {
    const end = this.#pausedAt ?? now;
    return Math.max(0, Math.round(end - this.#start - this.#pausedMs));
  }
}

export const RATING: Record<Suggestion, Rating> = { again: 1, hard: 2, good: 3 };

export class Turn {
  readonly card: Card;
  readonly watch: Stopwatch;
  hintShown = false;
  /** Set once the card is answered (submitted or revealed). */
  answerMs: number | null = null;
  outcome: Outcome | null = null;
  suggested: Rating | null = null;
  response: string | null = null;
  verdict: Verdict | null = null;

  constructor(card: Card, now: number) {
    this.card = card;
    this.watch = new Stopwatch(now);
  }

  get answered(): boolean {
    return this.answerMs !== null;
  }

  showHint(): void {
    if (!this.answered) this.hintShown = true;
  }

  /** Grade a typed answer. An empty one is a wrong answer: "I don't know". */
  submit(typed: string, opts: Omit<CheckOptions, 'hintUsed'>, now: number): Verdict {
    if (this.answered) throw new Error(`${this.card.id} is already answered`);
    const verdict = checkTyped(this.card, typed, { ...opts, hintUsed: this.hintShown });
    this.answerMs = this.watch.elapsed(now);
    this.verdict = verdict;
    this.outcome = verdict.kind;
    this.suggested = RATING[verdict.suggest];
    this.response = typed;
    return verdict;
  }

  /** Show the answer of a self-graded card. There is no suggestion to make. */
  reveal(now: number): void {
    if (this.answered) throw new Error(`${this.card.id} is already answered`);
    this.answerMs = this.watch.elapsed(now);
    this.outcome = 'revealed';
  }

  /** The finished answer, for the log row. */
  answer(rating: Rating, now: number): Answer {
    if (this.answerMs === null || this.outcome === null) throw new Error(`${this.card.id} is not answered yet`);
    return {
      rating,
      suggested: this.suggested,
      mode: this.card.mode,
      response: this.response,
      outcome: this.outcome,
      hintShown: this.hintShown,
      answerMs: this.answerMs,
      totalMs: this.watch.elapsed(now),
    };
  }
}

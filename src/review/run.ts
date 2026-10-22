// One review session against the database: the plan, the card being
// answered, saving each rating, and undo. No DOM, so it is tested with
// fake-indexeddb; src/ui/review.ts draws it.
//
// A rating updates the session in memory at once and saves in the
// background. The screen needs that: iPadOS shows the keyboard only when the
// next card's input is focused inside the tap itself (SPEC.md, Input and
// display), so the next card can't wait for the write. Saves run one after
// another, in the order given, and undo waits for them.

import type { Card } from '../cards/types.ts';
import { localZone, shiftMin, studyDay, type Zone } from '../day.ts';
import type { Db } from '../db/db.ts';
import { recordReview, recordUndo } from '../db/history.ts';
import { loadHomeData } from '../home.ts';
import { answerRow, dailyDelta, type ReviewRow } from '../log.ts';
import { buildQueue, Session } from '../queue.ts';
import { DEFAULT_PARAMS, type CardState, type Params, type Rating } from '../scheduler.ts';
import type { Settings } from '../settings.ts';
import { previewIntervals } from './intervals.ts';
import { Turn } from './turn.ts';

/** The scheduler config. Custom weights and retention come with Settings in M2/M3. */
export const PARAMS: Params = DEFAULT_PARAMS;

export interface RunContext {
  db: Db;
  /** This language's cards, in introduction order. */
  cards: readonly Card[];
  buildId: string;
  zone?: Zone;
  now(): number;
}

export class ReviewRun {
  readonly sessionId: string = crypto.randomUUID();
  current: Turn | null = null;

  #ctx: RunContext;
  #zone: Zone;
  #byId: Map<string, Card>;
  // Set by #load, which open() runs before the run is handed out.
  #settings!: Settings;
  #studyDay!: string;
  #states!: Map<string, CardState>;
  #session!: Session;
  /** Today's total answer time in the database when the session was (re)loaded. */
  #todayMsAtLoad = 0;
  #msSinceLoad = 0;
  /** This session's answers not undone, oldest first. */
  #answers: ReviewRow[] = [];
  #writes: Promise<void> = Promise.resolve();
  #writeFailed = false;
  #completed = false;

  private constructor(ctx: RunContext) {
    this.#ctx = ctx;
    this.#zone = ctx.zone ?? localZone;
    this.#byId = new Map(ctx.cards.map((c) => [c.id, c]));
  }

  static async open(ctx: RunContext): Promise<ReviewRun> {
    const run = new ReviewRun(ctx);
    await run.#load();
    return run;
  }

  /** Plan the session from what the database holds now. */
  async #load(): Promise<void> {
    const now = this.#ctx.now();
    const data = await loadHomeData(this.#ctx.db, now, this.#zone);
    const plan = buildQueue({ ...data, cards: this.#ctx.cards, now, zone: this.#zone });
    this.#settings = data.settings;
    this.#studyDay = plan.studyDay;
    this.#states = data.states;
    this.#session = new Session(plan, this.#ctx.cards, data.settings);
    this.#todayMsAtLoad = data.today.totalMs;
    this.#msSinceLoad = 0;
    this.current = null;
  }

  /**
   * Rebuild the plan from the database, after a write found the card
   * changed elsewhere (another tab, say). Pending saves finish first.
   */
  async reload(): Promise<void> {
    await this.#writes;
    this.#writeFailed = false;
    await this.#load();
  }

  get studyDay(): string {
    return this.#studyDay;
  }

  get settings(): Settings {
    return this.#settings;
  }

  /** The study day has rolled over since the session began; it should end (SPEC.md, Days and the clock). */
  isStale(): boolean {
    return studyDay(this.#ctx.now(), this.#settings.rolloverHour, this.#zone) !== this.#studyDay;
  }

  /** Show the next card, or null when the session is over. */
  next(): Turn | null {
    const now = this.#ctx.now();
    const id = this.#session.next(this.#states, now);
    this.current = id ? new Turn(this.#byId.get(id)!, now) : null;
    if (!this.current) this.#complete();
    return this.current;
  }

  /**
   * Rate the current card. The session moves on at once; the returned
   * promise settles when the answer is saved. On CardChangedError, call
   * reload(); on NotSavedError, the screen blocks and asks for a reload.
   */
  rate(rating: Rating): Promise<void> {
    const turn = this.current;
    if (!turn?.answered) throw new Error('no answered card to rate');
    const now = this.#ctx.now();
    const card = turn.card;
    const before = this.#states.get(card.id) ?? null;
    const { row, after } = answerRow(card, before, turn.answer(rating, now), PARAMS, {
      now,
      rolloverHour: this.#settings.rolloverHour,
      zone: this.#zone,
      sessionId: this.sessionId,
      buildId: this.#ctx.buildId,
    });
    this.#states.set(card.id, after);
    this.#session.answered(card.id);
    this.#answers.push(row);
    this.#msSinceLoad += row.totalMs;
    this.current = null;
    return this.#queue(() => recordReview(this.#ctx.db, row, after, PARAMS));
  }

  get canUndo(): boolean {
    return this.#answers.length > 0;
  }

  /**
   * Undo the session's latest answer (SPEC.md, Undo). The card goes back to
   * the front; call next() to show it. Returns the card, or null if the
   * session had nothing left to undo.
   */
  async undo(): Promise<Card | null> {
    const undone = await this.#queue(() =>
      recordUndo(this.#ctx.db, this.sessionId, this.#studyDay, {
        now: this.#ctx.now(),
        rolloverHour: this.#settings.rolloverHour,
        zone: this.#zone,
        buildId: this.#ctx.buildId,
      }),
    );
    if (!undone) return null;
    if (undone.before) this.#states.set(undone.cardId, undone.before);
    else this.#states.delete(undone.cardId);
    this.#answers = this.#answers.filter((r) => r.id !== undone.id);
    this.#msSinceLoad -= undone.totalMs;
    this.#session.undone(undone.cardId);
    this.#completed = false;
    this.current = null;
    return this.#byId.get(undone.cardId) ?? null;
  }

  /** Leave the current card out for this session: it threw while shown or checked. Nothing is logged. */
  skip(): void {
    if (this.current) this.#session.skip(this.current.card.id);
    this.current = null;
  }

  /** The next interval each rating would give the current card, in ms. */
  previews(): Record<Rating, number> | null {
    if (!this.current) return null;
    const now = this.#ctx.now();
    const before = this.#states.get(this.current.card.id) ?? null;
    return previewIntervals(PARAMS, before, now, shiftMin(now, this.#settings.rolloverHour, this.#zone));
  }

  /** Planned cards not yet shown. Learning steps come on top of these. */
  get remaining(): number {
    return this.#session.remaining;
  }

  /** Answer time today, this session included, against the daily goal. */
  get usedMs(): number {
    return this.#todayMsAtLoad + this.#msSinceLoad;
  }

  get goalMs(): number {
    return this.#settings.goalMin * 60_000;
  }

  get answeredCount(): number {
    return this.#answers.length;
  }

  /** Wait for every save so far. Rejects if one failed. */
  async saved(): Promise<void> {
    await this.#writes;
    if (this.#writeFailed) throw new Error('an answer in this session was not saved');
  }

  #queue<T>(write: () => Promise<T>): Promise<T> {
    // Tracked from now, not from when it starts, so a reload waits for it.
    const result = this.#ctx.db.track(this.#writes.then(write));
    this.#writes = result.then(
      () => {},
      () => {
        this.#writeFailed = true;
      },
    );
    return result;
  }

  /** Tell the bus the session is done, once its saves have committed. */
  #complete(): void {
    if (this.#completed || !this.#answers.length) return;
    this.#completed = true;
    const answers = [...this.#answers];
    void this.#writes.then(() => {
      if (this.#writeFailed) return;
      let reviews = 0;
      let newCards = 0;
      let ms = 0;
      for (const row of answers) {
        const d = dailyDelta(row);
        reviews += d.reviews + d.steps;
        newCards += d.newCards;
        ms += d.totalMs;
      }
      this.#ctx.db.bus.emit('session:completed', { studyDay: this.#studyDay, reviews, newCards, ms });
    });
  }
}

// The event bus for the game layer (SPEC.md, Game hooks). Writers emit only
// after their IndexedDB transaction commits, so a listener never hears about
// an answer that wasn't saved. Listeners can only listen: a throwing one is
// logged and the rest still run.

import type { Outcome } from './log.ts';
import type { Rating } from './scheduler.ts';

export interface Events {
  'review:answered': { cardId: string; logId: string; outcome: Outcome; suggested: Rating | null; rating: Rating };
  /** `logId` is the undone answer's row, the one `review:answered` named. */
  'review:undone': { cardId: string; logId: string };
  'session:completed': { studyDay: string; reviews: number; newCards: number; ms: number };
  'lesson:unlocked': { language: string; lesson: number };
}

type Listener<K extends keyof Events> = (payload: Events[K]) => void;

export class Bus {
  #listeners = new Map<keyof Events, Set<Listener<never>>>();
  #onError: (error: unknown) => void;

  constructor(onError: (error: unknown) => void = (e) => console.error('event listener failed:', e)) {
    this.#onError = onError;
  }

  /** Listen for an event; returns the function that stops listening. */
  on<K extends keyof Events>(name: K, listener: Listener<K>): () => void {
    let set = this.#listeners.get(name);
    if (!set) this.#listeners.set(name, (set = new Set()));
    set.add(listener as Listener<never>);
    return () => set.delete(listener as Listener<never>);
  }

  emit<K extends keyof Events>(name: K, payload: Events[K]): void {
    for (const listener of this.#listeners.get(name) ?? []) {
      try {
        (listener as Listener<K>)(payload);
      } catch (e) {
        this.#onError(e);
      }
    }
  }
}

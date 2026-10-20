// Card files as written (cards/schema.json), and the cards the app schedules.

export type CardType = 'vocab' | 'concept' | 'ending' | 'parse' | 'phrase';
export type Mode = 'typed' | 'reveal' | 'grid';

export interface ReverseSpec {
  accept?: string[];
  hint?: string;
  retired?: boolean;
}

/** One card as it appears in a lesson file. */
export interface CardJson {
  id: string;
  type: CardType;
  lemma?: string;
  prompt: string;
  answer: string | string[];
  accept?: string[];
  mode?: Mode;
  grid?: string;
  reverse?: true | ReverseSpec;
  paradigm?: string;
  cell?: string;
  strictMarks?: true;
  hint?: string;
  notes?: string;
  speak?: string;
  tags?: string[];
  retired?: boolean;
}

export interface CardFile {
  language: string;
  lesson: number;
  unit: number;
  title: string;
  cards: CardJson[];
}

/**
 * One schedulable card. A vocab card with `reverse` yields two: the forward
 * card, and a reverse card whose id is the forward id plus `~r`.
 */
export interface Card {
  /** Permanent: review history is keyed by it. */
  id: string;
  type: CardType;
  /** True for the generated `~r` card. */
  reverse: boolean;
  mode: Mode;
  language: string;
  lesson: number;
  unit: number;
  /** Position in the whole corpus: lesson order, then file order. */
  seq: number;
  lemma?: string;
  prompt: string;
  /** A string, or the list of grid cells for a parse card. */
  answer: string | string[];
  accept: string[];
  /**
   * Which language the expected answer is in, for answer checking and the
   * input's lang: 'target' (the language being learned) or 'learner'.
   * Null for parse cards, which are answered on a grid.
   */
  answerLang: 'target' | 'learner' | null;
  hint?: string;
  notes?: string;
  speak?: string;
  tags: string[];
  grid?: string;
  paradigm?: string;
  cell?: string;
  strictMarks: boolean;
  retired: boolean;
  /** The card as written; for a reverse card, the forward card. */
  source: CardJson;
}

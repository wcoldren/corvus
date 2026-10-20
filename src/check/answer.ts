import type { Card } from '../cards/types.ts';
import { expandAlternatives, fold, normalize } from './normalize.ts';

export type Suggestion = 'again' | 'hard' | 'good';

/** A form some card in the corpus holds, with where it came from. */
export interface CorpusForm {
  form: string;
  cardId: string;
  lemma?: string;
  /** The form's cell(s), where known: an ending card's cell, a parse card's answer. */
  cells: string[];
  /** The paradigm (ending cards) or grid (parse cards) the cells belong to. */
  paradigm?: string;
  grid?: string;
}

/** Corpus forms keyed by their normalized text. */
export type FormIndex = Map<string, CorpusForm[]>;

export type Verdict =
  | { kind: 'correct'; suggest: Suggestion; matched: string }
  /** Right apart from marks. `diff` indexes the code points of `matched` that differ. */
  | { kind: 'slip'; suggest: Suggestion; matched: string; diff: number[] }
  /** Typed another real form, e.g. the nominative for the ablative. */
  | { kind: 'wrongForm'; suggest: 'again'; forms: CorpusForm[] }
  /** `strict`: right apart from marks, but the card has strictMarks. */
  | { kind: 'wrong'; suggest: 'again'; strict: boolean };

export interface CheckOptions {
  /** The pack's learner.ignoreWords; used only when the answer is in the learner's language. */
  ignoreWords: readonly string[];
  forms: FormIndex;
  hintUsed?: boolean;
  /** Settings: "Count mark slips as Hard". */
  slipsAsHard?: boolean;
}

/**
 * The forms used to name a wrong form: every card's lemma, the answers and
 * accept entries of typed cards answered in the target language, and parse
 * cards' forms. Retired cards count too; their forms are still real forms.
 */
export function buildFormIndex(cards: readonly Card[]): FormIndex {
  const index: FormIndex = new Map();
  const add = (form: string, entry: Omit<CorpusForm, 'form'>) => {
    for (const f of expandAlternatives(form)) {
      const key = normalize(f);
      const list = index.get(key) ?? [];
      list.push({ form: f, ...entry });
      index.set(key, list);
    }
  };
  for (const c of cards) {
    if (c.lemma) add(c.lemma, { cardId: c.id, lemma: c.lemma, cells: [] });
    if (c.type === 'parse' && Array.isArray(c.answer)) {
      add(c.prompt, { cardId: c.id, lemma: c.lemma, cells: c.answer, grid: c.grid });
    } else if (c.mode === 'typed' && c.answerLang === 'target' && typeof c.answer === 'string') {
      const cells = c.cell ? [c.cell] : [];
      for (const a of [c.answer, ...c.accept]) {
        add(a, { cardId: c.id, lemma: c.lemma, cells, paradigm: c.paradigm });
      }
    }
  }
  return index;
}

/** Grade a typed answer. The numbered steps are SPEC.md's. */
export function checkTyped(card: Card, typed: string, opts: CheckOptions): Verdict {
  if (typeof card.answer !== 'string') throw new Error(`${card.id} is not a typed card`);
  const ignore = card.answerLang === 'learner' ? opts.ignoreWords : [];

  // 1-2. Normalize both sides; expand slash alternatives on the expected side.
  const got = normalize(typed, ignore);
  if (got === '') return { kind: 'wrong', suggest: 'again', strict: false };
  const expected = [card.answer, ...card.accept].flatMap(expandAlternatives).map((e) => normalize(e, ignore));

  // 3. Exact match.
  const exact = expected.find((e) => e === got);
  if (exact !== undefined) return { kind: 'correct', suggest: cap('good', opts), matched: exact };

  // 4. A match once marks are folded away.
  const folded = fold(got);
  const near = expected.find((e) => fold(e) === folded);
  if (near !== undefined) {
    // 4a. What was typed is itself another form in the corpus: wrong. Only
    // target-language answers are compared, since the corpus holds only
    // target-language forms. A card's own lemma counts, because the lemma is
    // a different form from the one asked for (aqua for aquā).
    const forms = card.answerLang === 'target' ? opts.forms.get(got) : undefined;
    if (forms && forms.length > 0) return { kind: 'wrongForm', suggest: 'again', forms };
    // 4b. strictMarks: the unmarked spelling is a different word.
    if (card.strictMarks) return { kind: 'wrong', suggest: 'again', strict: true };
    // 4c. A slip: right word, missing (or extra) marks.
    const suggest = cap(opts.slipsAsHard ? 'hard' : 'good', opts);
    return { kind: 'slip', suggest, matched: near, diff: markDiff(near, got) };
  }

  // 5. Wrong.
  return { kind: 'wrong', suggest: 'again', strict: false };
}

/** Using the hint caps the suggestion at Hard. */
function cap(s: Suggestion, opts: CheckOptions): Suggestion {
  return opts.hintUsed && s === 'good' ? 'hard' : s;
}

/**
 * Code point indices where expected and typed differ, for highlighting the
 * missing marks. Both are NFC and fold to the same text; when a character
 * has no precomposed form the two can differ in length, and then nothing is
 * highlighted rather than the wrong letters.
 */
function markDiff(expected: string, typed: string): number[] {
  const e = Array.from(expected);
  const t = Array.from(typed);
  if (e.length !== t.length) return [];
  return e.flatMap((ch, i) => (ch === t[i] ? [] : [i]));
}

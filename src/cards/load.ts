import type { Card, CardFile, CardJson, CardType, Mode } from './types.ts';

export const REVERSE_SUFFIX = '~r';

const DEFAULT_MODE: Record<CardType, Mode> = {
  vocab: 'reveal',
  concept: 'reveal',
  ending: 'typed',
  parse: 'grid',
  phrase: 'reveal',
};

// The language of each type's answer (SPEC.md, "Which language each field is
// in"). A reverse card's answer is the lemma, in the target language.
const ANSWER_LANG: Record<CardType, Card['answerLang']> = {
  vocab: 'learner',
  concept: 'learner',
  ending: 'target',
  parse: null,
  phrase: 'learner',
};

/**
 * Turn card files into the cards the app schedules, in introduction order:
 * by lesson, then by position in the file, each reverse card straight after
 * its forward card. Files are assumed valid (check-cards enforces that);
 * retired cards are kept, flagged, so their history still has a card.
 */
export function loadCards(files: CardFile[]): Card[] {
  const ordered = [...files].sort((a, b) => a.lesson - b.lesson);
  const cards: Card[] = [];
  for (const file of ordered) {
    for (const json of file.cards) {
      cards.push(forwardCard(file, json, cards.length));
      const rev = reverseCard(file, json, cards.length);
      if (rev) cards.push(rev);
    }
  }
  return cards;
}

/**
 * The highest lesson among `cards`, or 0 if there are none. Settings shows it
 * for this build, and version.json carries it for the update notice.
 */
export function newestLesson(cards: readonly Card[]): number {
  return Math.max(0, ...cards.map((c) => c.lesson));
}

function forwardCard(file: CardFile, c: CardJson, seq: number): Card {
  return {
    id: c.id,
    type: c.type,
    reverse: false,
    mode: c.type === 'parse' ? 'grid' : (c.mode ?? DEFAULT_MODE[c.type]),
    language: file.language,
    lesson: file.lesson,
    unit: file.unit,
    seq,
    lemma: c.lemma,
    prompt: c.prompt,
    answer: c.answer,
    accept: c.accept ?? [],
    answerLang: ANSWER_LANG[c.type],
    hint: c.hint,
    notes: c.notes,
    speak: c.speak,
    tags: c.tags ?? [],
    grid: c.grid,
    paradigm: c.paradigm,
    cell: c.cell,
    strictMarks: c.strictMarks === true,
    retired: c.retired === true,
    source: c,
  };
}

function reverseCard(file: CardFile, c: CardJson, seq: number): Card | null {
  if (c.type !== 'vocab' || !c.reverse || !c.lemma || typeof c.answer !== 'string') return null;
  const spec = c.reverse === true ? {} : c.reverse;
  return {
    id: c.id + REVERSE_SUFFIX,
    type: 'vocab',
    reverse: true,
    // Always typed: the point of a reverse card is producing the word.
    mode: 'typed',
    language: file.language,
    lesson: file.lesson,
    unit: file.unit,
    seq,
    lemma: c.lemma,
    // The prompt is the forward card's answer; feedback shows the forward
    // prompt (the full dictionary entry) from `source`.
    prompt: c.answer,
    answer: c.lemma,
    accept: spec.accept ?? [],
    answerLang: 'target',
    hint: spec.hint,
    tags: c.tags ?? [],
    strictMarks: false,
    // Retiring the forward card retires both; `reverse.retired` only this one.
    retired: c.retired === true || spec.retired === true,
    source: c,
  };
}

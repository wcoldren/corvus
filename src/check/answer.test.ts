import { describe, expect, it } from 'vitest';
import { buildFormIndex, checkTyped, type CheckOptions } from './answer.ts';
import { expandAlternatives, fold, normalize } from './normalize.ts';
import { cards, packs } from '../cards/bundle.ts';
import type { Card } from '../cards/types.ts';

const la = packs['la']!;
const opts: CheckOptions = { ignoreWords: la.learner.ignoreWords, forms: buildFormIndex(cards) };
const card = (id: string): Card => {
  const c = cards.find((x) => x.id === id);
  if (!c) throw new Error(`no card ${id} in the lessons`);
  return c;
};
const check = (id: string, typed: string, extra: Partial<CheckOptions> = {}) =>
  checkTyped(card(id), typed, { ...opts, ...extra });

describe('normalize', () => {
  it('trims, lowercases, collapses spaces and strips punctuation', () => {
    expect(normalize('  Pray   and WORK! ')).toBe('pray and work');
    expect(normalize('"To/for": usually.')).toBe('tofor usually');
  });

  it('keeps a hyphen or apostrophe inside a word, and unifies apostrophes', () => {
    expect(normalize('well-known')).toBe('well-known');
    expect(normalize('o’clock')).toBe("o'clock");
    expect(normalize("o'clock")).toBe("o'clock");
    expect(normalize('-ārum')).toBe('ārum');
  });

  it('composes to NFC, so a combining macron equals a precomposed one', () => {
    expect(normalize('āqua')).toBe(normalize('āqua'));
  });

  it('drops ignored words, but never all of them', () => {
    expect(normalize('the earth', ['the'])).toBe('earth');
    expect(normalize('to love', ['to'])).toBe('love');
    expect(normalize('the', ['the'])).toBe('the');
  });
});

describe('fold and expandAlternatives', () => {
  it('folds every mark', () => {
    expect(fold('animārum')).toBe('animarum');
    expect(fold('ā')).toBe('a');
  });

  it('expands slash alternatives slot by slot', () => {
    expect(expandAlternatives('he/she/it loves')).toEqual(['he loves', 'she loves', 'it loves']);
    expect(expandAlternatives('by/with the/a hand')).toHaveLength(4);
    expect(expandAlternatives('water')).toEqual(['water']);
    expect(expandAlternatives('he / she loves')).toEqual(['he loves', 'she loves']);
    expect(expandAlternatives('/')).toEqual([]);
  });
});

describe('checkTyped on lesson cards', () => {
  it('accepts the answer, an alternative and an accept entry (meanings)', () => {
    expect(check('la-01-v-amat', 'she loves')).toMatchObject({ kind: 'correct', suggest: 'good' });
    expect(check('la-01-v-amat', 'It loves.')).toMatchObject({ kind: 'correct' });
    expect(check('la-01-v-amat', 'they love')).toMatchObject({ kind: 'wrong', suggest: 'again' });
    expect(check('la-01-v-homo', 'a human being')).toMatchObject({ kind: 'correct' });
    expect(check('la-02-v-terra', 'the land')).toMatchObject({ kind: 'correct' });
  });

  it('marks an exact target-language answer correct, ignoring case and spacing', () => {
    expect(check('la-02-e-aqua-abl-sg', ' AQUĀ ')).toMatchObject({ kind: 'correct', matched: 'aquā' });
  });

  it('calls a missing macron a slip, suggests Good, and points at the letter', () => {
    const v = check('la-02-e-anima-gen-pl', 'animarum');
    expect(v).toEqual({ kind: 'slip', suggest: 'good', matched: 'animārum', diff: [4] });
    expect(check('la-02-e-anima-gen-pl', 'animarum', { slipsAsHard: true }).suggest).toBe('hard');
  });

  it('names a wrong form when the unmarked text is another real form', () => {
    // aquā (abl. sg.) typed as aqua: that is the lemma, the nominative.
    const v = check('la-02-e-aqua-abl-sg', 'aqua');
    expect(v.kind).toBe('wrongForm');
    if (v.kind === 'wrongForm') expect(v.forms.some((f) => f.form === 'aqua')).toBe(true);
  });

  it('marks a different word wrong', () => {
    expect(check('la-02-e-aqua-abl-sg', 'aquam')).toMatchObject({ kind: 'wrong', strict: false });
    expect(check('la-02-e-aqua-abl-sg', '')).toMatchObject({ kind: 'wrong' });
    expect(check('la-02-e-aqua-abl-sg', '?!')).toMatchObject({ kind: 'wrong' });
  });

  it('checks reverse cards against the lemma', () => {
    expect(check('la-02-v-gloria~r', 'glōria')).toMatchObject({ kind: 'correct' });
    expect(check('la-02-v-gloria~r', 'gloria')).toMatchObject({ kind: 'slip' });
    expect(check('la-02-v-gloria~r', 'glory')).toMatchObject({ kind: 'wrong' });
  });

  it('caps the suggestion at Hard when the hint was used, and never suggests Easy', () => {
    expect(check('la-02-e-aqua-abl-sg', 'aquā', { hintUsed: true }).suggest).toBe('hard');
    expect(check('la-02-e-anima-gen-pl', 'animarum', { hintUsed: true }).suggest).toBe('hard');
    expect(check('la-02-e-aqua-abl-sg', 'aquam', { hintUsed: true }).suggest).toBe('again');
  });
});

describe('checkTyped on made-up cards', () => {
  const base: Card = { ...card('la-02-e-aqua-abl-sg') };

  it('makes a marks-only miss wrong under strictMarks', () => {
    const c: Card = { ...base, id: 'x-strict', answer: 'vēnit', lemma: 'veniō', strictMarks: true };
    expect(checkTyped(c, 'venit', opts)).toEqual({ kind: 'wrong', suggest: 'again', strict: true });
    expect(checkTyped(c, 'vēnit', opts)).toMatchObject({ kind: 'correct' });
  });

  it('names a parse card\'s form, with its cells', () => {
    // aquae (gen. sg., dat. sg., nom. pl.) is a parse card's prompt.
    const c: Card = { ...base, id: 'x-aquae', answer: 'aquāe' };
    const v = checkTyped(c, 'aquae', opts);
    expect(v.kind).toBe('wrongForm');
    if (v.kind === 'wrongForm') {
      expect(v.forms.find((f) => f.cardId === 'la-02-x-aquae')?.cells).toEqual(['gen.sg', 'dat.sg', 'nom.pl']);
    }
  });

  it('does not look for wrong forms in a learner-language answer', () => {
    const c: Card = { ...base, id: 'x-meaning', answerLang: 'learner', answer: 'café' };
    expect(checkTyped(c, 'cafe', opts)).toMatchObject({ kind: 'slip' });
  });
});

describe('every live typed-checkable card accepts its own answers (check-cards rule 8)', () => {
  const typed = cards.filter((c) => !c.retired && typeof c.answer === 'string');
  it.each(typed.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    for (const a of [c.answer as string, ...c.accept]) {
      for (const alt of expandAlternatives(a)) {
        expect(checkTyped(c, alt, opts).kind, `${c.id}: "${alt}"`).toBe('correct');
      }
    }
  });
});

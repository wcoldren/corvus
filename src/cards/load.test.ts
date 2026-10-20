import { describe, expect, it } from 'vitest';
import { loadCards } from './load.ts';
import { cards as bundled, files as bundledFiles } from './bundle.ts';
import type { CardFile, CardJson } from './types.ts';

function file(lesson: number, cards: CardJson[]): CardFile {
  return { language: 'xx', lesson, unit: 1, title: `Lesson ${lesson}`, cards };
}

const vocab = (id: string, extra: Partial<CardJson> = {}): CardJson => ({
  id,
  type: 'vocab',
  lemma: 'lemma-' + id,
  prompt: 'prompt-' + id,
  answer: 'answer-' + id,
  ...extra,
});

describe('loadCards', () => {
  it('orders by lesson, then file order, whatever order the files come in', () => {
    const cards = loadCards([file(2, [vocab('c'), vocab('d')]), file(1, [vocab('a'), vocab('b')])]);
    expect(cards.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(cards.map((c) => c.seq)).toEqual([0, 1, 2, 3]);
  });

  it('puts a reverse card straight after its forward card, running the other way', () => {
    const cards = loadCards([
      file(1, [vocab('a', { reverse: { hint: 'not x', accept: ['alt'] }, accept: ['meaning2'] }), vocab('b')]),
    ]);
    expect(cards.map((c) => c.id)).toEqual(['a', 'a~r', 'b']);
    const rev = cards[1]!;
    expect(rev).toMatchObject({
      reverse: true,
      mode: 'typed',
      prompt: 'answer-a',
      answer: 'lemma-a',
      accept: ['alt'],
      hint: 'not x',
      answerLang: 'target',
      retired: false,
    });
    // The forward card's own accept list is about meanings, not the lemma.
    expect(rev.accept).not.toContain('meaning2');
    expect(rev.source.prompt).toBe('prompt-a');
  });

  it('makes no reverse card without `reverse`', () => {
    expect(loadCards([file(1, [vocab('a')])]).map((c) => c.id)).toEqual(['a']);
  });

  it('retires both cards with the forward card, and only the reverse with reverse.retired', () => {
    const both = loadCards([file(1, [vocab('a', { reverse: true, retired: true })])]);
    expect(both.map((c) => [c.id, c.retired])).toEqual([
      ['a', true],
      ['a~r', true],
    ]);
    const revOnly = loadCards([file(1, [vocab('a', { reverse: { retired: true } })])]);
    expect(revOnly.map((c) => [c.id, c.retired])).toEqual([
      ['a', false],
      ['a~r', true],
    ]);
  });

  it('applies each type\'s default mode and answer language, and honours `mode`', () => {
    const cards = loadCards([
      file(1, [
        vocab('v'),
        { id: 'c', type: 'concept', prompt: 'q', answer: 'a' },
        { id: 'e', type: 'ending', prompt: 'q', answer: 'a' },
        { id: 'p', type: 'parse', prompt: 'q', answer: ['gen.sg'] },
        { id: 'h', type: 'phrase', prompt: 'q', answer: 'a' },
        vocab('t', { mode: 'typed' }),
      ]),
    ]);
    expect(cards.map((c) => [c.id, c.mode, c.answerLang])).toEqual([
      ['v', 'reveal', 'learner'],
      ['c', 'reveal', 'learner'],
      ['e', 'typed', 'target'],
      ['p', 'grid', null],
      ['h', 'reveal', 'learner'],
      ['t', 'typed', 'learner'],
    ]);
  });
});

describe('the bundled corpus', () => {
  it('loads every lesson file', () => {
    expect(bundledFiles.length).toBeGreaterThan(0);
    expect(bundled.length).toBeGreaterThanOrEqual(
      bundledFiles.reduce((n, f) => n + f.cards.length, 0),
    );
  });

  it('gives every card a unique id', () => {
    const ids = bundled.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('makes a reverse card for every vocab card with `reverse`', () => {
    const want = bundledFiles.flatMap((f) => f.cards.filter((c) => c.reverse).map((c) => c.id + '~r'));
    const got = bundled.filter((c) => c.reverse).map((c) => c.id);
    expect(got).toEqual(want);
  });
});

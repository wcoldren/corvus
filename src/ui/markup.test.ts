import { describe, expect, it } from 'vitest';
import { parseMarkup, type MarkupNode } from './markup.ts';
import { cards } from '../cards/bundle.ts';

const em = (...children: MarkupNode[]): MarkupNode => ({ tag: 'em', children });
const strong = (...children: MarkupNode[]): MarkupNode => ({ tag: 'strong', children });

describe('parseMarkup', () => {
  it('splits italic and bold spans', () => {
    expect(parseMarkup('the **dative** of *anima*')).toEqual(['the ', strong('dative'), ' of ', em('anima')]);
  });

  it('leaves HTML as text', () => {
    expect(parseMarkup('<b>x</b>')).toEqual(['<b>x</b>']);
    expect(parseMarkup('a < b')).toEqual(['a < b']);
  });

  it('keeps an unmatched or empty marker literal', () => {
    expect(parseMarkup('2 * 3')).toEqual(['2 * 3']);
    expect(parseMarkup('*open')).toEqual(['*open']);
    expect(parseMarkup('**open')).toEqual(['**open']);
    expect(parseMarkup('a ** b')).toEqual(['a ** b']);
    expect(parseMarkup('*a* and *')).toEqual([em('a'), ' and *']);
  });

  it('nests one inside the other', () => {
    expect(parseMarkup('**bold *it* bold**')).toEqual([strong('bold ', em('it'), ' bold')]);
    expect(parseMarkup('*it **bold** it*')).toEqual([em('it ', strong('bold'), ' it')]);
  });

  it('keeps every character of every card field it renders', () => {
    const flat = (nodes: MarkupNode[]): string =>
      nodes.map((n) => (typeof n === 'string' ? n : flat(n.children))).join('');
    for (const c of cards) {
      for (const text of [c.prompt, c.notes, c.hint, typeof c.answer === 'string' ? c.answer : undefined]) {
        if (!text) continue;
        // Markers are removed and nothing else is.
        expect(flat(parseMarkup(text)).replaceAll('*', '')).toBe(text.replaceAll('*', ''));
      }
    }
  });
});
